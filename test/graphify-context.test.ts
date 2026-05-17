import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildGraphifyImpact, __graphifyContextInternals } from "../src/review/graphifyContext.js";

test("graphifyGraphPath resolves under repo graphify-out", () => {
  assert.equal(
    __graphifyContextInternals.graphifyGraphPath("/tmp/demo-repo"),
    "/tmp/demo-repo/graphify-out/graph.json"
  );
});

test("buildGraphifyImpact converts review-context output into Grepiku graph impact shape", async () => {
  process.env.DATABASE_URL ||= "postgresql://unused";
  process.env.REDIS_URL ||= "redis://unused";
  process.env.GITHUB_APP_ID ||= "0";
  process.env.GITHUB_PRIVATE_KEY ||= "unused";
  process.env.GITHUB_WEBHOOK_SECRET ||= "unused";
  process.env.OPENAI_COMPAT_BASE_URL ||= "https://example.test/v1";
  process.env.OPENAI_COMPAT_API_KEY ||= "unused";
  process.env.PROJECT_ROOT ||= "/tmp/grepiku-test";

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-graphify-impact-"));
  const repoPath = path.join(root, "repo");
  const outDir = path.join(repoPath, "graphify-out");
  await fs.mkdir(outDir, { recursive: true });

  const graph = {
    directed: true,
    multigraph: false,
    graph: {},
    built_at_commit: "abc123",
    nodes: [
      { id: "api_file", label: "api.py", source_file: "src/api.py", community: 0 },
      { id: "api_handler", label: "handle_pr", source_file: "src/api.py", community: 0 },
      { id: "service_file", label: "service.py", source_file: "src/service.py", community: 0 },
      { id: "service_fn", label: "plan_context", source_file: "src/service.py", community: 0 },
      { id: "db_file", label: "db.py", source_file: "src/db.py", community: 1 },
      { id: "db_fn", label: "load_graph", source_file: "src/db.py", community: 1 }
      ,{ id: "helper_file", label: "helper.py", source_file: "internal_harness/helper.py", community: 2 }
    ],
    links: [
      { source: "api_handler", target: "service_fn", relation: "calls", confidence: "EXTRACTED" },
      { source: "service_fn", target: "db_fn", relation: "imports", confidence: "EXTRACTED" },
      { source: "api_file", target: "service_file", relation: "imports", confidence: "EXTRACTED" },
      { source: "service_file", target: "db_file", relation: "imports", confidence: "EXTRACTED" },
      { source: "api_file", target: "helper_file", relation: "calls", confidence: "EXTRACTED" }
    ]
  };
  await fs.writeFile(path.join(outDir, "graph.json"), JSON.stringify(graph, null, 2), "utf8");

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
    await fs.rm(root, { recursive: true, force: true });
  }
});
