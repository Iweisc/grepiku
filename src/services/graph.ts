import path from "path";
import { prisma } from "../db/client.js";
import { resolveRepoConfig } from "../review/config.js";

type GraphJob = {
  repoId: number;
};

type EdgeDraft = {
  fromNodeId: number;
  toNodeId: number;
  type: string;
  weight: number;
  examples: string[];
};

type SymbolLite = {
  id: number;
  fileId: number;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
};

const JS_RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
const PY_RESOLVE_EXTS = [".py"];
const GO_RESOLVE_EXTS = [".go"];
const RUST_RESOLVE_EXTS = [".rs"];
const DEFAULT_GRAPH_EXCLUDE_DIRS = ["internal_harness"];

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function normalizeGraphExcludeDir(value: string): string {
  return normalizeRepoPath(value).replace(/^\/+/, "").replace(/\/+$/, "");
}

function resolveGraphExcludeDirs(configured: string[] | undefined): string[] {
  const source = configured && configured.length > 0 ? configured : DEFAULT_GRAPH_EXCLUDE_DIRS;
  const unique = new Set<string>();
  for (const raw of source) {
    const normalized = normalizeGraphExcludeDir(raw || "");
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function shouldExcludeFromGraph(filePath: string, excludedDirs: string[]): boolean {
  if (excludedDirs.length === 0) return false;
  const normalizedPath = normalizeRepoPath(filePath).replace(/^\/+/, "");
  for (const dir of excludedDirs) {
    if (normalizedPath === dir || normalizedPath.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

function cleanImportSpecifier(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "").split("?")[0].split("#")[0].trim();
}

function hasKnownExtension(value: string, extensions: string[]): boolean {
  return extensions.includes(path.posix.extname(value).toLowerCase());
}

function resolveFromBase(params: {
  base: string;
  filePathSet: Set<string>;
  extensions: string[];
  indexBasename: string;
}): string | null {
  const base = normalizeRepoPath(params.base);
  if (!base) return null;
  const candidates = new Set<string>();
  candidates.add(base);
  const ext = path.posix.extname(base).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const stem = base.slice(0, -ext.length);
    for (const variant of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.add(`${stem}${variant}`);
    }
  } else if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) {
    const stem = base.slice(0, -ext.length);
    for (const variant of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.add(`${stem}${variant}`);
    }
  }
  if (!hasKnownExtension(base, params.extensions)) {
    for (const ext of params.extensions) {
      candidates.add(`${base}${ext}`);
      candidates.add(`${base}/${params.indexBasename}${ext}`);
    }
  }
  for (const candidate of candidates) {
    if (params.filePathSet.has(candidate)) return candidate;
  }
  return null;
}

function resolvePythonImport(params: {
  fromPath: string;
  spec: string;
  filePathSet: Set<string>;
}): string | null {
  const cleaned = cleanImportSpecifier(params.spec);
  if (!cleaned) return null;
  const leadingDots = (cleaned.match(/^\.+/)?.[0] || "").length;
  const modulePath = cleaned.slice(leadingDots).replace(/\./g, "/");
  const fromDir = path.posix.dirname(params.fromPath);

  if (leadingDots > 0) {
    let anchor = fromDir;
    for (let i = 1; i < leadingDots; i += 1) {
      anchor = path.posix.dirname(anchor);
    }
    const base = modulePath ? path.posix.join(anchor, modulePath) : anchor;
    return resolveFromBase({
      base,
      filePathSet: params.filePathSet,
      extensions: PY_RESOLVE_EXTS,
      indexBasename: "__init__"
    });
  }

  return resolveFromBase({
    base: modulePath,
    filePathSet: params.filePathSet,
    extensions: PY_RESOLVE_EXTS,
    indexBasename: "__init__"
  });
}

function resolveImportToInternalPath(params: {
  fromPath: string;
  spec: string;
  filePathSet: Set<string>;
}): string | null {
  const cleaned = cleanImportSpecifier(params.spec);
  if (!cleaned || cleaned.startsWith("node:")) return null;
  const fromExt = path.posix.extname(params.fromPath).toLowerCase();

  if (fromExt === ".py") {
    return resolvePythonImport({
      fromPath: params.fromPath,
      spec: cleaned,
      filePathSet: params.filePathSet
    });
  }

  const baseCandidates: string[] = [];
  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    baseCandidates.push(path.posix.join(path.posix.dirname(params.fromPath), cleaned));
  } else if (cleaned.startsWith("@/")) {
    baseCandidates.push(cleaned.slice(2));
  } else if (cleaned.startsWith("~/")) {
    baseCandidates.push(cleaned.slice(2));
  } else if (cleaned.startsWith("/")) {
    baseCandidates.push(cleaned.slice(1));
  } else {
    baseCandidates.push(cleaned);
  }

  const extensions =
    fromExt === ".go"
      ? GO_RESOLVE_EXTS
      : fromExt === ".rs"
      ? RUST_RESOLVE_EXTS
      : JS_RESOLVE_EXTS;

  for (const base of baseCandidates) {
    const resolved = resolveFromBase({
      base,
      filePathSet: params.filePathSet,
      extensions,
      indexBasename: "index"
    });
    if (resolved) return resolved;
  }
  return null;
}

function externalPackageFromImport(params: { spec: string; fromPath: string }): string | null {
  const cleaned = cleanImportSpecifier(params.spec);
  if (!cleaned || cleaned.startsWith(".") || cleaned.startsWith("/") || cleaned.startsWith("@/") || cleaned.startsWith("~/")) {
    return null;
  }

  const fromExt = path.posix.extname(params.fromPath).toLowerCase();
  if (fromExt === ".py") {
    const root = cleaned.replace(/^\.+/, "").split(".")[0];
    return root || null;
  }
  if (cleaned.startsWith("@")) {
    const parts = cleaned.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : cleaned;
  }
  return cleaned.split("/")[0] || null;
}

function moduleNameForPath(filePath: string): string {
  const normalized = normalizeRepoPath(filePath);
  const parts = normalized.split("/");
  return parts.length > 1 ? parts[0] : "(root)";
}

function directoryChainForFile(filePath: string): string[] {
  const normalized = normalizeRepoPath(filePath);
  const dirname = path.posix.dirname(normalized);
  if (!dirname || dirname === "." || dirname === "/") return ["."];
  const parts = dirname.split("/").filter(Boolean);
  const chain: string[] = ["."];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    chain.push(current);
  }
  return chain;
}

