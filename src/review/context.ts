import { prisma } from "../db/client.js";
import { retrieveContext } from "../services/retrieval.js";

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
};

export async function buildContextPack(params: {
  repoId: number;
  diffPatch: string;
  changedFiles: Array<{ filename?: string; path?: string }>;
  topK?: number;
}): Promise<ContextPack> {
  const changedPaths = params.changedFiles
    .map((file) => file.filename || file.path)
    .filter((value): value is string => Boolean(value));
  const query = `${changedPaths.join("\n")}\n${params.diffPatch.slice(0, 4000)}`;

  const retrieved = await retrieveContext({
    repoId: params.repoId,
    query,
    topK: params.topK ?? 8
  });

  const fileNodes = await prisma.graphNode.findMany({
    where: { repoId: params.repoId, type: "file" }
  });
  const fileNodeIds = new Map<string, number>();
  for (const node of fileNodes) {
    fileNodeIds.set(node.key, node.id);
  }
  const relatedSet = new Set<string>();
  for (const path of changedPaths) {
    const nodeId = fileNodeIds.get(path);
    if (!nodeId) continue;
    const edges = await prisma.graphEdge.findMany({
      where: { repoId: params.repoId, fromNodeId: nodeId }
    });
    for (const edge of edges) {
      const target = fileNodes.find((node) => node.id === edge.toNodeId);
      if (target && target.key !== path) {
        relatedSet.add(target.key);
      }
    }
  }

  return {
    query,
    retrieved,
    relatedFiles: Array.from(relatedSet).slice(0, 10)
  };
}
