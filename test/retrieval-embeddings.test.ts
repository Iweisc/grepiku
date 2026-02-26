import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/db/client.js";
import { loadRepoEmbeddings } from "../src/services/retrieval.js";

test("loadRepoEmbeddings keeps newest embeddings when capped", async () => {
  const totalEmbeddings = 100_000;
  let calls = 0;

  const originalFindMany = prisma.embedding.findMany;
  prisma.embedding.findMany = (async (args: any) => {
    calls += 1;
    assert.equal(args.where.repoId, 77);
    assert.deepEqual(args.where.kind.in, ["file", "symbol", "chunk"]);
    assert.equal(args.orderBy.id, "desc");

    const start = args.cursor ? Number(args.cursor.id) - 1 : totalEmbeddings;
    if (start <= 0) return [];

    const end = Math.max(1, start - args.take + 1);
    const rows = [];
    for (let id = start; id >= end; id -= 1) {
      rows.push({
        id,
        fileId: id,
        symbolId: null,
        kind: "file",
        vector: [id],
        text: `row-${id}`
      });
    }
    return rows;
  }) as typeof prisma.embedding.findMany;

  try {
    const rows = await loadRepoEmbeddings(77);
    assert.equal(rows.length, 80_000);
    assert.equal(rows[0]?.id, 100_000);
    assert.equal(rows[rows.length - 1]?.id, 20_001);
    assert.equal(rows.some((row) => row.id === 20_000), false);
    assert.equal(calls, 40);
  } finally {
    prisma.embedding.findMany = originalFindMany;
  }
});
