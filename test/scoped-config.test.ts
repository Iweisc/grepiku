import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  collectScopedConfigPaths,
  mergeScopedOverride,
  loadScopedConfig
} from "../src/review/config.js";
import type { RepoConfig } from "../src/review/config.js";

function makeRootConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    ignore: ["node_modules/**", "dist/**"],
    graph: {
      exclude_dirs: ["internal_harness"],
      traversal: {
        max_depth: 5,
        min_score: 0.07,
        max_related_files: 28,
        max_graph_links: 110,
        hard_include_files: 8,
        max_nodes_visited: 2600
      }
    },
    tools: {},
    limits: { max_inline_comments: 20, max_key_concerns: 5 },
    rules: [],
    scopes: [],
    patternRepositories: [],
    strictness: "medium",
    commentTypes: { allow: ["inline", "summary"] },
    output: {
      summaryOnly: false,
      destination: "both",
      syncSummaryWithStatus: true,
      allowIncrementalPrBodyUpdates: true
    },
    retrieval: {
      topK: 28,
      maxPerPath: 6,
      semanticWeight: 0.62,
      lexicalWeight: 0.22,
      rrfWeight: 0.08,
      changedPathBoost: 0.16,
      sameDirectoryBoost: 0.08,
      patternBoost: 0.03,
      symbolBoost: 0.02,
      chunkBoost: 0.03
    },
    statusChecks: { name: "Grepiku Review", required: false },
    triggers: {
      manualOnly: false,
      allowAutoOnPush: true,
      labels: { include: [], exclude: [] },
      branches: { include: [], exclude: [] },
      authors: { include: [], exclude: [] },
      keywords: { include: [], exclude: [] },
      commentTriggers: ["/review", "@grepiku"]
    },
    ...overrides
  };
}

async function makeTmpRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-scoped-"));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function writeConfig(dir: string, config: Record<string, unknown>): Promise<void> {
  const configDir = path.join(dir, ".grepiku");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify(config));
}

// --- collectScopedConfigPaths ---

test("collectScopedConfigPaths walks from file directory up to repo root", () => {
  const repoPath = "/repo";
  const filePath = "/repo/src/components/Button.tsx";
  const paths = collectScopedConfigPaths(repoPath, filePath);

  assert.deepEqual(paths, [
    path.join("/repo/src/components", ".grepiku", "config.json"),
    path.join("/repo/src", ".grepiku", "config.json")
  ]);
});

test("collectScopedConfigPaths returns empty for file at repo root", () => {
  const repoPath = "/repo";
  const filePath = "/repo/index.ts";
  const paths = collectScopedConfigPaths(repoPath, filePath);

  assert.deepEqual(paths, []);
});

test("collectScopedConfigPaths handles deeply nested paths", () => {
  const repoPath = "/repo";
  const filePath = "/repo/a/b/c/d/file.ts";
  const paths = collectScopedConfigPaths(repoPath, filePath);

  assert.equal(paths.length, 4);
  assert.equal(paths[0], path.join("/repo/a/b/c/d", ".grepiku", "config.json"));
  assert.equal(paths[3], path.join("/repo/a", ".grepiku", "config.json"));
});

// --- mergeScopedOverride ---

test("mergeScopedOverride overrides strictness", () => {
  const base = makeRootConfig({ strictness: "medium" });
  const merged = mergeScopedOverride(base, { strictness: "high" });

  assert.equal(merged.strictness, "high");
});

test("mergeScopedOverride overrides commentTypes", () => {
  const base = makeRootConfig();
  const merged = mergeScopedOverride(base, { commentTypes: { allow: ["summary"] } });

  assert.deepEqual(merged.commentTypes, { allow: ["summary"] });
});

test("mergeScopedOverride overrides ignore", () => {
  const base = makeRootConfig();
  const merged = mergeScopedOverride(base, { ignore: ["vendor/**"] });

  assert.deepEqual(merged.ignore, ["vendor/**"]);
});

test("mergeScopedOverride overrides limits partially", () => {
  const base = makeRootConfig({ limits: { max_inline_comments: 20, max_key_concerns: 5 } });
  const merged = mergeScopedOverride(base, { limits: { max_inline_comments: 10 } });

  assert.equal(merged.limits.max_inline_comments, 10);
  assert.equal(merged.limits.max_key_concerns, 5);
});

test("mergeScopedOverride overrides rules", () => {
  const base = makeRootConfig({ rules: [{ id: "r1", title: "Root rule" }] });
  const newRules = [{ id: "s1", title: "Scoped rule" }];
  const merged = mergeScopedOverride(base, { rules: newRules });

  assert.deepEqual(merged.rules, newRules);
});

