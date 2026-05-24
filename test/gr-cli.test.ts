import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __grInternals, formatGrResult, runGr } from "../src/tools/gr.js";

const contextPack = {
  retrieved: [
    { kind: "symbol", path: "src/service.ts", symbol: "createThread", score: 0.2, text: "creates a thread" },
    { kind: "file", path: "src/other.ts", score: 0.1, text: "unrelated" }
  ],
  reviewFocus: ["Medium-risk changed file: src/service.ts (check edge cases and tests)."],
  changedFileStats: [{ path: "src/service.ts", additions: 90, deletions: 2, risk: "medium" }],
  relatedFiles: ["src/repo.ts"],
  graphLinks: [{ from: "src/service.ts", to: "src/repo.ts", type: "file_dep" }],
  graphPaths: [{ path: "src/repo.ts", score: 0.7, via: ["src/service.ts --file_dep--> src/repo.ts"] }],
  hotspots: [{ path: "src/service.ts", openFindings: 1, historicalFindings: 2, topCategories: ["bug"] }],
  graphDebug: { seedNodes: 2, visitedNodes: 5 }
};

test("gr help describes only Grepiku-specific commands", async () => {
  const result = await runGr(["--help"]);
  const text = formatGrResult(result, false);

  assert.match(text, /gr retrieve <query>/);
  assert.match(text, /gr graph impact/);
  assert.match(text, /gr tests-for <path>/);
  assert.match(text, /Use normal shell tools/);
  assert.doesNotMatch(text, /wrap normal Unix/i);
});

test("gr subcommands read fixture context pack data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-gr-"));
  const bundleDir = path.join(root, "bundle");
  const repoDir = path.join(root, "repo");
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.mkdir(path.join(repoDir, "src", "__tests__"), { recursive: true });
  await fs.writeFile(path.join(bundleDir, "context_pack.json"), JSON.stringify(contextPack), "utf8");
  await fs.writeFile(path.join(bundleDir, "rules.json"), JSON.stringify([{ id: "thread", title: "Thread safety", pattern: "src/**" }]), "utf8");
  await fs.writeFile(path.join(repoDir, "src", "__tests__", "service.test.ts"), "test('service', () => {})", "utf8");

  const loadContext = () =>
    import("../src/tools/gr.js").then((mod) =>
      mod.loadGrContext({ contextPackPath: path.join(bundleDir, "context_pack.json"), bundleDir, repoPath: repoDir })
    );

  try {
    const retrieve = await runGr(["retrieve", "createThread", "--top-k", "1", "--json"], loadContext);
    assert.equal(retrieve.command, "retrieve");
    assert.equal((retrieve.data as any[])[0].path, "src/service.ts");

    const impact = await runGr(["graph", "impact", "--json"], loadContext);
    assert.deepEqual((impact.data as any).relatedFiles, ["src/repo.ts"]);

    const neighbors = await runGr(["graph", "neighbors", "src/service.ts", "--depth", "1", "--json"], loadContext);
    assert.equal((neighbors.data as any).links[0].to, "src/repo.ts");

    const symbol = await runGr(["symbol-context", "src/service.ts", "createThread", "--json"], loadContext);
    assert.equal((symbol.data as any).retrieved[0].symbol, "createThread");

    const rules = await runGr(["rules", "--path", "src/service.ts", "--json"], loadContext);
    assert.equal((rules.data as any[])[0].id, "thread");

    const risk = await runGr(["risk", "--path", "src/service.ts", "--json"], loadContext);
    assert.equal((risk.data as any).risk, "medium");
    assert.equal((risk.data as any).hotspots[0].openFindings, 1);

    const tests = await runGr(["tests-for", "src/service.ts", "--json"], loadContext);
    assert.equal((tests.data as any).tests[0].path, "src/__tests__/service.test.ts");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gr reports context fallback diagnostics in JSON output", async () => {
  const result = await runGr(["graph", "impact", "--json"], async () => {
    throw new Error("missing context pack");
  });

  assert.equal(result.status, "fallback");
  assert.match(result.diagnostics?.[0] || "", /context_pack fallback/);
  assert.match(formatGrResult(result, true), /missing context pack/);
});

const { retrieve, graphImpact, graphNeighbors, riskForPath } = __grInternals;

test("gr internals expose deterministic context helpers", () => {
  const ctx = { contextPack, bundleDir: "/bundle", repoPath: "/repo" } as any;
  assert.equal((retrieve(ctx, "createThread", 1)[0] as any).path, "src/service.ts");
  assert.equal((graphImpact(ctx).graphLinks as any[])[0].type, "file_dep");
  assert.equal((graphNeighbors(ctx, "src/service.ts", 1).links as any[])[0].to, "src/repo.ts");
  assert.equal(riskForPath(ctx, "src/service.ts").risk, "medium");
});
