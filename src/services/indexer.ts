import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execa } from "execa";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Rust from "tree-sitter-rust";
import { prisma } from "../db/client.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderPullRequest, ProviderRepo } from "../providers/types.js";
import { embedText, embedTexts } from "./embeddings.js";
import { loadEnv } from "../config/env.js";
import { chunkTextForEmbedding } from "./chunking.js";

const env = loadEnv();
const MAX_INDEX_BYTES = 1_000_000;
const MAX_PARSE_CHARS = 200_000;
const CHUNK_MAX_CHARS = 1800;
const CHUNK_OVERLAP_CHARS = 220;
const CHUNK_MAX_PER_FILE = 20;

const EXTRA_TEXT_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".markdown",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".txt",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".sh",
  ".bash",
  ".zsh",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".scala",
  ".conf"
]);

const EXTRA_TEXT_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "readme",
  "readme.md",
  "license",
  "changelog",
  ".env",
  ".env.example",
  "compose.yml",
  "compose.yaml"
]);

type IndexJob = {
  provider?: "github";
  installationId?: string | null;
  repoId: number;
  headSha: string | null;
  force?: boolean;
  patternRepo?: { url: string; ref?: string; name?: string };
};

type LanguageConfig = {
  name: string;
  language: any;
};

const languageMap: Record<string, LanguageConfig> = {};

function initParsers() {
  if (Object.keys(languageMap).length > 0) return;

  languageMap[".js"] = { name: "javascript", language: JavaScript };
  languageMap[".jsx"] = { name: "javascript", language: JavaScript };
  languageMap[".ts"] = { name: "typescript", language: TypeScript.typescript };
  languageMap[".tsx"] = { name: "tsx", language: TypeScript.tsx };
  languageMap[".py"] = { name: "python", language: Python };
  languageMap[".go"] = { name: "go", language: Go };
  languageMap[".rs"] = { name: "rust", language: Rust };
}

function hashContent(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function shouldIndexAsText(params: { relativePath: string; raw: Buffer; languageKnown: boolean }): boolean {
  const { relativePath, raw, languageKnown } = params;
  if (languageKnown) return true;
  const ext = path.extname(relativePath).toLowerCase();
  const base = path.basename(relativePath).toLowerCase();
  if (EXTRA_TEXT_EXTENSIONS.has(ext)) return true;
  if (EXTRA_TEXT_BASENAMES.has(base)) return true;
  if (relativePath.toLowerCase().endsWith(".d.ts")) return true;

  const sample = raw.subarray(0, Math.min(raw.length, 4096));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printable += 1;
    }
  }
  return printable / sample.length >= 0.92;
}

function inferredLanguageName(relativePath: string, knownLanguage?: string): string {
  if (knownLanguage) return knownLanguage;
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) return "text";
  return ext.replace(/^\./, "") || "text";
}


