import { prisma } from "../db/client.js";
import { retrieveContext } from "../services/retrieval.js";
import { normalizePath } from "./diff.js";

export type ContextPack = {
  query: string;
  retrieved: Array<{
    kind: "file" | "symbol";
    score: number;
    path?: string;
    symbol?: string;
    text: string;
    isPattern?: boolean;
  }>;
  relatedFiles: string[];
  changedFileStats: Array<{
    path: string;
    status?: string;
    additions?: number;
    deletions?: number;
    risk: "low" | "medium" | "high";
  }>;
  graphLinks: Array<{
    from: string;
    to: string;
    type: string;
  }>;
  hotspots: Array<{
    path: string;
    openFindings: number;
    historicalFindings: number;
    topCategories: string[];
  }>;
  reviewFocus: string[];
};

export async function buildContextPack(params: {
  repoId: number;
  diffPatch: string;
  changedFiles: Array<{
    filename?: string;
    path?: string;
    status?: string;
    additions?: number;
    deletions?: number;
  }>;
  topK?: number;
  prTitle?: string | null;
  prBody?: string | null;
}): Promise<ContextPack> {
  const changedFileStats = params.changedFiles
    .map((file) => {
      const rawPath = file.filename || file.path || "";
      const path = normalizePath(rawPath);
      if (!path) return null;
      const additions = typeof file.additions === "number" ? file.additions : undefined;
      const deletions = typeof file.deletions === "number" ? file.deletions : undefined;
      const churn = (additions || 0) + (deletions || 0);
      const risk: "low" | "medium" | "high" =
        churn >= 250 ? "high" : churn >= 80 ? "medium" : "low";
      return {
        path,
        status: file.status,
        additions,
        deletions,
        risk
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  const changedPaths = changedFileStats.map((file) => file.path);
  const diffSignals = buildDiffSignalSnippet(params.diffPatch);
  const queryParts = [
    params.prTitle ? `PR title: ${params.prTitle}` : "",
    params.prBody ? `PR body:\n${params.prBody.slice(0, 1200)}` : "",
    `Changed files:\n${changedPaths.join("\n")}`,
    `Diff signal lines:\n${diffSignals}`
  ].filter(Boolean);
  const query = queryParts.join("\n\n");

  const retrieved = await retrieveContext({
    repoId: params.repoId,
    query,
    topK: params.topK ?? 12,
    changedPaths
  });

  const changedNodes =
    changedPaths.length > 0
      ? await prisma.graphNode.findMany({
          where: { repoId: params.repoId, type: "file", key: { in: changedPaths } },
          select: { id: true, key: true }
        })
      : [];

  const changedNodeIds = changedNodes.map((node) => node.id);
  const graphEdges =
    changedNodeIds.length > 0
      ? await prisma.graphEdge.findMany({
          where: {
            repoId: params.repoId,
            OR: [{ fromNodeId: { in: changedNodeIds } }, { toNodeId: { in: changedNodeIds } }]
          },
          orderBy: { id: "desc" },
          take: 400
        })
      : [];

  const relatedNodeIdSet = new Set<number>();
  for (const edge of graphEdges) {
    relatedNodeIdSet.add(edge.fromNodeId);
    relatedNodeIdSet.add(edge.toNodeId);
  }

  const relatedNodes =
    relatedNodeIdSet.size > 0
      ? await prisma.graphNode.findMany({
          where: {
            repoId: params.repoId,
            type: "file",
            id: { in: Array.from(relatedNodeIdSet) }
          },
          select: { id: true, key: true }
        })
      : [];

  const nodePathById = new Map<number, string>();
  for (const node of relatedNodes) {
    nodePathById.set(node.id, node.key);
  }
  for (const node of changedNodes) {
    nodePathById.set(node.id, node.key);
  }

  const graphLinks: ContextPack["graphLinks"] = [];
  const graphLinkSeen = new Set<string>();
  for (const edge of graphEdges) {
    const from = nodePathById.get(edge.fromNodeId);
    const to = nodePathById.get(edge.toNodeId);
    if (!from || !to || from === to) continue;
    const dedupeKey = `${from}|${to}|${edge.type}`;
    if (graphLinkSeen.has(dedupeKey)) continue;
    graphLinkSeen.add(dedupeKey);
    graphLinks.push({ from, to, type: edge.type });
  }

  const changedPathSet = new Set(changedPaths);
  const relatedSet = new Set<string>();
  for (const link of graphLinks) {
    if (changedPathSet.has(link.from) && !changedPathSet.has(link.to)) {
      relatedSet.add(link.to);
    }
    if (changedPathSet.has(link.to) && !changedPathSet.has(link.from)) {
      relatedSet.add(link.from);
    }
  }

  for (const item of retrieved) {
    if (item.path && !changedPathSet.has(item.path)) {
      relatedSet.add(item.path);
    }
  }

  const relatedFiles = Array.from(relatedSet).slice(0, 15);
  const hotspotCandidates = Array.from(
    new Set(
      [...changedPaths, ...relatedFiles, ...retrieved.map((item) => item.path || "").filter(Boolean)].slice(0, 30)
    )
  );

  const historicalFindings =
    hotspotCandidates.length > 0
      ? await prisma.finding.findMany({
          where: {
            path: { in: hotspotCandidates },
            pullRequest: { repoId: params.repoId }
          },
          select: { path: true, status: true, category: true }
        })
      : [];

  const hotspotMap = new Map<
    string,
    { openFindings: number; historicalFindings: number; byCategory: Map<string, number> }
  >();
  for (const finding of historicalFindings) {
    const existing =
      hotspotMap.get(finding.path) || {
        openFindings: 0,
        historicalFindings: 0,
        byCategory: new Map<string, number>()
      };
    existing.historicalFindings += 1;
    if (finding.status === "open") existing.openFindings += 1;
    existing.byCategory.set(finding.category, (existing.byCategory.get(finding.category) || 0) + 1);
    hotspotMap.set(finding.path, existing);
  }

  const hotspots = Array.from(hotspotMap.entries())
    .map(([path, value]) => ({
      path,
      openFindings: value.openFindings,
      historicalFindings: value.historicalFindings,
      topCategories: Array.from(value.byCategory.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([category]) => category)
    }))
    .sort((a, b) => {
      if (b.openFindings !== a.openFindings) return b.openFindings - a.openFindings;
      return b.historicalFindings - a.historicalFindings;
    })
    .slice(0, 8);

  const reviewFocus = buildFocusHints({
    changedFileStats,
    hotspots,
    graphLinks
  });

  return {
    query,
    retrieved,
    relatedFiles,
    changedFileStats,
    graphLinks: graphLinks.slice(0, 40),
    hotspots,
    reviewFocus
  };
}

function buildDiffSignalSnippet(diffPatch: string): string {
  const lines = diffPatch.split("\n");
  const signalLines = lines
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---")
    )
    .slice(0, 140);
  return signalLines.join("\n").slice(0, 6000);
}

function buildFocusHints(params: {
  changedFileStats: ContextPack["changedFileStats"];
  hotspots: ContextPack["hotspots"];
  graphLinks: ContextPack["graphLinks"];
}): string[] {
  const hints: string[] = [];
  for (const file of params.changedFileStats.slice(0, 8)) {
    if (file.risk === "high") {
      hints.push(`High churn changed file: ${file.path} (prioritize correctness and regressions).`);
    } else if (file.risk === "medium") {
      hints.push(`Medium churn changed file: ${file.path} (check edge cases and tests).`);
    }
  }
  for (const hotspot of params.hotspots.slice(0, 5)) {
    if (hotspot.openFindings <= 0) continue;
    hints.push(
      `Historical hotspot: ${hotspot.path} has ${hotspot.openFindings} open finding(s) in categories ${hotspot.topCategories.join(", ") || "unknown"}.`
    );
  }
  for (const link of params.graphLinks.slice(0, 10)) {
    if (link.type !== "file_dep") continue;
    hints.push(`Cross-file dependency: ${link.from} depends on ${link.to}.`);
  }
  return Array.from(new Set(hints)).slice(0, 12);
}
