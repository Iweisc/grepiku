import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

function internalApiKey(): string {
  if (!process.env.INTERNAL_API_KEY) process.env.INTERNAL_API_KEY = "internal-api-test-key";
  return process.env.INTERNAL_API_KEY;
}

function ensureInternalApiTestEnv(): void {
  const required: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/grepiku_test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: "test-openai-key",
    PROJECT_ROOT: process.cwd(),
    INTERNAL_API_KEY: internalApiKey()
  };
  for (const [key, value] of Object.entries(required)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadInternalApiModule() {
  ensureInternalApiTestEnv();
  const [{ registerInternalApi }, { prisma }] = await Promise.all([
    import("../src/server/internal.js"),
    import("../src/db/client.js")
  ]);
  return { registerInternalApi, prisma };
}

test("internal retrieval rejects missing repoId before querying repo-scoped tables", async (t) => {
  const { registerInternalApi, prisma } = await loadInternalApiModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerInternalApi(app);

  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;
  let fileIndexCalled = false;
  let symbolCalled = false;
  let embeddingCalled = false;

  prisma.fileIndex.findMany = (async () => {
    fileIndexCalled = true;
    return [];
  }) as typeof prisma.fileIndex.findMany;
  prisma.symbol.findMany = (async () => {
    symbolCalled = true;
    return [];
  }) as typeof prisma.symbol.findMany;
  prisma.embedding.findMany = (async () => {
    embeddingCalled = true;
    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/internal/retrieval",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalApiKey()
      },
      payload: JSON.stringify({
        query: "review auth flow"
      })
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /invalid request body/i);
    assert.equal(fileIndexCalled, false);
    assert.equal(symbolCalled, false);
    assert.equal(embeddingCalled, false);
  } finally {
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
  }
});

test("internal retrieval rejects boolean repoId values", async (t) => {
  const { registerInternalApi, prisma } = await loadInternalApiModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerInternalApi(app);

  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;
  let fileIndexCalled = false;
  let symbolCalled = false;
  let embeddingCalled = false;

  prisma.fileIndex.findMany = (async () => {
    fileIndexCalled = true;
    return [];
  }) as typeof prisma.fileIndex.findMany;
  prisma.symbol.findMany = (async () => {
    symbolCalled = true;
    return [];
  }) as typeof prisma.symbol.findMany;
  prisma.embedding.findMany = (async () => {
    embeddingCalled = true;
    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/internal/retrieval",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalApiKey()
      },
      payload: JSON.stringify({
        repoId: true,
        query: "review auth flow"
      })
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /invalid request body/i);
    assert.equal(fileIndexCalled, false);
    assert.equal(symbolCalled, false);
    assert.equal(embeddingCalled, false);
  } finally {
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
  }
});

test("internal retrieval rejects oversized query strings before retrieval processing", async (t) => {
  const { registerInternalApi, prisma } = await loadInternalApiModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerInternalApi(app);

  const originalFileFindMany = prisma.fileIndex.findMany;
  const originalSymbolFindMany = prisma.symbol.findMany;
  const originalEmbeddingFindMany = prisma.embedding.findMany;
  let fileIndexCalled = false;
  let symbolCalled = false;
  let embeddingCalled = false;

  prisma.fileIndex.findMany = (async () => {
    fileIndexCalled = true;
    return [];
  }) as typeof prisma.fileIndex.findMany;
  prisma.symbol.findMany = (async () => {
    symbolCalled = true;
    return [];
  }) as typeof prisma.symbol.findMany;
  prisma.embedding.findMany = (async () => {
    embeddingCalled = true;
    return [];
  }) as typeof prisma.embedding.findMany;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/internal/retrieval",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalApiKey()
      },
      payload: JSON.stringify({
        repoId: 7,
        query: "q".repeat(2001)
      })
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /invalid request body/i);
    assert.equal(fileIndexCalled, false);
    assert.equal(symbolCalled, false);
    assert.equal(embeddingCalled, false);
  } finally {
    prisma.fileIndex.findMany = originalFileFindMany;
    prisma.symbol.findMany = originalSymbolFindMany;
    prisma.embedding.findMany = originalEmbeddingFindMany;
  }
});

test("internal trigger updates reject missing repoId before Prisma writes", async (t) => {
  const { registerInternalApi, prisma } = await loadInternalApiModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerInternalApi(app);

  const originalFindFirst = prisma.triggerSetting.findFirst;
  const originalUpdate = prisma.triggerSetting.update;
  const originalCreate = prisma.triggerSetting.create;
  let findFirstCalled = false;
  let updateCalled = false;
  let createCalled = false;

  prisma.triggerSetting.findFirst = (async () => {
    findFirstCalled = true;
    return null;
  }) as typeof prisma.triggerSetting.findFirst;
  prisma.triggerSetting.update = (async () => {
    updateCalled = true;
    throw new Error("should not update");
  }) as typeof prisma.triggerSetting.update;
  prisma.triggerSetting.create = (async () => {
    createCalled = true;
    throw new Error("should not create");
  }) as typeof prisma.triggerSetting.create;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/internal/triggers/update",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalApiKey()
      },
      payload: JSON.stringify({
        triggers: {
          manualOnly: true,
          allowAutoOnPush: false,
          labels: { include: [], exclude: [] },
          branches: { include: [], exclude: [] },
          authors: { include: [], exclude: [] },
          keywords: { include: [], exclude: [] },
          commentTriggers: ["/review"]
        }
      })
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /invalid request body/i);
    assert.equal(findFirstCalled, false);
    assert.equal(updateCalled, false);
    assert.equal(createCalled, false);
  } finally {
    prisma.triggerSetting.findFirst = originalFindFirst;
    prisma.triggerSetting.update = originalUpdate;
    prisma.triggerSetting.create = originalCreate;
  }
});

test("internal trigger updates reject malformed trigger configs", async (t) => {
  const { registerInternalApi, prisma } = await loadInternalApiModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerInternalApi(app);

  const originalFindFirst = prisma.triggerSetting.findFirst;
  const originalUpdate = prisma.triggerSetting.update;
  const originalCreate = prisma.triggerSetting.create;
  let findFirstCalled = false;
  let updateCalled = false;
  let createCalled = false;

  prisma.triggerSetting.findFirst = (async () => {
    findFirstCalled = true;
    return null;
  }) as typeof prisma.triggerSetting.findFirst;
  prisma.triggerSetting.update = (async () => {
    updateCalled = true;
    throw new Error("should not update");
  }) as typeof prisma.triggerSetting.update;
  prisma.triggerSetting.create = (async () => {
    createCalled = true;
    throw new Error("should not create");
  }) as typeof prisma.triggerSetting.create;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/internal/triggers/update",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalApiKey()
      },
      payload: JSON.stringify({
        repoId: 7,
        triggers: {
          manualOnly: "yes",
          allowAutoOnPush: false,
          labels: { include: [], exclude: [] },
          branches: { include: [], exclude: [] },
          authors: { include: [], exclude: [] },
          keywords: { include: [], exclude: [] },
          commentTriggers: "/review"
        }
      })
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /invalid request body/i);
    assert.equal(findFirstCalled, false);
    assert.equal(updateCalled, false);
    assert.equal(createCalled, false);
  } finally {
    prisma.triggerSetting.findFirst = originalFindFirst;
    prisma.triggerSetting.update = originalUpdate;
    prisma.triggerSetting.create = originalCreate;
  }
});