async function walk(dir: string, ignoreDirs: Set<string>, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), ignoreDirs, files);
    } else if (entry.isFile()) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function extractSymbols(language: string, tree: Parser.Tree, content: string) {
  const symbols: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    signature?: string;
    doc?: string;
  }> = [];
  const references: Array<{ name: string; line: number; kind: string }> = [];

  function textFor(node: Parser.SyntaxNode) {
    return content.slice(node.startIndex, node.endIndex);
  }

  function visit(node: Parser.SyntaxNode) {
    const type = node.type;
    if (
      ["function_declaration", "method_definition", "class_declaration", "interface_declaration", "type_alias_declaration", "function_definition", "class_definition", "function_item", "struct_item", "enum_item", "method_declaration", "function_declaration"].includes(
        type
      )
    ) {
      const nameNode = node.childForFieldName("name") || node.childForFieldName("identifier");
      if (nameNode) {
        symbols.push({
          name: textFor(nameNode),
          kind: type,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: textFor(node).slice(0, 200)
        });
      }
    }
    if (type === "call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode) {
        references.push({
          name: textFor(fnNode),
          line: node.startPosition.row + 1,
          kind: "call"
        });
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return { symbols, references };
}

async function indexFile(params: {
  repoId: number;
  filePath: string;
  relativePath: string;
  content: string;
  language: string;
  force: boolean;
  isPattern: boolean;
}) {
  const contentHash = hashContent(params.content);
  const existing = await prisma.fileIndex.findFirst({
    where: { repoId: params.repoId, path: params.relativePath, isPattern: params.isPattern }
  });
  if (existing && existing.contentHash === contentHash && !params.force) {
    return;
  }

  const fileRecord = existing
    ? await prisma.fileIndex.update({
        where: { id: existing.id },
        data: {
          language: params.language,
          contentHash,
          size: Buffer.byteLength(params.content),
          lastIndexedAt: new Date()
        }
      })
    : await prisma.fileIndex.create({
        data: {
          repoId: params.repoId,
          path: params.relativePath,
          language: params.language,
          contentHash,
          size: Buffer.byteLength(params.content),
          lastIndexedAt: new Date(),
          isPattern: params.isPattern
        }
      });

  await prisma.symbolReference.deleteMany({ where: { fileId: fileRecord.id } });
  await prisma.symbol.deleteMany({ where: { fileId: fileRecord.id } });
  await prisma.embedding.deleteMany({ where: { fileId: fileRecord.id } });

  const languageConfig = languageMap[path.extname(params.relativePath).toLowerCase()];
  let symbols: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    signature?: string;
    doc?: string;
  }> = [];
  let references: Array<{ name: string; line: number; kind: string }> = [];
  if (languageConfig) {
    try {
      const parser = new Parser();
      parser.setLanguage(languageConfig.language as any);
      const parseContent =
        params.content.length > MAX_PARSE_CHARS
          ? params.content.slice(0, MAX_PARSE_CHARS)
          : params.content;
      const tree = parser.parse(parseContent);
      const extracted = extractSymbols(params.language, tree, parseContent);
      symbols = extracted.symbols;
      references = extracted.references;
    } catch (err) {
      if (env.logLevel === "debug") {
        console.warn(`Indexer parse failed for ${params.relativePath}`, err);
      }
    }
  }

  const symbolTexts = symbols.map((symbol) => `${symbol.name} ${symbol.signature || ""}`);
  const symbolVectors = symbolTexts.length > 0 ? await embedTexts(symbolTexts) : [];

  for (const [idx, symbol] of symbols.entries()) {
    const hash = hashContent(`${symbol.name}:${symbol.kind}:${symbol.startLine}:${symbol.endLine}`);
    const symbolRecord = await prisma.symbol.create({
      data: {
        repoId: params.repoId,
        fileId: fileRecord.id,
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature || null,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        doc: symbol.doc || null,
        hash
      }
    });
    const embeddingVector = symbolVectors[idx] || (await embedText(`${symbol.name} ${symbol.signature || ""}`));
    await prisma.embedding.create({
      data: {
        repoId: params.repoId,
        fileId: fileRecord.id,
        symbolId: symbolRecord.id,
        kind: "symbol",
        vector: embeddingVector,
        text: `${symbol.name} ${symbol.signature || ""}`
      }
    });
  }

  for (const ref of references) {
    await prisma.symbolReference.create({
      data: {
        repoId: params.repoId,
        fileId: fileRecord.id,
        refName: ref.name,
        line: ref.line,
        kind: ref.kind
      }
    });
  }

  const chunks = chunkTextForEmbedding({
    content: params.content,
    maxChars: CHUNK_MAX_CHARS,
    overlapChars: CHUNK_OVERLAP_CHARS,
    maxChunks: CHUNK_MAX_PER_FILE
  });
  if (chunks.length > 0) {
    const chunkTexts = chunks.map((chunk) =>
      `${params.relativePath}\nL${chunk.startLine}-${chunk.endLine}\n${chunk.text}`
    );
    const chunkVectors = await embedTexts(chunkTexts);
    for (const [idx, chunk] of chunks.entries()) {
      const text = chunkTexts[idx];
      const vector = chunkVectors[idx];
      if (!vector) continue;
      await prisma.embedding.create({
        data: {
          repoId: params.repoId,
          fileId: fileRecord.id,
          kind: "chunk",
          vector,
          text: text.slice(0, 6000)
        }
      });
    }
  }

  const fileEmbeddingText = `${params.relativePath}\n${params.content}`;
  const fileVector = await embedText(fileEmbeddingText);
  await prisma.embedding.create({
    data: {
      repoId: params.repoId,
      fileId: fileRecord.id,
      kind: "file",
      vector: fileVector,
      text: `${params.relativePath}\n${params.content.slice(0, 5000)}`
    }
  });
}

