import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import yaml from "js-yaml";

test("docker-compose keeps Redis host exposure loopback-only", async () => {
  const raw = await fs.readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const parsed = yaml.load(raw) as { services?: Record<string, { ports?: unknown[] }> };
  const ports = parsed.services?.["grepiku-redis"]?.ports || [];

  for (const port of ports) {
    assert.match(String(port), /^127\.0\.0\.1:/);
  }
});

test("docker-compose does not force verbose codex stage streaming in the worker", async () => {
  const raw = await fs.readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const parsed = yaml.load(raw) as {
    services?: Record<string, { environment?: Record<string, unknown> }>;
  };
  const workerEnv = parsed.services?.worker?.environment || {};

  assert.notEqual(workerEnv.CODEX_STAGE_LOG_OUTPUT, "true");
});
