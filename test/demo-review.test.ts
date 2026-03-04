import test from "node:test";
import assert from "node:assert/strict";
import { __demoReviewInternals } from "../src/tools/demoReview.js";

const { parseCliArgs, buildEmptyContextPack } = __demoReviewInternals;

test("parseCliArgs parses --repo-path correctly", () => {
  const args = parseCliArgs(["--repo-path=/tmp/my-repo"]);
  assert.equal(args.repoPath, "/tmp/my-repo");
  assert.equal(args.format, "json");
});

test("parseCliArgs parses all flags", () => {
  const args = parseCliArgs([
    "--repo-path=/tmp/repo",
    "--base=abc123",
    "--head=def456",
    "--diff-file=/tmp/diff.patch",
    "--output=/tmp/out.json",
    "--format=text"
  ]);
  assert.equal(args.repoPath, "/tmp/repo");
  assert.equal(args.base, "abc123");
  assert.equal(args.head, "def456");
  assert.equal(args.diffFile, "/tmp/diff.patch");
  assert.equal(args.output, "/tmp/out.json");
  assert.equal(args.format, "text");
});

test("parseCliArgs defaults format to json", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo"]);
  assert.equal(args.format, "json");
  assert.equal(args.base, undefined);
  assert.equal(args.head, undefined);
  assert.equal(args.diffFile, undefined);
  assert.equal(args.output, undefined);
});

test("parseCliArgs throws on missing required --repo-path", () => {
  assert.throws(() => parseCliArgs([]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on missing --repo-path with other flags", () => {
  assert.throws(() => parseCliArgs(["--base=abc", "--head=def"]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on invalid format value", () => {
  assert.throws(() => parseCliArgs(["--repo-path=/tmp/repo", "--format=xml"]), {
    name: "ZodError"
  });
});

test("parseCliArgs accepts format=json explicitly", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--format=json"]);
  assert.equal(args.format, "json");
});

test("parseCliArgs accepts format=text explicitly", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--format=text"]);
  assert.equal(args.format, "text");
});

test("parseCliArgs ignores unknown flags", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--unknown=value", "--verbose"]);
  assert.equal(args.repoPath, "/tmp/repo");
  assert.equal(args.format, "json");
});

test("buildEmptyContextPack returns empty retrieval and graph data", () => {
  const pack = buildEmptyContextPack("diff content", [{ path: "src/index.ts" }]);
  assert.equal(pack.retrieved.length, 0);
  assert.equal(pack.relatedFiles.length, 0);
  assert.equal(pack.graphLinks.length, 0);
  assert.equal(pack.graphPaths.length, 0);
  assert.equal(pack.hotspots.length, 0);
  assert.equal(pack.reviewFocus.length, 0);
  assert.equal(pack.changedFileStats.length, 1);
  assert.equal(pack.changedFileStats[0].path, "src/index.ts");
  assert.equal(pack.changedFileStats[0].risk, "low");
  assert.equal(pack.graphDebug.seedNodes, 0);
  assert.equal(pack.graphDebug.traversalMs, 0);
});

test("buildEmptyContextPack handles multiple changed files", () => {
  const pack = buildEmptyContextPack("", [
    { path: "a.ts" },
    { path: "b.ts" },
    { path: "c.ts" }
  ]);
  assert.equal(pack.changedFileStats.length, 3);
  assert.equal(pack.changedFileStats[0].path, "a.ts");
  assert.equal(pack.changedFileStats[1].path, "b.ts");
  assert.equal(pack.changedFileStats[2].path, "c.ts");
});