export async function processIndexJob(job: IndexJob) {
  initParsers();
  const repo = await prisma.repo.findFirst({ where: { id: job.repoId }, include: { provider: true, installations: { include: { installation: true } } } });
  if (!repo) return;

  const indexRun = await prisma.indexRun.create({
    data: {
      repoId: repo.id,
      headSha: job.headSha,
      status: "running",
      startedAt: new Date()
    }
  });

  try {
    let repoPath: string | null = null;
    const targetSha = job.headSha || "HEAD";
    if (!job.patternRepo) {
      const adapter = getProviderAdapter("github");
      const providerRepo: ProviderRepo = {
        externalId: repo.externalId,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName
      };
      const dummyPr: ProviderPullRequest = {
        externalId: repo.externalId,
        number: 0,
        title: null,
        body: null,
        url: null,
        state: "open",
        headSha: targetSha
      };
      const installationExternalId =
        job.installationId ||
        repo.installations[0]?.installation.externalId ||
        null;
      const client = await adapter.createClient({
        installationId: installationExternalId,
        repo: providerRepo,
        pullRequest: dummyPr
      });
      repoPath = await client.ensureRepoCheckout({ headSha: targetSha });
    } else {
      const rawName = job.patternRepo.name || "pattern-repo";
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_") || "pattern-repo";
      const basePatternsDir = path.join(env.projectRoot, "var", "patterns");
      const patternDir = path.join(basePatternsDir, safeName);
      const resolvedBase = path.resolve(basePatternsDir);
      const resolvedPattern = path.resolve(patternDir);
      if (!resolvedPattern.startsWith(resolvedBase + path.sep)) {
        throw new Error(`Invalid pattern repo name: ${rawName}`);
      }
      const gitDir = path.join(patternDir, ".git");
      await fs.mkdir(patternDir, { recursive: true });
      const exists = await fs
        .stat(gitDir)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await execa("git", ["clone", job.patternRepo.url, patternDir], { stdio: "inherit" });
      } else {
        await execa("git", ["-C", patternDir, "fetch", "--all", "--prune"], { stdio: "inherit" });
      }
      if (job.patternRepo.ref) {
        await execa("git", ["-C", patternDir, "checkout", "--detach", "--", job.patternRepo.ref], {
          stdio: "inherit"
        });
      }
      repoPath = patternDir;
    }

    if (!repoPath) {
      throw new Error("Unable to resolve repo path for indexing");
    }

    const ignoreDirs = new Set([".git", "node_modules", "dist", "build", "var", "internal_harness"]);
    const files = await walk(repoPath, ignoreDirs);
    for (const filePath of files) {
      const relativePath = path.relative(repoPath, filePath);
      const ext = path.extname(filePath).toLowerCase();
      const languageConfig = languageMap[ext];
      const raw = await fs.readFile(filePath);
      if (raw.length > MAX_INDEX_BYTES) continue;
      if (raw.includes(0)) continue;
      if (!shouldIndexAsText({ relativePath, raw, languageKnown: Boolean(languageConfig) })) continue;
      const content = raw.toString("utf8");
      await indexFile({
        repoId: repo.id,
        filePath,
        relativePath,
        content,
        language: inferredLanguageName(relativePath, languageConfig?.name),
        force: Boolean(job.force),
        isPattern: Boolean(job.patternRepo)
      });
    }

    await prisma.indexRun.update({
      where: { id: indexRun.id },
      data: {
        status: "completed",
        completedAt: new Date()
      }
    });
  } catch (err) {
    await prisma.indexRun.update({
      where: { id: indexRun.id },
      data: { status: "failed", completedAt: new Date() }
    });
    throw err;
  }
}
