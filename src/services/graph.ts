import { prisma } from "../db/client.js";

type GraphJob = {
  repoId: number;
};

export async function processGraphJob(job: GraphJob) {
  const repoId = job.repoId;
  const files = await prisma.fileIndex.findMany({ where: { repoId } });
  const symbols = await prisma.symbol.findMany({ where: { repoId } });
  const refs = await prisma.symbolReference.findMany({ where: { repoId } });

  await prisma.graphEdge.deleteMany({ where: { repoId } });
  await prisma.graphNode.deleteMany({ where: { repoId } });

  const fileNodes = new Map<number, number>();
  for (const file of files) {
    const node = await prisma.graphNode.create({
      data: {
        repoId,
        type: "file",
        key: file.path,
        fileId: file.id
      }
    });
    fileNodes.set(file.id, node.id);
  }

  const symbolNodes = new Map<number, number>();
  const symbolFile = new Map<number, number>();
  const symbolByName = new Map<string, number[]>();
  for (const symbol of symbols) {
    const key = `${symbol.fileId}:${symbol.name}:${symbol.kind}`;
    const node = await prisma.graphNode.create({
      data: {
        repoId,
        type: "symbol",
        key,
        fileId: symbol.fileId,
        symbolId: symbol.id,
        data: {
          name: symbol.name,
          kind: symbol.kind,
          signature: symbol.signature
        }
      }
    });
    symbolNodes.set(symbol.id, node.id);
    symbolFile.set(symbol.id, symbol.fileId);
    const list = symbolByName.get(symbol.name) || [];
    list.push(node.id);
    symbolByName.set(symbol.name, list);

    const fileNodeId = fileNodes.get(symbol.fileId);
    if (fileNodeId) {
      await prisma.graphEdge.create({
        data: {
          repoId,
          fromNodeId: fileNodeId,
          toNodeId: node.id,
          type: "contains"
        }
      });
    }
  }

  for (const ref of refs) {
    const fromFileNode = fileNodes.get(ref.fileId);
    const targets = symbolByName.get(ref.refName) || [];
    for (const target of targets) {
      if (!fromFileNode) continue;
      await prisma.graphEdge.create({
        data: {
          repoId,
          fromNodeId: fromFileNode,
          toNodeId: target,
          type: "references",
          data: { line: ref.line }
        }
      });
      const targetSymbolId = [...symbolNodes.entries()].find(([_, nodeId]) => nodeId === target)?.[0];
      const targetFileId = targetSymbolId ? symbolFile.get(targetSymbolId) : null;
      const toFileNode = targetFileId ? fileNodes.get(targetFileId) : null;
      if (toFileNode && toFileNode !== fromFileNode) {
        await prisma.graphEdge.create({
          data: {
            repoId,
            fromNodeId: fromFileNode,
            toNodeId: toFileNode,
            type: "file_dep"
          }
        });
      }
    }
  }
}
