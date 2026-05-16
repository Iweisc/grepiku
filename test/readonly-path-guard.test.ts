import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("resolveAllowedPath allows paths inside an allowed root", async () => {
  const { resolveAllowedPath } = await import("../docker/codex-runner/tools/path_guard.js");
  const repoRoot = path.join("/tmp", "repo");
  const resolved = await resolveAllowedPath("src/index.ts", {
    baseRoot: repoRoot,
    roots: [repoRoot]
  });

  assert.equal(resolved, path.join(repoRoot, "src", "index.ts"));
});

test("resolveAllowedPath rejects sibling paths that only share a string prefix with the root", async () => {
  const { resolveAllowedPath } = await import("../docker/codex-runner/tools/path_guard.js");
  const repoRoot = path.join("/tmp", "repo");
  const escaped = path.join("/tmp", "repo-leak", "secret.txt");

  await assert.rejects(
    () =>
      resolveAllowedPath(escaped, {
        baseRoot: repoRoot,
        roots: [repoRoot]
      }),
    /Path escapes allowed roots/
  );
});

test("resolveAllowedPath rejects symlinks that resolve outside an allowed root", async () => {
  const { resolveAllowedPath } = await import("../docker/codex-runner/tools/path_guard.js");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-path-guard-"));
  const repoRoot = path.join(tmpRoot, "repo");
  const outsidePath = path.join(tmpRoot, "outside.txt");
  const symlinkPath = path.join(repoRoot, "leak.txt");

  await fs.mkdir(repoRoot, { recursive: true });
  await fs.writeFile(outsidePath, "secret", "utf8");
  await fs.symlink(outsidePath, symlinkPath);

  try {
    await assert.rejects(
      () =>
        resolveAllowedPath("leak.txt", {
          baseRoot: repoRoot,
          roots: [repoRoot]
        }),
      /Path escapes allowed roots/
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveAllowedPath canonicalizes in-root symlinks so sensitive target checks see the real path", async () => {
  const { resolveAllowedPath } = await import("../docker/codex-runner/tools/path_guard.js");
  const { shouldBlockSensitiveRepoPath } = await import(
    "../docker/codex-runner/tools/readonly_sensitive_paths.js"
  );
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-path-guard-"));
  const repoRoot = path.join(tmpRoot, "repo");
  const docsDir = path.join(repoRoot, "docs");
  const secretPath = path.join(repoRoot, ".env");
  const aliasPath = path.join(docsDir, "visible.txt");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(secretPath, "API_KEY=super-secret\n", "utf8");
  await fs.symlink(secretPath, aliasPath);

  try {
    const resolved = await resolveAllowedPath("docs/visible.txt", {
      baseRoot: repoRoot,
      roots: [repoRoot]
    });
    const repoRelative = path.relative(repoRoot, resolved).replace(/\\/g, "/");

    assert.equal(repoRelative, ".env");
    assert.equal(shouldBlockSensitiveRepoPath(repoRelative), true);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("buildReadonlySearchArgs terminates ripgrep options before the query pattern", async () => {
  const { buildReadonlySearchArgs } = await import("../docker/codex-runner/tools/readonly_args.js");

  assert.deepEqual(
    buildReadonlySearchArgs({
      query: "--files",
      searchRoot: "/tmp/repo"
    }),
    [
      "--json",
      "--color",
      "never",
      "--max-count",
      "50",
      "--max-columns",
      "400",
      "--max-columns-preview",
      "--",
      "--files",
      "/tmp/repo"
    ]
  );
});
