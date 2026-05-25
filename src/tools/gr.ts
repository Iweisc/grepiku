import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { minimatch } from "minimatch";
import { classifyChangedFileRisk } from "../review/risk.js";
import type { ContextPack } from "../review/context.js";

type JsonRecord = Record<string, unknown>;

type GrContext = {
  contextPack: Partial<ContextPack> & JsonRecord;
  bundleDir: string;
  repoPath: string;
};

export type GrResult = {
  status: "ok" | "fallback";
  command: string;
  data: unknown;
  diagnostics?: string[];
};

type ParsedArgs = {
  command: string[];
  json: boolean;
  topK: number;
  depth: number;
  path?: string;
};

const HELP_TEXT = `gr - Grepiku review context CLI

Usage:
  gr changed-context [--top-k N] [--json]
  gr retrieve [query] [--top-k N] [--json]
  gr graph impact [--json]
  gr graph neighbors <path-or-symbol> [--depth N] [--json]
  gr symbol-context <path> <symbol> [--json]
  gr rules --path <path> [--json]
  gr risk --path <path> [--json]
  gr tests-for <path> [--json]

Recommended review flow:
  1. Start with gr changed-context --top-k 8, or gr retrieve --top-k 8 for semantic context.
  2. Inspect the diff and relevant files with shell tools.
  3. Use gr rules/risk/tests-for for specific files after the chunk-level context pass.

Use normal shell tools for repo inspection: git diff, git grep, rg, sed, and file reads.
gr only returns Grepiku-specific cached retrieval, graph, rules, risk, symbol, and test hints.`;

const TEST_PATH_PATTERNS = [
  /(^|\/)(__tests__|tests?|specs?|fixtures?|mocks?|testdata)(\/|$)/i,
  /(^|\/)[^/]+(_test|\.(test|spec))\.(go|ts|tsx|js|jsx|py|rb|java|kt|rs)$/i
];

function normalizePathValue(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/^\/+/, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function queryTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length >= 2)
    .slice(0, 32);
}

function itemText(item: JsonRecord): string {
  return [item.kind, item.path, item.symbol, item.text].filter(Boolean).join("\n");
}