function normalizeRefName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const jsMember = trimmed.split(".").pop() || trimmed;
  const rustMember = jsMember.split("::").pop() || jsMember;
  return rustMember.replace(/[^\w$]/g, "");
}

function addAggregatedEdge(
  edgeMap: Map<string, EdgeDraft>,
  params: {
    fromNodeId: number;
    toNodeId: number;
    type: string;
    example?: string;
  }
) {
  if (params.fromNodeId === params.toNodeId) return;
  const key = `${params.fromNodeId}:${params.toNodeId}:${params.type}`;
  const existing = edgeMap.get(key);
  if (existing) {
    existing.weight += 1;
    if (params.example && existing.examples.length < 5 && !existing.examples.includes(params.example)) {
      existing.examples.push(params.example);
    }
    return;
  }
  edgeMap.set(key, {
    fromNodeId: params.fromNodeId,
    toNodeId: params.toNodeId,
    type: params.type,
    weight: 1,
    examples: params.example ? [params.example] : []
  });
}

function findOwningSymbolId(
  symbolsByFile: Map<number, SymbolLite[]>,
  fileId: number,
  line: number
): number | null {
  const symbols = symbolsByFile.get(fileId) || [];
  for (const symbol of symbols) {
    if (line >= symbol.startLine && line <= symbol.endLine) {
      return symbol.id;
    }
  }
  return null;
}