test("mergeScopedOverride preserves non-overridable fields", () => {
  const base = makeRootConfig({
    output: { summaryOnly: true, destination: "comment", syncSummaryWithStatus: false, allowIncrementalPrBodyUpdates: false }
  });
  const merged = mergeScopedOverride(base, { strictness: "low" });

  assert.equal(merged.output.summaryOnly, true);
  assert.equal(merged.output.destination, "comment");
  assert.deepEqual(merged.graph, base.graph);
  assert.deepEqual(merged.tools, base.tools);
  assert.deepEqual(merged.retrieval, base.retrieval);
  assert.deepEqual(merged.triggers, base.triggers);
  assert.deepEqual(merged.statusChecks, base.statusChecks);
});

test("mergeScopedOverride with empty override returns base unchanged", () => {
  const base = makeRootConfig();
  const merged = mergeScopedOverride(base, {});

  assert.deepEqual(merged, base);
});

// --- loadScopedConfig (filesystem integration) ---

test("loadScopedConfig returns rootConfig when no scoped configs exist", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    const filePath = path.join(root, "src", "index.ts");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(filePath, "");

    const rootConfig = makeRootConfig();
    const result = await loadScopedConfig({ repoPath: root, filePath, rootConfig });

    assert.deepEqual(result, rootConfig);
  } finally {
    await cleanup();
  }
});

test("loadScopedConfig applies scoped override for allowed fields", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    const srcDir = path.join(root, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await writeConfig(srcDir, { strictness: "high", ignore: ["*.gen.ts"] });

    const filePath = path.join(srcDir, "index.ts");
    await fs.writeFile(filePath, "");

    const rootConfig = makeRootConfig();
    const result = await loadScopedConfig({ repoPath: root, filePath, rootConfig });

    assert.equal(result.strictness, "high");
    assert.deepEqual(result.ignore, ["*.gen.ts"]);
    // non-overridable fields preserved
    assert.deepEqual(result.output, rootConfig.output);
    assert.deepEqual(result.graph, rootConfig.graph);
  } finally {
    await cleanup();
  }
});

test("loadScopedConfig ignores non-overridable fields in scoped config", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    const srcDir = path.join(root, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await writeConfig(srcDir, {
      strictness: "low",
      graph: { exclude_dirs: ["hacked"] },
      tools: { lint: { cmd: "evil", timeout_sec: 1 } },
      output: { summaryOnly: true, destination: "pr_body" },
      retrieval: { topK: 99 },
      statusChecks: { name: "hacked", required: true },
      triggers: { manualOnly: true }
    });

    const filePath = path.join(srcDir, "index.ts");
    await fs.writeFile(filePath, "");

    const rootConfig = makeRootConfig();
    const result = await loadScopedConfig({ repoPath: root, filePath, rootConfig });

    // only strictness should be applied
    assert.equal(result.strictness, "low");
    // non-overridable fields must remain from rootConfig
    assert.deepEqual(result.graph, rootConfig.graph);
    assert.deepEqual(result.tools, rootConfig.tools);
    assert.deepEqual(result.output, rootConfig.output);
    assert.deepEqual(result.retrieval, rootConfig.retrieval);
    assert.deepEqual(result.statusChecks, rootConfig.statusChecks);
    assert.deepEqual(result.triggers, rootConfig.triggers);
  } finally {
    await cleanup();
  }
});

test("loadScopedConfig deepest config wins when multiple levels present", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    const srcDir = path.join(root, "src");
    const componentsDir = path.join(srcDir, "components");
    await fs.mkdir(componentsDir, { recursive: true });

    // parent: src/.grepiku/config.json
    await writeConfig(srcDir, { strictness: "low", limits: { max_inline_comments: 5 } });
    // child: src/components/.grepiku/config.json
    await writeConfig(componentsDir, { strictness: "high" });

    const filePath = path.join(componentsDir, "Button.tsx");
    await fs.writeFile(filePath, "");

    const rootConfig = makeRootConfig();
    const result = await loadScopedConfig({ repoPath: root, filePath, rootConfig });

    // deepest wins for strictness
    assert.equal(result.strictness, "high");
    // parent's limits still applied since deepest didn't override it
    assert.equal(result.limits.max_inline_comments, 5);
  } finally {
    await cleanup();
  }
});

test("loadScopedConfig skips malformed JSON in scoped config", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    const srcDir = path.join(root, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const configDir = path.join(srcDir, ".grepiku");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "config.json"), "not valid json {{{");

    const filePath = path.join(srcDir, "index.ts");
    await fs.writeFile(filePath, "");

    const rootConfig = makeRootConfig();
    const result = await loadScopedConfig({ repoPath: root, filePath, rootConfig });

    assert.deepEqual(result, rootConfig);
  } finally {
    await cleanup();
  }
});
