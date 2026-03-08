import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRepoConfig } from "../src/review/config.js";

async function makeTmpRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-config-"));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("loadRepoConfig repairs malformed grepiku.json before validation", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await fs.writeFile(
      path.join(root, "grepiku.json"),
      `{
  "tools": {
    "lint": { "cmd": "pnpm lint", "timeout_sec": 10 }
    "build": { "cmd": "pnpm build", "timeout_sec": 20 },
    "test": { "cmd": "pnpm test", "timeout_sec": 30 },
  },
  "limits": { "max_inline_comments": 7, "max_key_concerns": 3 }
}`
    );

    const { config, warnings } = await loadRepoConfig(root);

    assert.equal(config.tools.lint?.cmd, "pnpm lint");
    assert.equal(config.tools.build?.cmd, "pnpm build");
    assert.equal(config.tools.test?.cmd, "pnpm test");
    assert.equal(config.limits.max_inline_comments, 7);
    assert.match(warnings.join("\n"), /repaired malformed grepiku\.json/i);
  } finally {
    await cleanup();
  }
});

test("loadRepoConfig falls back to legacy config after invalid grepiku.json schema", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await fs.writeFile(
      path.join(root, "grepiku.json"),
      JSON.stringify({
        strictness: "extreme"
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "greptile.json"),
      JSON.stringify({
        strictness: "high",
        tools: {
          lint: { cmd: "npm run lint", timeout_sec: 15 }
        }
      }),
      "utf8"
    );

    const { config, warnings } = await loadRepoConfig(root);

    assert.equal(config.strictness, "high");
    assert.equal(config.tools.lint?.cmd, "npm run lint");
    assert.match(warnings.join("\n"), /config:grepiku\.json:strictness/i);
    assert.match(warnings.join("\n"), /Using legacy greptile\.json/i);
  } finally {
    await cleanup();
  }
});
