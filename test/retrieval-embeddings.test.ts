import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { prisma } from "../src/db/client.js";
import { loadRepoEmbeddings, retrieveContext } from "../src/services/retrieval.js";

test("loadRepoEmbeddings paginates through all embeddings without silent truncation", async () => {
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
    assert.equal(rows.length, totalEmbeddings);
    assert.equal(rows[0]?.id, 100_000);
    assert.equal(rows[rows.length - 1]?.id, 1);
    assert.equal(calls, 51);
  } finally {
    prisma.embedding.findMany = originalFindMany;
  }
});

test("retrieveContext caps pageindex candidates for large repositories", async () => {
  const totalEmbeddings = 20_000;
  const expectedCandidateCap = 2_000;
  const originalProjectRoot = process.env.PROJECT_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-retrieval-cap-"));
  const observedPath = path.join(tempRoot, "observed.json");
  const scriptPath = path.join(tempRoot, "src", "scripts", "pageindex_retrieve.py");

  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "PageIndex"), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "import argparse",
      "import json",
      "from pathlib import Path",
      "",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--input', required=True)",
      "args = parser.parse_args()",
      "payload = json.loads(Path(args.input).read_text(encoding='utf-8'))",
      "project_root = Path(__file__).resolve().parents[2]",
      "Path(project_root / 'observed.json').write_text(",
      "    json.dumps({'itemCount': len(payload.get('items') or [])}),",
      "    encoding='utf-8'",
      ")",
      "print(json.dumps({'results': []}))",
      ""
    ].join("\n"),
    "utf8"
  );

  process.env.PROJECT_ROOT = tempRoot;

  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;

  prisma.fileIndex.findMany = (async () => []) as typeof prisma.fileIndex.findMany;
  prisma.symbol.findMany = (async () => []) as typeof prisma.symbol.findMany;
  prisma.embedding.findMany = (async (args: any) => {
    if (args?.where?.repoId === 77) {
      const take = Number(args.take);
      const start = args.cursor ? Number(args.cursor.id) - 1 : totalEmbeddings;
      if (start <= 0) return [];

      const end = Math.max(1, start - take + 1);
      const rows = [];
      for (let id = start; id >= end; id -= 1) {
        rows.push({
          id,
          fileId: null,
          symbolId: null,
          kind: "file",
          text: `auth token row-${id}`
        });
      }
      return rows;
    }

    const selectedIds = args?.where?.id?.in;
    if (Array.isArray(selectedIds)) {
      return selectedIds.map((id: number) => ({
        id,
        text: `auth token row-${id}`
      }));
    }

    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const results = await retrieveContext({
      repoId: 77,
      query: "auth token",
      topK: 5
    });
    const observed = JSON.parse(await fs.readFile(observedPath, "utf8")) as {
      itemCount: number;
    };

    assert.equal(results.length, 5);
    assert.equal(observed.itemCount, expectedCandidateCap);
    assert.ok(observed.itemCount < totalEmbeddings);
  } finally {
    if (originalProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = originalProjectRoot;
    }
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("retrieveContext bounds total pageindex payload size for large candidate texts", async () => {
  const totalEmbeddings = 2_500;
  const expectedCandidateCap = 2_000;
  const oversizedText = "x".repeat(6_000);
  const originalProjectRoot = process.env.PROJECT_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-retrieval-byte-cap-"));
  const observedPath = path.join(tempRoot, "observed.json");
  const scriptPath = path.join(tempRoot, "src", "scripts", "pageindex_retrieve.py");

  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "PageIndex"), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "import argparse",
      "import json",
      "from pathlib import Path",
      "",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--input', required=True)",
      "args = parser.parse_args()",
      "payload = json.loads(Path(args.input).read_text(encoding='utf-8'))",
      "items = payload.get('items') or []",
      "project_root = Path(__file__).resolve().parents[2]",
      "Path(project_root / 'observed.json').write_text(",
      "    json.dumps({",
      "        'itemCount': len(items),",
      "        'totalTextBytes': sum(len((item.get('text') or '').encode('utf-8')) for item in items),",
      "    }),",
      "    encoding='utf-8'",
      ")",
      "print(json.dumps({'results': []}))",
      ""
    ].join("\n"),
    "utf8"
  );

  process.env.PROJECT_ROOT = tempRoot;

  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;

  prisma.fileIndex.findMany = (async () => []) as typeof prisma.fileIndex.findMany;
  prisma.symbol.findMany = (async () => []) as typeof prisma.symbol.findMany;
  prisma.embedding.findMany = (async (args: any) => {
    if (args?.where?.repoId === 79) {
      const take = Number(args.take);
      const start = args.cursor ? Number(args.cursor.id) - 1 : totalEmbeddings;
      if (start <= 0) return [];

      const end = Math.max(1, start - take + 1);
      const rows = [];
      for (let id = start; id >= end; id -= 1) {
        rows.push({
          id,
          fileId: null,
          symbolId: null,
          kind: "file",
          text: oversizedText
        });
      }
      return rows;
    }

    const selectedIds = args?.where?.id?.in;
    if (Array.isArray(selectedIds)) {
      return selectedIds.map((id: number) => ({
        id,
        text: oversizedText
      }));
    }

    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const results = await retrieveContext({
      repoId: 79,
      query: "oversized payload",
      topK: 5
    });
    const observed = JSON.parse(await fs.readFile(observedPath, "utf8")) as {
      itemCount: number;
      totalTextBytes: number;
    };

    assert.equal(results.length, 5);
    assert.ok(observed.itemCount < expectedCandidateCap);
    assert.ok(observed.totalTextBytes < expectedCandidateCap * oversizedText.length);
  } finally {
    if (originalProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = originalProjectRoot;
    }
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("retrieveContext avoids preloading full repo file and symbol metadata tables", async () => {
  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;
  const fileLookups: number[][] = [];
  const symbolLookups: number[][] = [];

  prisma.fileIndex.findMany = (async (args: any) => {
    const ids = args?.where?.id?.in;
    assert.ok(Array.isArray(ids), "expected file metadata lookup by id batch");
    assert.equal(args?.where?.repoId, 88);
    fileLookups.push([...ids]);
    return ids.map((id: number) => ({
      id,
      path: `src/file-${id}.ts`,
      isPattern: false
    }));
  }) as typeof prisma.fileIndex.findMany;

  prisma.symbol.findMany = (async (args: any) => {
    const ids = args?.where?.id?.in;
    assert.ok(Array.isArray(ids), "expected symbol metadata lookup by id batch");
    assert.equal(args?.where?.repoId, 88);
    symbolLookups.push([...ids]);
    return ids.map((id: number) => ({
      id,
      name: `symbol_${id}`
    }));
  }) as typeof prisma.symbol.findMany;

  prisma.embedding.findMany = (async (args: any) => {
    if (args?.where?.repoId === 88) {
      if (args.cursor) return [];
      return [
        {
          id: 3,
          fileId: 101,
          symbolId: null,
          kind: "file",
          text: "auth token handling"
        },
        {
          id: 2,
          fileId: 102,
          symbolId: 201,
          kind: "symbol",
          text: "token parser"
        },
        {
          id: 1,
          fileId: 103,
          symbolId: null,
          kind: "chunk",
          text: "secret rotation"
        }
      ];
    }

    const selectedIds = args?.where?.id?.in;
    if (Array.isArray(selectedIds)) {
      return selectedIds.map((id: number) => ({
        id,
        text: `selected-${id}`
      }));
    }

    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const results = await retrieveContext({
      repoId: 88,
      query: "token",
      topK: 3
    });

    assert.equal(results.length, 3);
    assert.deepEqual(fileLookups, [[101, 102, 103]]);
    assert.deepEqual(symbolLookups, [[201]]);
  } finally {
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
  }
});

test("retrieveContext uses stored vectors when ranking candidates", async () => {
  const originalFetch = globalThis.fetch;
  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;
  const originalEmbeddingFindFirst = prisma.embedding.findFirst;
  const originalEmbeddingCreate = prisma.embedding.create;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
        embeddings: [{ values: [1, 0] }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  prisma.fileIndex.findMany = (async (args: any) => {
    const ids = args?.where?.id?.in;
    assert.deepEqual(ids, [20, 10]);
    return [
      { id: 10, path: "src/low.ts", isPattern: false },
      { id: 20, path: "src/high.ts", isPattern: false }
    ];
  }) as typeof prisma.fileIndex.findMany;

  prisma.symbol.findMany = (async () => []) as typeof prisma.symbol.findMany;
  prisma.embedding.findFirst = (async () => null) as typeof prisma.embedding.findFirst;
  prisma.embedding.create = (async (args: any) => ({
    id: 99,
    fileId: null,
    symbolId: null,
    kind: "query",
    vector: args.data.vector,
    text: args.data.text,
    repoId: args.data.repoId,
    createdAt: new Date(),
    updatedAt: new Date()
  })) as typeof prisma.embedding.create;

  prisma.embedding.findMany = (async (args: any) => {
    if (args?.where?.repoId === 92) {
      if (args.cursor) return [];
      return [
        {
          id: 2,
          fileId: 20,
          symbolId: null,
          kind: "file",
          vector: [1, 0],
          text: "billing auth code"
        },
        {
          id: 1,
          fileId: 10,
          symbolId: null,
          kind: "file",
          vector: [0, 1],
          text: "billing auth code"
        }
      ];
    }

    const selectedIds = args?.where?.id?.in;
    if (Array.isArray(selectedIds)) {
      return selectedIds.map((id: number) => ({
        id,
        text: id === 2 ? "billing auth code high" : "billing auth code low"
      }));
    }

    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const results = await retrieveContext({
      repoId: 92,
      query: "unrelated query text",
      topK: 4
    });

    assert.equal(results[0]?.path, "src/high.ts");
    assert.equal(results[0]?.signals?.vector, 1);
  } finally {
    globalThis.fetch = originalFetch;
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
    prisma.embedding.findFirst = originalEmbeddingFindFirst;
    prisma.embedding.create = originalEmbeddingCreate;
  }
});

test("retrieveContext skips sensitive repo paths even if legacy embeddings still exist", async () => {
  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;

  prisma.fileIndex.findMany = (async (args: any) => {
    const ids = args?.where?.id?.in;
    assert.deepEqual(ids, [20, 10]);
    return [
      { id: 10, path: ".env", isPattern: false },
      { id: 20, path: "src/app.ts", isPattern: false }
    ];
  }) as typeof prisma.fileIndex.findMany;

  prisma.symbol.findMany = (async () => []) as typeof prisma.symbol.findMany;

  prisma.embedding.findMany = (async (args: any) => {
    if (args?.where?.repoId === 91) {
      if (args.cursor) return [];
      return [
        {
          id: 2,
          fileId: 20,
          symbolId: null,
          kind: "file",
          text: "token validation in app code"
        },
        {
          id: 1,
          fileId: 10,
          symbolId: null,
          kind: "file",
          text: "AWS_SECRET_ACCESS_KEY=super-secret"
        }
      ];
    }

    const selectedIds = args?.where?.id?.in;
    if (Array.isArray(selectedIds)) {
      return selectedIds.map((id: number) => ({
        id,
        text: id === 2 ? "token validation in app code" : "AWS_SECRET_ACCESS_KEY=super-secret"
      }));
    }

    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const results = await retrieveContext({
      repoId: 91,
      query: "token secret",
      topK: 5
    });

    assert.ok(results.some((item) => item.path === "src/app.ts"));
    assert.ok(!results.some((item) => item.path === ".env"));
  } finally {
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
  }
});