function findNearestContainingSymbol(symbols: SymbolLite[], symbol: SymbolLite): SymbolLite | null {
  const currentSpan = symbol.endLine - symbol.startLine;
  let winner: SymbolLite | null = null;
  let winnerSpan = Number.POSITIVE_INFINITY;
  for (const candidate of symbols) {
    if (candidate.id === symbol.id) continue;
    if (candidate.startLine > symbol.startLine || candidate.endLine < symbol.endLine) continue;
    const candidateSpan = candidate.endLine - candidate.startLine;
    if (candidateSpan < currentSpan) continue;
    if (candidateSpan < winnerSpan) {
      winner = candidate;
      winnerSpan = candidateSpan;
    }
  }
  return winner;
}

export async function processGraphJob(job: GraphJob) {
  const repoId = job.repoId;
  const repoConfig = await resolveRepoConfig(repoId).catch(() => null);
  const excludedDirs = resolveGraphExcludeDirs(repoConfig?.graph?.exclude_dirs);

  const indexedFiles = await prisma.fileIndex.findMany({
    where: { repoId, isPattern: false },
    select: { id: true, path: true }
  });
  const files = indexedFiles.filter((file) => !shouldExcludeFromGraph(file.path, excludedDirs));

  await prisma.graphEdge.deleteMany({ where: { repoId } });
  await prisma.graphNode.deleteMany({ where: { repoId } });
  if (files.length === 0) return;

  const fileIds = files.map((file) => file.id);
  const [refs, symbols] = await Promise.all([
    prisma.symbolReference.findMany({
      where: { repoId, fileId: { in: fileIds }, file: { isPattern: false } },
      select: { fileId: true, refName: true, line: true, kind: true }
    }),
    prisma.symbol.findMany({
      where: { repoId, fileId: { in: fileIds }, file: { isPattern: false } },
      select: { id: true, fileId: true, name: true, kind: true, startLine: true, endLine: true }
    })
  ]);

  const fileNodes = new Map<number, number>();
  const filePathSet = new Set<string>();
  const fileIdByPath = new Map<string, number>();
  const filePathById = new Map<number, string>();
  const directoryNodes = new Map<string, number>();
  const edgeDrafts = new Map<string, EdgeDraft>();

  const ensureDirectoryNode = async (dirPath: string): Promise<number> => {
    const normalizedDir = normalizeRepoPath(dirPath || ".");
    const existing = directoryNodes.get(normalizedDir);
    if (existing) return existing;
    const node = await prisma.graphNode.create({
      data: {
        repoId,
        type: "directory",
        key: `dir:${normalizedDir}`,
        data: { path: normalizedDir }
      }
    });
    directoryNodes.set(normalizedDir, node.id);
    return node.id;
  };

  for (const file of files) {
    const normalizedPath = normalizeRepoPath(file.path);
    filePathSet.add(normalizedPath);
    fileIdByPath.set(normalizedPath, file.id);
    filePathById.set(file.id, normalizedPath);
    const node = await prisma.graphNode.create({
      data: {
        repoId,
        type: "file",
        key: normalizedPath,
        fileId: file.id,
        data: { label: normalizedPath }
      }
    });
    fileNodes.set(file.id, node.id);

    const dirChain = directoryChainForFile(normalizedPath);
    let previousDirNodeId: number | null = null;
    for (const dirPath of dirChain) {
      const dirNodeId = await ensureDirectoryNode(dirPath);
      if (previousDirNodeId && previousDirNodeId !== dirNodeId) {
        addAggregatedEdge(edgeDrafts, {
          fromNodeId: previousDirNodeId,
          toNodeId: dirNodeId,
          type: "dir_contains_dir"
        });
      }
      previousDirNodeId = dirNodeId;
    }
    if (previousDirNodeId) {
      addAggregatedEdge(edgeDrafts, {
        fromNodeId: previousDirNodeId,
        toNodeId: node.id,
        type: "dir_contains_file"
      });
    }
  }

  const moduleNodes = new Map<string, number>();
  const moduleByFileId = new Map<number, string>();
  for (const file of files) {
    const fileNodeId = fileNodes.get(file.id);
    if (!fileNodeId) continue;
    const moduleName = moduleNameForPath(filePathById.get(file.id) || file.path);
    moduleByFileId.set(file.id, moduleName);
    let moduleNodeId = moduleNodes.get(moduleName);
    if (!moduleNodeId) {
      const moduleNode = await prisma.graphNode.create({
        data: {
          repoId,
          type: "module",
          key: `module:${moduleName}`,
          data: { name: moduleName }
        }
      });
      moduleNodeId = moduleNode.id;
      moduleNodes.set(moduleName, moduleNodeId);
    }
    addAggregatedEdge(edgeDrafts, {
      fromNodeId: moduleNodeId,
      toNodeId: fileNodeId,
      type: "module_contains"
    });
  }

  const symbolNodes = new Map<number, number>();
  const symbolsByFile = new Map<number, SymbolLite[]>();
  const symbolIdsByName = new Map<string, number[]>();
  const symbolFileById = new Map<number, number>();
  for (const symbol of symbols) {
    const filePath = filePathById.get(symbol.fileId) || "";
    const node = await prisma.graphNode.create({
      data: {
        repoId,
        type: "symbol",
        key: `${filePath}:${symbol.name}:${symbol.startLine}`,
        fileId: symbol.fileId,
        symbolId: symbol.id,
        data: {
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine
        }
      }
    });
    symbolNodes.set(symbol.id, node.id);
    symbolFileById.set(symbol.id, symbol.fileId);
    const fileNodeId = fileNodes.get(symbol.fileId);
    if (fileNodeId) {
      addAggregatedEdge(edgeDrafts, {
        fromNodeId: fileNodeId,
        toNodeId: node.id,
        type: "contains_symbol"
      });
    }

    const normName = normalizeRefName(symbol.name);
    if (normName) {
      const list = symbolIdsByName.get(normName) || [];
      list.push(symbol.id);
      symbolIdsByName.set(normName, list);
    }

    const listByFile = symbolsByFile.get(symbol.fileId) || [];
    listByFile.push({
      id: symbol.id,
      fileId: symbol.fileId,
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.startLine,
      endLine: symbol.endLine
    });
    symbolsByFile.set(symbol.fileId, listByFile);
  }
  for (const list of symbolsByFile.values()) {
    list.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  }
  const classLikeKinds = new Set([
    "class_declaration",
    "class_definition",
    "struct_item",
    "interface_declaration"
  ]);
  for (const list of symbolsByFile.values()) {
    for (const symbol of list) {
      const parent = findNearestContainingSymbol(list, symbol);
      if (!parent) continue;
      const parentNodeId = symbolNodes.get(parent.id);
      const childNodeId = symbolNodes.get(symbol.id);
      if (!parentNodeId || !childNodeId) continue;
      addAggregatedEdge(edgeDrafts, {
        fromNodeId: parentNodeId,
        toNodeId: childNodeId,
        type: classLikeKinds.has(parent.kind) ? "class_contains_symbol" : "symbol_contains_symbol"
      });
    }
  }

  const externalNodes = new Map<string, number>();
  for (const ref of refs) {
    const fromFileNodeId = fileNodes.get(ref.fileId);
    const fromPath = filePathById.get(ref.fileId);
    if (!fromFileNodeId || !fromPath) continue;
    const refKind = (ref.kind || "").toLowerCase();
    const sourceSymbolId = findOwningSymbolId(symbolsByFile, ref.fileId, ref.line);
    const sourceSymbolNodeId = sourceSymbolId ? symbolNodes.get(sourceSymbolId) || null : null;

    if (refKind === "import") {
      const internalTargetPath = resolveImportToInternalPath({
        fromPath,
        spec: ref.refName,
        filePathSet
      });
      if (internalTargetPath) {
        const targetFileId = fileIdByPath.get(internalTargetPath);
        const toFileNodeId = targetFileId ? fileNodes.get(targetFileId) : undefined;
        if (toFileNodeId) {
          addAggregatedEdge(edgeDrafts, {
            fromNodeId: fromFileNodeId,
            toNodeId: toFileNodeId,
            type: "file_dep",
            example: ref.refName
          });
          if (sourceSymbolNodeId) {
            addAggregatedEdge(edgeDrafts, {
              fromNodeId: sourceSymbolNodeId,
              toNodeId: toFileNodeId,
              type: "symbol_imports_file",
              example: ref.refName
            });
          }
          const fromModule = moduleByFileId.get(ref.fileId);
          const toModule = targetFileId ? moduleByFileId.get(targetFileId) : undefined;
          const fromModuleNodeId = fromModule ? moduleNodes.get(fromModule) : undefined;
          const toModuleNodeId = toModule ? moduleNodes.get(toModule) : undefined;
          if (fromModuleNodeId && toModuleNodeId && fromModuleNodeId !== toModuleNodeId) {
            addAggregatedEdge(edgeDrafts, {
              fromNodeId: fromModuleNodeId,
              toNodeId: toModuleNodeId,
              type: "module_dep",
              example: `${fromPath} -> ${internalTargetPath}`
            });
          }
        }
        continue;
      }

      const external = externalPackageFromImport({ spec: ref.refName, fromPath });
      if (!external) continue;
      let externalNodeId = externalNodes.get(external);
      if (!externalNodeId) {
        const created = await prisma.graphNode.create({
          data: {
            repoId,
            type: "external",
            key: `external:${external}`,
            data: { name: external }
          }
        });
        externalNodeId = created.id;
        externalNodes.set(external, externalNodeId);
      }
      addAggregatedEdge(edgeDrafts, {
        fromNodeId: fromFileNodeId,
        toNodeId: externalNodeId,
        type: "external_dep",
        example: ref.refName
      });
      if (sourceSymbolNodeId) {
        addAggregatedEdge(edgeDrafts, {
          fromNodeId: sourceSymbolNodeId,
          toNodeId: externalNodeId,
          type: "symbol_external_dep",
          example: ref.refName
        });
      }
      continue;
    }

    if (refKind === "export") {
      const exportedName = normalizeRefName(ref.refName);
      if (!exportedName) continue;
      const localSymbols = (symbolIdsByName.get(exportedName) || []).filter((id) => symbolFileById.get(id) === ref.fileId);
      for (const localSymbolId of localSymbols.slice(0, 5)) {
        const symbolNodeId = symbolNodes.get(localSymbolId);
        if (!symbolNodeId) continue;
        addAggregatedEdge(edgeDrafts, {
          fromNodeId: fromFileNodeId,
          toNodeId: symbolNodeId,
          type: "exports_symbol",
          example: exportedName
        });
      }
      continue;
    }

    const normalizedRef = normalizeRefName(ref.refName);
    if (!normalizedRef) continue;
    const targetSymbolIds = symbolIdsByName.get(normalizedRef) || [];
    if (targetSymbolIds.length === 0) continue;
    if (targetSymbolIds.length > 3) continue;
    if (!sourceSymbolNodeId) continue;

    for (const targetSymbolId of targetSymbolIds) {
      const targetSymbolNodeId = symbolNodes.get(targetSymbolId);
      const targetFileId = symbolFileById.get(targetSymbolId);
      if (!targetSymbolNodeId || !targetFileId || targetFileId === ref.fileId) continue;
      addAggregatedEdge(edgeDrafts, {
        fromNodeId: sourceSymbolNodeId,
        toNodeId: targetSymbolNodeId,
        type: "references_symbol",
        example: normalizedRef
      });
      const toFileNodeId = fileNodes.get(targetFileId);
      if (toFileNodeId) {
        addAggregatedEdge(edgeDrafts, {
          fromNodeId: fromFileNodeId,
          toNodeId: toFileNodeId,
          type: "file_dep_inferred",
          example: `${normalizedRef}@L${ref.line}`
        });
      }
    }
  }

  for (const edge of edgeDrafts.values()) {
    const payload: any = { weight: edge.weight };
    if (edge.examples.length > 0) payload.examples = edge.examples;
    await prisma.graphEdge.create({
      data: {
        repoId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        type: edge.type,
        data: payload
      }
    });
  }

  for (const edge of edgeDrafts.values()) {
    if (edge.type !== "file_dep_inferred" || edge.weight < 2) continue;
    await prisma.graphEdge.create({
      data: {
        repoId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        type: "file_dep",
        data: { weight: edge.weight, source: "inferred" }
      }
    });
  }
}
