import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function setupGraphifyTestEnv() {
  process.env.DATABASE_URL ||= "postgresql://unused";
  process.env.REDIS_URL ||= "redis://unused";
  process.env.GITHUB_APP_ID ||= "0";
  process.env.GITHUB_PRIVATE_KEY ||= "unused";
  process.env.GITHUB_WEBHOOK_SECRET ||= "unused";
  process.env.OPENAI_COMPAT_BASE_URL ||= "https://example.test/v1";
  process.env.OPENAI_COMPAT_API_KEY ||= "unused";
  process.env.PROJECT_ROOT ||= path.join(os.tmpdir(), "grepiku-test");
}

async function loadGraphifyContext() {
  setupGraphifyTestEnv();
  return await import("../src/review/graphifyContext.js");
}

test("graphifyGraphPath resolves outside the repo checkout", async () => {
  const { __graphifyContextInternals } = await loadGraphifyContext();
  const repoPath = "/tmp/demo-repo";
  const outDir = __graphifyContextInternals.graphifyOutDir(repoPath);
  const graphPath = __graphifyContextInternals.graphifyGraphPath(repoPath);

  assert.equal(graphPath, path.join(outDir, "graph.json"));
  assert.equal(path.relative(repoPath, outDir).startsWith(".."), true);
  assert.match(outDir, /var\/graphify\//);
});

test("copies repo-local Graphify output into Grepiku cache when Graphify ignores GRAPHIFY_OUT", async () => {
  const { __graphifyContextInternals } = await loadGraphifyContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-graphify-cache-copy-"));
  const repoPath = path.join(root, "repo");
  const graphPath = __graphifyContextInternals.graphifyGraphPath(repoPath);
  const repoLocalGraphPath = __graphifyContextInternals.graphifyRepoLocalGraphPath(repoPath);

  await fs.mkdir(path.dirname(repoLocalGraphPath), { recursive: true });
  await fs.writeFile(repoLocalGraphPath, JSON.stringify({ nodes: [{ id: "a" }], links: [] }), "utf8");

  try {
    const copied = await __graphifyContextInternals.copyRepoLocalGraphToCacheIfPresent(repoPath, graphPath);
    assert.equal(copied, true);
    assert.deepEqual(JSON.parse(await fs.readFile(graphPath, "utf8")), { nodes: [{ id: "a" }], links: [] });
  } finally {
    await fs.rm(path.dirname(graphPath), { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGraphifyImpact converts review-context output into Grepiku graph impact shape", async () => {
  const { buildGraphifyImpact, __graphifyContextInternals } = await loadGraphifyContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-graphify-impact-"));
  const repoPath = path.join(root, "repo");
  const graphPath = __graphifyContextInternals.graphifyGraphPath(repoPath);
  const graphDir = path.dirname(graphPath);
  const fakePythonBin = path.join(root, "fake-graphify-python.js");
  const previousPythonBin = process.env.GRAPHIFY_PYTHON_BIN;

  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(graphDir, { recursive: true });
  await fs.writeFile(
    graphPath,
    JSON.stringify({ built_at_commit: "abc123", nodes: [], links: [] }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    fakePythonBin,
    `#!/usr/bin/env node
const output = {
  changed_files: ["src/api.py"],
  summary: { seed_nodes: 1, visited_nodes: 3, max_depth: 4, max_related_files: 8 },
  related_files: [
    { path: "src/service.py", score: 0.9, depth: 1, via: ["src/api.py -> src/service.py"] },
    { path: "src/db.py", score: 0.6, depth: 2, via: ["src/service.py -> src/db.py"] },
    { path: "internal_harness/helper.py", score: 0.8, depth: 1, via: [] }
  ],
  graph_links: [
    { from: "src/api.py", to: "src/service.py", relation: "imports", score: 0.9 },
    { from: "src/service.py", to: "src/db.py", relation: "imports", score: 0.6 },
    { from: "src/api.py", to: "internal_harness/helper.py", relation: "calls", score: 0.8 }
  ]
};
process.stdout.write(JSON.stringify(output));
`,
    { mode: 0o755 }
  );
  process.env.GRAPHIFY_PYTHON_BIN = fakePythonBin;

  try {
    const impact = await buildGraphifyImpact({
      repoPath,
      headSha: "abc123",
      changedFiles: ["src/api.py"],
      graph: {
        exclude_dirs: ["internal_harness"],
        traversal: {
          max_depth: 4,
          min_score: 0.5,
          max_related_files: 8,
          max_graph_links: 16,
          hard_include_files: 4,
          max_nodes_visited: 400
        }
      }
    });

    assert.equal(impact.rankedFiles.length > 0, true);
    assert.equal(impact.rankedFiles[0]?.path, "src/service.py");
    assert.equal(impact.rankedFiles.some((item) => item.path === "internal_harness/helper.py"), false);
    assert.equal(impact.linkCandidates.some((item) => item.from === "src/api.py" && item.to === "src/service.py"), true);
    assert.equal(impact.linkCandidates.some((item) => item.type === "file_dep" || item.type === "file_dep_inferred"), true);
    assert.equal(impact.debug.seedNodes > 0, true);
    assert.equal(impact.debug.minScore, 0.5);
    assert.equal(impact.options.max_related_files, 8);
  } finally {
    if (previousPythonBin === undefined) {
      delete process.env.GRAPHIFY_PYTHON_BIN;
    } else {
      process.env.GRAPHIFY_PYTHON_BIN = previousPythonBin;
    }
    await fs.rm(graphDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
