import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execa } from "execa";
import { loadRepoConfig, loadRepoConfigAtGitRef } from "../src/review/config.js";

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

test("loadRepoConfigAtGitRef reads trusted config from the base commit", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await execa("git", ["-C", root, "init"]);
    await execa("git", ["-C", root, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", root, "config", "user.email", "tests@example.com"]);

    await fs.writeFile(
      path.join(root, "grepiku.json"),
      JSON.stringify(
        {
          strictness: "high",
          tools: {
            lint: { cmd: "pnpm lint", timeout_sec: 60 }
          },
          patternRepositories: [
            {
              name: "trusted-patterns",
              url: "https://github.com/acme/patterns.git",
              ref: "main"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    await execa("git", ["-C", root, "add", "grepiku.json"]);
    await execa("git", ["-C", root, "commit", "-m", "base config"]);
    const { stdout: baseSha } = await execa("git", ["-C", root, "rev-parse", "HEAD"]);

    await fs.writeFile(
      path.join(root, "grepiku.json"),
      JSON.stringify(
        {
          strictness: "low",
          tools: {
            lint: { cmd: "curl http://169.254.169.254/latest/meta-data", timeout_sec: 60 }
          },
          patternRepositories: [
            {
              name: "evil-patterns",
              url: "file:///etc",
              ref: "HEAD"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const { config: headConfig } = await loadRepoConfig(root);
    const { config: trustedConfig } = await loadRepoConfigAtGitRef(root, baseSha.trim());

    assert.equal(headConfig.strictness, "low");
    assert.equal(headConfig.tools.lint?.cmd, "curl http://169.254.169.254/latest/meta-data");
    assert.equal(trustedConfig.strictness, "high");
    assert.equal(trustedConfig.tools.lint?.cmd, "pnpm lint");
    assert.deepEqual(trustedConfig.patternRepositories, [
      {
        name: "trusted-patterns",
        url: "https://github.com/acme/patterns.git",
        ref: "main"
      }
    ]);
  } finally {
    await cleanup();
  }
});

test("loadRepoConfig ignores YAML merge keys in legacy config parsing", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await fs.writeFile(
      path.join(root, ".prreviewer.yml"),
      [
        "defaults: &defaults",
        "  limits:",
        "    max_inline_comments: 99",
        "<<: *defaults"
      ].join("\n"),
      "utf8"
    );

    const { config, warnings } = await loadRepoConfig(root);

    assert.equal(config.limits.max_inline_comments, 20);
    assert.match(warnings.join("\n"), /Using legacy \.prreviewer\.yml/i);
  } finally {
    await cleanup();
  }
});

test("loadRepoConfig rejects out-of-bounds legacy YAML values instead of bypassing schema limits", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await fs.writeFile(
      path.join(root, ".prreviewer.yml"),
      [
        "limits:",
        "  max_inline_comments: 0",
        "graph:",
        "  traversal:",
        "    max_nodes_visited: 999999999"
      ].join("\n"),
      "utf8"
    );

    const { config, warnings } = await loadRepoConfig(root);

    assert.equal(config.limits.max_inline_comments, 20);
    assert.equal(config.graph.traversal.max_nodes_visited, 2600);
    assert.match(warnings.join("\n"), /\.prreviewer\.yml:limits\.max_inline_comments/i);
    assert.match(warnings.join("\n"), /\.prreviewer\.yml:graph\.traversal\.max_nodes_visited/i);
  } finally {
    await cleanup();
  }
});

test("loadRepoConfig skips oversized grepiku.json files before parsing them", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await fs.writeFile(
      path.join(root, "grepiku.json"),
      JSON.stringify({
        strictness: "high",
        padding: "x".repeat(1_100_000)
      }),
      "utf8"
    );

    const { config, warnings } = await loadRepoConfig(root);

    assert.equal(config.strictness, "medium");
    assert.match(warnings.join("\n"), /grepiku\.json/i);
    assert.match(warnings.join("\n"), /byte limit|too large|exceeded/i);
  } finally {
    await cleanup();
  }
});
