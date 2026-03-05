import { normalizePath } from "./diff.js";

function sanitizeMermaidLabel(label: string): string {
  return label
    .replace(/["<>]/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function makeMermaidNodeId(path: string, index: number): string {
  const slug = path
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  return `p_${slug || "node"}_${index}`;
}

function compactPathLabel(path: string, maxLength = 38): string {
  const normalized = normalizePath(path).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return normalized;
  let compact = parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : parts.join("/");
  if (compact.length > maxLength) {
    compact = `${compact.slice(0, Math.max(3, maxLength - 3))}...`;
  }
  return compact;
}

function dedupePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const pathValue = normalizePath(value || "");
    if (!pathValue || seen.has(pathValue)) continue;
    seen.add(pathValue);
    out.push(pathValue);
  }
  return out;
}

export function generateMermaidDiagram(params: {
  changedFiles: Array<{ filename?: string; path?: string }>;
  relatedFiles: string[];
  graphLinks: Array<{ from: string; to: string; type: string }>;
}): string {
  const maxChangedNodes = 8;
  const maxRelatedNodes = 10;
  const maxNodes = 18;
  const maxEdges = 24;

  const changed = dedupePaths(
    params.changedFiles
      .map((file) => file.filename || file.path)
      .filter((value): value is string => Boolean(value))
  ).slice(0, maxChangedNodes);
  if (changed.length === 0) return "";

  const changedSet = new Set(changed);
  const related = dedupePaths(params.relatedFiles).filter((path) => !changedSet.has(path)).slice(0, maxRelatedNodes * 2);
  const scopeSet = new Set([...changed, ...related]);

  const dedupeEdges = new Set<string>();
  const candidateEdges: Array<{ from: string; to: string; rank: number; order: number }> = [];

  params.graphLinks.forEach((rawLink, order) => {
    if (rawLink.type !== "file_dep") return;
    const from = normalizePath(rawLink.from || "");
    const to = normalizePath(rawLink.to || "");
    if (!from || !to || from === to) return;
    const key = `${from}->${to}`;
    if (dedupeEdges.has(key)) return;
    dedupeEdges.add(key);

    const fromChanged = changedSet.has(from);
    const toChanged = changedSet.has(to);
    if (!fromChanged && !toChanged) return;
    if (!scopeSet.has(from) && !scopeSet.has(to)) return;

    const rank = fromChanged !== toChanged ? 0 : 1;
    candidateEdges.push({ from, to, rank, order });
  });

  candidateEdges.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.order - right.order;
  });

  const nodeIds = new Map<string, string>();
  const nodeOrder: string[] = [];
  const addNode = (pathValue: string): boolean => {
    if (nodeIds.has(pathValue)) return true;
    if (nodeOrder.length >= maxNodes) return false;
    const id = makeMermaidNodeId(pathValue, nodeOrder.length);
    nodeIds.set(pathValue, id);
    nodeOrder.push(pathValue);
    return true;
  };

  changed.forEach((pathValue) => {
    addNode(pathValue);
  });

  const selectedEdges: Array<{ from: string; to: string }> = [];
  const relatedUsed = new Set<string>();

  for (const edge of candidateEdges) {
    const fromChanged = changedSet.has(edge.from);
    const toChanged = changedSet.has(edge.to);
    const other = fromChanged && !toChanged ? edge.to : toChanged && !fromChanged ? edge.from : null;
    if (other && !relatedUsed.has(other) && relatedUsed.size >= maxRelatedNodes) continue;

    if (!addNode(edge.from) || !addNode(edge.to)) continue;
    selectedEdges.push({ from: edge.from, to: edge.to });
    if (other) relatedUsed.add(other);
    if (selectedEdges.length >= maxEdges) break;
  }

  if (selectedEdges.length === 0 && related.length > 0) {
    for (const from of changed.slice(0, Math.min(5, changed.length))) {
      for (const to of related.slice(0, maxRelatedNodes)) {
        if (from === to) continue;
        if (!addNode(to)) break;
        selectedEdges.push({ from, to });
        if (selectedEdges.length >= Math.min(maxEdges, 16)) break;
      }
      if (selectedEdges.length >= Math.min(maxEdges, 16)) break;
    }
  }

  if (selectedEdges.length === 0) return "";

  const nodeLines = nodeOrder.map((pathValue) => {
    const id = nodeIds.get(pathValue);
    const label = sanitizeMermaidLabel(compactPathLabel(pathValue));
    return `${id}["${label}"]`;
  });

  const edgeLines = selectedEdges
    .map((edge) => {
      const fromId = nodeIds.get(edge.from);
      const toId = nodeIds.get(edge.to);
      if (!fromId || !toId) return null;
      return `${fromId} --> ${toId}`;
    })
    .filter((line): line is string => Boolean(line));

  const changedClassLines = nodeOrder
    .filter((pathValue) => changedSet.has(pathValue))
    .map((pathValue) => {
      const id = nodeIds.get(pathValue);
      return id ? `class ${id} changed;` : null;
    })
    .filter((line): line is string => Boolean(line));

  const relatedClassLines = nodeOrder
    .filter((pathValue) => !changedSet.has(pathValue))
    .map((pathValue) => {
      const id = nodeIds.get(pathValue);
      return id ? `class ${id} related;` : null;
    })
    .filter((line): line is string => Boolean(line));

  return [
    "flowchart LR",
    ...nodeLines,
    ...edgeLines,
    "classDef changed fill:#ffd7ba,stroke:#c2410c,stroke-width:1px,color:#111;",
    "classDef related fill:#1f2937,stroke:#334155,stroke-width:1px,color:#e5e7eb;",
    ...changedClassLines,
    ...relatedClassLines
  ].join("\n");
}
