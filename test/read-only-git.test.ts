import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __readOnlyGitInternals } from "../src/tools/readOnlyGit.js";

const { decideReadOnlyGit, resolveGitSubcommand, resolveRealGitPath } = __readOnlyGitInternals;

test("read-only git wrapper allows approved inspection commands", () => {
  for (const command of ["diff", "show", "log", "status", "ls-files", "grep", "blame", "rev-parse", "merge-base", "cat-file"]) {
    const decision = decideReadOnlyGit([command, "HEAD"]);
    assert.equal(decision.allowed, true, command);
    assert.equal(decision.subcommand, command);
  }
});

test("read-only git wrapper blocks mutating and network commands", () => {
  for (const command of ["add", "commit", "checkout", "switch", "restore", "reset", "clean", "stash", "merge", "rebase", "cherry-pick", "fetch", "pull", "push", "worktree", "submodule", "config"]) {
    const decision = decideReadOnlyGit([command]);
    assert.equal(decision.allowed, false, command);
    assert.match(decision.reason || "", /blocked|allowlist/);
  }
});

test("read-only git wrapper skips safe global options before the subcommand", () => {
  assert.equal(resolveGitSubcommand(["-C", "/repo", "--no-pager", "diff", "HEAD"]), "diff");
  assert.equal(resolveGitSubcommand(["--git-dir=/repo/.git", "status", "--short"]), "status");
  assert.equal(decideReadOnlyGit(["-C", "/repo", "fetch"]).allowed, false);
});

test("read-only git wrapper rejects unsupported commands and missing subcommands", () => {
  assert.equal(decideReadOnlyGit([]).allowed, false);
  assert.equal(decideReadOnlyGit(["remote", "-v"]).allowed, false);
  assert.equal(decideReadOnlyGit(["branch"]).allowed, false);
});


test("read-only git wrapper skips the configured wrapper directory when locating real git", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-git-wrapper-"));
  const wrapperDir = path.join(root, "bin");
  const realDir = path.join(root, "real");
  try {
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.mkdir(realDir, { recursive: true });
    const wrapperGit = path.join(wrapperDir, "git");
    const realGit = path.join(realDir, "git");
    await fs.writeFile(wrapperGit, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await fs.writeFile(realGit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.chmod(wrapperGit, 0o755);
    await fs.chmod(realGit, 0o755);

    assert.equal(
      resolveRealGitPath({
        PATH: [wrapperDir, realDir].join(path.delimiter),
        GREPIKU_GIT_WRAPPER_DIR: wrapperDir
      }),
      realGit
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
