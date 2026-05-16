import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execa } from "execa";
import { loadRepoConfig } from "../src/review/config.js";
import { resolveRules } from "../src/review/triggers.js";

async function makeTmpRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-pattern-config-"));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("loadRepoConfig drops unsafe pattern repository clone targets", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await fs.writeFile(
      path.join(root, "grepiku.json"),
      JSON.stringify(
        {
          patternRepositories: [
            {
              name: "safe-patterns",
              url: "https://github.com/acme/patterns.git",
              ref: "main"
            },
            {
              name: "local-path",
              url: "/srv/grepiku/var/repos/other-org/private-repo"
            },
            {
              name: "metadata-ssrf",
              url: "http://169.254.169.254/latest/meta-data"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const { config, warnings } = await loadRepoConfig(root);

    assert.deepEqual(config.patternRepositories, [
      {
        name: "safe-patterns",
        url: "https://github.com/acme/patterns.git",
        ref: "main"
      }
    ]);
    assert.match(warnings.join("\n"), /patternRepositories\[1\]\.url/i);
    assert.match(warnings.join("\n"), /patternRepositories\[2\]\.url/i);
  } finally {
    await cleanup();
  }
});

test("resolveRules filters unsafe org-default pattern repositories", async () => {
  const { root, cleanup } = await makeTmpRepo();
  try {
    await fs.writeFile(path.join(root, "grepiku.json"), JSON.stringify({}), "utf8");
    const { config } = await loadRepoConfig(root);

    const resolved = resolveRules(config, {
      orgDefaults: {
        patternRepositories: [
          {
            name: "unsafe-local-path",
            url: "/srv/grepiku/var/repos/tenant-b/private-repo"
          },
          {
            name: "safe-patterns",
            url: "https://github.com/acme/patterns"
          }
        ]
      }
    });

    assert.deepEqual(resolved.patternRepositories, [
      {
        name: "safe-patterns",
        url: "https://github.com/acme/patterns"
      }
    ]);
  } finally {
    await cleanup();
  }
});

test("pattern repository helpers normalize only safe GitHub HTTPS URLs", async () => {
  const {
    normalizePatternRepositoryUrl,
    patternRepositoryDirName,
    resolvePatternRepositoryCheckoutTarget
  } = await import(
    "../src/review/patternRepositories.js"
  );

  assert.equal(
    normalizePatternRepositoryUrl("https://github.com/acme/patterns"),
    "https://github.com/acme/patterns"
  );
  assert.equal(
    normalizePatternRepositoryUrl("https://github.com/acme/patterns.git"),
    "https://github.com/acme/patterns.git"
  );
  assert.equal(normalizePatternRepositoryUrl("/srv/grepiku/var/repos/tenant-b/private-repo"), null);
  assert.equal(normalizePatternRepositoryUrl("file:///srv/grepiku/var/repos/tenant-b/private-repo"), null);
  assert.equal(normalizePatternRepositoryUrl("http://169.254.169.254/latest/meta-data"), null);
  assert.notEqual(
    patternRepositoryDirName({
      name: "shared-name",
      url: "https://github.com/acme/patterns"
    }),
    patternRepositoryDirName({
      name: "shared-name",
      url: "https://github.com/evil/patterns"
    })
  );
  assert.notEqual(
    patternRepositoryDirName({
      name: "shared-name",
      url: "https://github.com/acme/patterns",
      ref: "main"
    } as any),
    patternRepositoryDirName({
      name: "shared-name",
      url: "https://github.com/acme/patterns",
      ref: "release/1.0"
    } as any)
  );
  assert.equal(resolvePatternRepositoryCheckoutTarget(undefined), "origin/HEAD");
  assert.equal(resolvePatternRepositoryCheckoutTarget(" release/1.0 "), "release/1.0");
});

test("pattern repository checkout refs resolve to commits and reject option-like input", async () => {
  const { resolvePatternRepositoryCheckoutCommit } = await import(
    "../src/review/patternRepositories.js"
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-pattern-ref-"));
  const repoPath = path.join(root, "repo");

  try {
    await execa("git", ["init", repoPath]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(repoPath, "rules.txt"), "base\n", "utf8");
    await execa("git", ["-C", repoPath, "add", "rules.txt"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "base"]);
    await execa("git", ["-C", repoPath, "branch", "release/1.0"]);

    const { stdout: branchSha } = await execa("git", [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      "release/1.0"
    ]);

    assert.equal(
      await resolvePatternRepositoryCheckoutCommit({
        repoPath,
        ref: " release/1.0 "
      }),
      branchSha.trim()
    );

    await assert.rejects(
      () =>
        resolvePatternRepositoryCheckoutCommit({
          repoPath,
          ref: "--orphan injected-branch"
        }),
      /pattern repository ref/i
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pattern repository operations sharing the same scope are serialized", async () => {
  const { withPatternRepositoryLock } = await import("../src/review/patternRepositories.js");
  const events: string[] = [];
  let markFirstStarted: (() => void) | null = null;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst: (() => void) | null = null;
  const firstEntered = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withPatternRepositoryLock("https://github.com/acme/patterns.git\0main", async () => {
    events.push("first-start");
    markFirstStarted?.();
    await firstEntered;
    events.push("first-end");
  });
  const second = withPatternRepositoryLock("https://github.com/acme/patterns.git\0main", async () => {
    events.push("second-start");
    events.push("second-end");
  });

  await firstStarted;
  assert.deepEqual(events, ["first-start"]);

  releaseFirst?.();
  await Promise.all([first, second]);

  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});
