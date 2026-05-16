import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

test("webhook route acknowledges ignored GitHub events so GitHub does not retry them", async () => {
  const { registerWebhookRoute } = await import("../src/server/webhookRoute.js");
  const app = Fastify();
  let handled = false;

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    done(null, body);
  });
  registerWebhookRoute(app, {
    resolveWebhookEvent: async ({ body }) => {
      const parsed = JSON.parse(body) as { action?: string };
      return parsed.action === "edited"
        ? null
        : ({
            provider: "github",
            type: "pull_request",
            action: "opened",
            repo: {
              externalId: "1",
              owner: "acme",
              name: "widgets",
              fullName: "acme/widgets"
            },
            pullRequest: {
              externalId: "2",
              number: 42,
              state: "open",
              headSha: "abc123"
            }
          } as const);
    },
    handleWebhookEvent: async () => {
      handled = true;
    }
  });

  try {
    const payload = JSON.stringify({
      action: "edited",
      comment: {
        body: "/review"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        "content-type": "application/json"
      },
      payload
    });

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { ok: true, ignored: true });
    assert.equal(handled, false);
  } finally {
    await app.close();
  }
});

test("webhook route returns 500 for internal processing errors instead of misreporting them as signature failures", async () => {
  const { registerWebhookRoute } = await import("../src/server/webhookRoute.js");
  const app = Fastify();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    done(null, body);
  });
  registerWebhookRoute(app, {
    resolveWebhookEvent: async () => ({
      provider: "github",
      type: "pull_request",
      action: "opened",
      repo: {
        externalId: "1",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets"
      },
      pullRequest: {
        externalId: "2",
        number: 42,
        state: "open",
        headSha: "abc123"
      }
    }),
    handleWebhookEvent: async () => {
      throw new Error("database unavailable");
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        "content-type": "application/json"
      },
      payload: JSON.stringify({ action: "opened" })
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "Webhook handling failed" });
  } finally {
    await app.close();
  }
});

test("webhook route ignores duplicate delivery ids after a successful handler run", async () => {
  const { registerWebhookRoute } = await import("../src/server/webhookRoute.js");
  const app = Fastify();
  let handled = 0;
  const claimed = new Set<string>();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    done(null, body);
  });
  registerWebhookRoute(app, {
    resolveWebhookEvent: async () => ({
      provider: "github",
      type: "pull_request",
      action: "opened",
      repo: {
        externalId: "1",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets"
      },
      pullRequest: {
        externalId: "2",
        number: 42,
        state: "open",
        headSha: "abc123"
      }
    }),
    handleWebhookEvent: async () => {
      handled += 1;
    },
    claimWebhookDelivery: async (deliveryId) => {
      if (claimed.has(deliveryId)) return false;
      claimed.add(deliveryId);
      return true;
    },
    completeWebhookDelivery: async () => undefined,
    releaseWebhookDelivery: async (deliveryId) => {
      claimed.delete(deliveryId);
    }
  });

  try {
    const request = {
      method: "POST" as const,
      url: "/webhooks",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1"
      },
      payload: JSON.stringify({ action: "opened" })
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { ok: true });
    assert.equal(second.statusCode, 202);
    assert.deepEqual(second.json(), { ok: true, ignored: true, duplicate: true });
    assert.equal(handled, 1);
  } finally {
    await app.close();
  }
});

test("webhook route releases claimed delivery ids when handler processing fails", async () => {
  const { registerWebhookRoute } = await import("../src/server/webhookRoute.js");
  const app = Fastify();
  let handled = 0;
  const claimed = new Set<string>();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    done(null, body);
  });
  registerWebhookRoute(app, {
    resolveWebhookEvent: async () => ({
      provider: "github",
      type: "pull_request",
      action: "opened",
      repo: {
        externalId: "1",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets"
      },
      pullRequest: {
        externalId: "2",
        number: 42,
        state: "open",
        headSha: "abc123"
      }
    }),
    handleWebhookEvent: async () => {
      handled += 1;
      throw new Error("database unavailable");
    },
    claimWebhookDelivery: async (deliveryId) => {
      if (claimed.has(deliveryId)) return false;
      claimed.add(deliveryId);
      return true;
    },
    completeWebhookDelivery: async () => undefined,
    releaseWebhookDelivery: async (deliveryId) => {
      claimed.delete(deliveryId);
    }
  });

  try {
    const request = {
      method: "POST" as const,
      url: "/webhooks",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-2"
      },
      payload: JSON.stringify({ action: "opened" })
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    assert.equal(first.statusCode, 500);
    assert.equal(second.statusCode, 500);
    assert.equal(handled, 2);
  } finally {
    await app.close();
  }
});

test("webhook route fails closed when replay-guard delivery claims are unavailable", async () => {
  const { registerWebhookRoute } = await import("../src/server/webhookRoute.js");
  const app = Fastify();
  let handled = false;

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    done(null, body);
  });
  registerWebhookRoute(app, {
    resolveWebhookEvent: async () => ({
      provider: "github",
      type: "pull_request",
      action: "opened",
      repo: {
        externalId: "1",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets"
      },
      pullRequest: {
        externalId: "2",
        number: 42,
        state: "open",
        headSha: "abc123"
      }
    }),
    handleWebhookEvent: async () => {
      handled = true;
    },
    claimWebhookDelivery: async () => {
      throw new Error("redis unavailable");
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-claim-error"
      },
      payload: JSON.stringify({ action: "opened" })
    });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: "Webhook replay guard unavailable" });
    assert.equal(handled, false);
  } finally {
    await app.close();
  }
});