function scoreContextItem(item: JsonRecord, terms: string[]): number {
  const haystack = itemText(item).toLowerCase();
  let score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function compactContextArray(value: unknown, limit: number): unknown[] {
  return asArray(value).slice(0, limit);
}

function compactRetrievedItems(value: unknown[], textChars: number): JsonRecord[] {
  return value.filter(isRecord).map((item) => ({
    kind: item.kind,
    path: item.path,
    symbol: item.symbol,
    score: item.score,
    isPattern: item.isPattern === true || undefined,
    text: compactString(item.text, textChars)
  }));
}

function defaultRetrieveQuery(context: GrContext): string {
  const query = compactString(context.contextPack.query, 2400);
  if (query) return query;
  const reviewFocus = asArray(context.contextPack.reviewFocus)
    .map((item) => (typeof item === "string" ? item : ""))
    .filter(Boolean)
    .slice(0, 12);
  const changedPaths = asArray(context.contextPack.changedFileStats)
    .filter(isRecord)
    .map((item) => (typeof item.path === "string" ? item.path : ""))
    .filter(Boolean)
    .slice(0, 40);
  return [...reviewFocus, ...changedPaths].join("\n");
}

function compactString(value: unknown, maxChars = 1200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function outputTextForData(command: string, data: unknown): string {
  if (!Array.isArray(data)) {
    return typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }
  if (data.length === 0) return "No cached Grepiku context found.";
  return data
    .map((item) => {
      if (!isRecord(item)) return String(item);
      const label = [item.kind, item.path, item.symbol].filter(Boolean).join(":") || command;
      const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
      const text = compactString(item.text, 1400);
      return text ? `${label}${score}\n${text}` : `${label}${score}`;
    })
    .join("\n\n");
}

export async function loadGrContext(options: {
  contextPackPath?: string;
  bundleDir?: string;
  repoPath?: string;
} = {}): Promise<GrContext> {
  const bundleDir = path.resolve(options.bundleDir || process.env.WORK_BUNDLE_ROOT || process.cwd());
  const repoPath = path.resolve(options.repoPath || process.env.WORK_REPO_ROOT || process.cwd());
  const contextPackPath = path.resolve(
    options.contextPackPath || process.env.GREPIKU_CONTEXT_PACK_PATH || path.join(bundleDir, "context_pack.json")
  );
  const raw = await fs.readFile(contextPackPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<ContextPack> & JsonRecord;
  return { contextPack: parsed, bundleDir, repoPath };
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  let json = false;
  let topK = 8;
  let depth = 1;
  let pathArg: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--top-k") {
      topK = Math.max(1, Math.min(60, Number(argv[++index] || 8) || 8));
      continue;
    }
    if (arg === "--depth") {
      depth = Math.max(1, Math.min(6, Number(argv[++index] || 1) || 1));
      continue;
    }
    if (arg === "--path") {
      pathArg = argv[++index];
      continue;
    }
    command.push(arg);
  }
  return { command, json, topK, depth, path: pathArg };
}

function retrieve(context: GrContext, query: string, topK: number): unknown[] {
  const terms = queryTerms(query || defaultRetrieveQuery(context));
  return asArray(context.contextPack.retrieved)
    .filter(isRecord)
    .map((item) => ({ ...item, score: scoreContextItem(item, terms) }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, topK);
}

function changedContext(context: GrContext, topK: number): JsonRecord {
  return {
    query: compactString(context.contextPack.query, 1600) || defaultRetrieveQuery(context),
    reviewFocus: compactContextArray(context.contextPack.reviewFocus, 12),
    changedFileStats: compactContextArray(context.contextPack.changedFileStats, 80),
    hotspots: compactContextArray(context.contextPack.hotspots, 8),
    relatedFiles: compactContextArray(context.contextPack.relatedFiles, 24),
    graphLinks: compactContextArray(context.contextPack.graphLinks, 48),
    graphPaths: compactContextArray(context.contextPack.graphPaths, 12),
    graphDebug: context.contextPack.graphDebug || null,
    retrieved: compactRetrievedItems(retrieve(context, defaultRetrieveQuery(context), topK), 900)
  };
}

function graphImpact(context: GrContext): JsonRecord {
  return {
    reviewFocus: asArray(context.contextPack.reviewFocus).slice(0, 20),
    changedFileStats: asArray(context.contextPack.changedFileStats),
    relatedFiles: asArray(context.contextPack.relatedFiles),
    graphLinks: asArray(context.contextPack.graphLinks),
    graphPaths: asArray(context.contextPack.graphPaths),
    hotspots: asArray(context.contextPack.hotspots),
    graphDebug: context.contextPack.graphDebug || null
  };
}

function graphNeighbors(context: GrContext, target: string, depth: number): JsonRecord {
  const normalizedTarget = normalizePathValue(target).toLowerCase();
  const links = asArray(context.contextPack.graphLinks).filter(isRecord);
  let frontier = new Set([normalizedTarget]);
  const seen = new Set(frontier);
  const neighbors: JsonRecord[] = [];
  for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
    const next = new Set<string>();
    for (const link of links) {
      const from = normalizePathValue(String(link.from || "")).toLowerCase();
      const to = normalizePathValue(String(link.to || "")).toLowerCase();
      if (!from || !to) continue;
      if (frontier.has(from) || frontier.has(to)) {
        neighbors.push({ ...link, depth: currentDepth });
        for (const value of [from, to]) {
          if (!seen.has(value)) {
            seen.add(value);
            next.add(value);
          }
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  const related = asArray(context.contextPack.graphPaths)
    .filter(isRecord)
    .filter((item) => normalizePathValue(String(item.path || "")).toLowerCase().includes(normalizedTarget));
  return { target, depth, links: neighbors.slice(0, 80), graphPaths: related.slice(0, 12) };
}

async function symbolContext(context: GrContext, filePath: string, symbol: string): Promise<JsonRecord> {
  const normalizedPath = normalizePathValue(filePath).toLowerCase();
  const loweredSymbol = symbol.toLowerCase();
  const retrieved = asArray(context.contextPack.retrieved)
    .filter(isRecord)
    .filter((item) => {
      const itemPath = normalizePathValue(String(item.path || "")).toLowerCase();
      const itemSymbol = String(item.symbol || "").toLowerCase();
      const text = String(item.text || "").toLowerCase();
      return itemPath === normalizedPath && (itemSymbol.includes(loweredSymbol) || text.includes(loweredSymbol));
    })
    .slice(0, 8);
  return { path: filePath, symbol, retrieved };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function pathMatchesRule(rule: JsonRecord, targetPath: string): boolean {
  const pattern = typeof rule.pattern === "string" ? rule.pattern : "";
  const scope = typeof rule.scope === "string" ? rule.scope : "";
  if (!pattern && !scope) return true;
  return [pattern, scope].filter(Boolean).some((value) => minimatch(targetPath, value, { dot: true }));
}

async function rulesForPath(context: GrContext, targetPath: string): Promise<unknown[]> {
  const rulesPath = path.join(context.bundleDir, "rules.json");
  const rules = asArray(await readJsonFile(rulesPath).catch(() => []));
  const normalized = normalizePathValue(targetPath);
  return rules.filter(isRecord).filter((rule) => pathMatchesRule(rule, normalized));
}

function riskForPath(context: GrContext, targetPath: string): JsonRecord {
  const normalized = normalizePathValue(targetPath);
  const stat = asArray(context.contextPack.changedFileStats)
    .filter(isRecord)
    .find((item) => normalizePathValue(String(item.path || "")) === normalized);
  const additions = typeof stat?.additions === "number" ? stat.additions : undefined;
  const deletions = typeof stat?.deletions === "number" ? stat.deletions : undefined;
  return {
    path: normalized,
    risk: typeof stat?.risk === "string" ? stat.risk : classifyChangedFileRisk({ path: normalized, additions, deletions }),
    additions,
    deletions,
    hotspots: asArray(context.contextPack.hotspots)
      .filter(isRecord)
      .filter((item) => normalizePathValue(String(item.path || "")) === normalized),
    reviewFocus: asArray(context.contextPack.reviewFocus)
      .filter((item) => String(item).includes(normalized))
      .slice(0, 8)
  };
}

async function walkFiles(root: string, maxFiles = 8000): Promise<string[]> {
  const output: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (output.length >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        output.push(normalizePathValue(path.relative(root, fullPath)));
      }
      if (output.length >= maxFiles) break;
    }
  }
  await walk(root);
  return output;
}

function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function sourceBasenames(filePath: string): string[] {
  const normalized = normalizePathValue(filePath);
  const parsed = path.posix.parse(normalized);
  const base = parsed.name.replace(/\.(test|spec)$/i, "").replace(/_test$/i, "");
  return Array.from(new Set([base, base.replace(/[-_]/g, ""), parsed.dir.split("/").pop() || ""].filter(Boolean)));
}

async function testsForPath(context: GrContext, targetPath: string): Promise<JsonRecord> {
  const normalized = normalizePathValue(targetPath);
  const terms = sourceBasenames(normalized).map((value) => value.toLowerCase());
  const files = await walkFiles(context.repoPath).catch(() => []);
  const tests = files
    .filter(isTestPath)
    .map((filePath) => {
      const lower = filePath.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (term && lower.includes(term)) score += 2;
      }
      const sameDir = path.posix.dirname(filePath).includes(path.posix.dirname(normalized));
      if (sameDir) score += 1;
      return { path: filePath, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 20);
  return { path: normalized, tests };
}

export async function runGr(argv: string[], loadContext = loadGrContext): Promise<GrResult> {
  const parsed = parseArgs(argv);
  const [rootCommand, subCommand, ...rest] = parsed.command;
  if (!rootCommand || rootCommand === "--help" || rootCommand === "help") {
    return { status: "ok", command: "help", data: HELP_TEXT };
  }

  let context: GrContext;
  const diagnostics: string[] = [];
  try {
    context = await loadContext();
  } catch (error) {
    diagnostics.push(`context_pack fallback: ${error instanceof Error ? error.message : String(error)}`);
    context = { contextPack: {}, bundleDir: process.cwd(), repoPath: process.cwd() };
  }

  if (rootCommand === "retrieve") {
    return { status: diagnostics.length ? "fallback" : "ok", command: "retrieve", data: retrieve(context, [subCommand, ...rest].filter(Boolean).join(" "), parsed.topK), diagnostics };
  }
  if (rootCommand === "changed-context") {
    return { status: diagnostics.length ? "fallback" : "ok", command: "changed-context", data: changedContext(context, parsed.topK), diagnostics };
  }
  if (rootCommand === "graph" && subCommand === "impact") {
    return { status: diagnostics.length ? "fallback" : "ok", command: "graph impact", data: graphImpact(context), diagnostics };
  }
  if (rootCommand === "graph" && subCommand === "neighbors") {
    const target = rest.join(" ");
    return { status: diagnostics.length ? "fallback" : "ok", command: "graph neighbors", data: graphNeighbors(context, target, parsed.depth), diagnostics };
  }
  if (rootCommand === "symbol-context") {
    const [filePath, ...symbolParts] = [subCommand, ...rest];
    return { status: diagnostics.length ? "fallback" : "ok", command: "symbol-context", data: await symbolContext(context, filePath || "", symbolParts.join(" ")), diagnostics };
  }
  if (rootCommand === "rules") {
    const target = parsed.path || subCommand || "";
    return { status: diagnostics.length ? "fallback" : "ok", command: "rules", data: await rulesForPath(context, target), diagnostics };
  }
  if (rootCommand === "risk") {
    const target = parsed.path || subCommand || "";
    return { status: diagnostics.length ? "fallback" : "ok", command: "risk", data: riskForPath(context, target), diagnostics };
  }
  if (rootCommand === "tests-for") {
    return { status: diagnostics.length ? "fallback" : "ok", command: "tests-for", data: await testsForPath(context, subCommand || ""), diagnostics };
  }
  throw new Error(`unknown gr command: ${parsed.command.join(" ")}`);
}

export function formatGrResult(result: GrResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const diagnostics = result.diagnostics?.length ? `\n\nDiagnostics:\n${result.diagnostics.join("\n")}` : "";
  return `${outputTextForData(result.command, result.data)}${diagnostics}`;
}

export const __grInternals = {
  HELP_TEXT,
  parseArgs,
  queryTerms,
  scoreContextItem,
  retrieve,
  defaultRetrieveQuery,
  changedContext,
  graphImpact,
  graphNeighbors,
  riskForPath,
  testsForPath,
  formatGrResult
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  const parsed = parseArgs(process.argv.slice(2));
  runGr(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${formatGrResult(result, parsed.json)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`gr: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
