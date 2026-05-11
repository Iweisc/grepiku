import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import {
  gitCheckoutSafetyEnv,
  githubGitAuthEnv,
  githubHttpExtraHeaderConfig,
  githubRemoteUrl,
  sanitizeGithubGitAuthError
} from "../src/github/gitAuth.js";

test("githubRemoteUrl omits embedded installation credentials", () => {
  assert.equal(githubRemoteUrl({ owner: "acme", repo: "widgets" }), "https://github.com/acme/widgets.git");
});

test("githubHttpExtraHeaderConfig keeps the token out of the remote URL", () => {
  const config = githubHttpExtraHeaderConfig("secret-installation-token");

  assert.match(config, /^http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic /);
  assert.doesNotMatch(config, /secret-installation-token@github\.com/);
});

test("githubGitAuthEnv drops inherited git env state before injecting installation auth", () => {
  const env = githubGitAuthEnv("secret-installation-token", {
    PATH: "/usr/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.existing",
    GIT_CONFIG_VALUE_0: "kept",
    GIT_EXTERNAL_DIFF: "/tmp/evil-diff",
    GIT_DIR: "/tmp/evil-git-dir"
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.match(String(env.GIT_CONFIG_VALUE_0 || ""), /^AUTHORIZATION: basic /);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
  assert.equal(env.GIT_DIR, undefined);
});

test("gitCheckoutSafetyEnv drops inherited git env state while disabling git-lfs smudge during checkout", () => {
  const env = gitCheckoutSafetyEnv({
    PATH: "/usr/bin",
    PROJECT_ROOT: "/srv/grepiku",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.existing",
    GIT_CONFIG_VALUE_0: "kept",
    GIT_EXTERNAL_DIFF: "/tmp/evil-diff",
    GIT_DIR: "/tmp/evil-git-dir"
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, "1");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(env.HOME, path.join("/srv/grepiku", "var", "git-checkout-home"));
  assert.equal(env.XDG_CONFIG_HOME, path.join("/srv/grepiku", "var", "git-checkout-home", ".config"));
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "filter.lfs.process");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env.GIT_CONFIG_KEY_1, "filter.lfs.smudge");
  assert.equal(env.GIT_CONFIG_VALUE_1, "");
  assert.equal(env.GIT_CONFIG_KEY_2, "filter.lfs.required");
  assert.equal(env.GIT_CONFIG_VALUE_2, "false");
  assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
  assert.equal(env.GIT_DIR, undefined);
});

test("gitCheckoutSafetyEnv blocks env-injected git filters from running during checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-git-checkout-env-filter-"));
  const sourceRepo = path.join(root, "source");
  const projectRoot = path.join(root, "project");
  const clonePath = path.join(root, "clone");
  const markerPath = path.join(root, "filter-triggered.txt");
  const filterScriptPath = path.join(root, "filter.mjs");

  try {
    await fs.mkdir(sourceRepo, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });

    await execa("git", ["-C", sourceRepo, "init"]);
    await execa("git", ["-C", sourceRepo, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", sourceRepo, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(sourceRepo, ".gitattributes"), "payload.txt filter=pwn\n", "utf8");
    await fs.writeFile(path.join(sourceRepo, "payload.txt"), "hello\n", "utf8");
    await execa("git", ["-C", sourceRepo, "add", ".gitattributes", "payload.txt"]);
    await execa("git", ["-C", sourceRepo, "commit", "-m", "base"]);

    await fs.writeFile(
      filterScriptPath,
      [
        'import fs from "node:fs";',
        "const markerPath = process.argv[2];",
        'fs.appendFileSync(markerPath, "triggered\\n", "utf8");',
        "process.stdin.pipe(process.stdout);"
      ].join("\n"),
      "utf8"
    );

    const checkoutEnv = gitCheckoutSafetyEnv({
      PATH: process.env.PATH,
      PROJECT_ROOT: projectRoot,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.pwn.smudge",
      GIT_CONFIG_VALUE_0: `${process.execPath} ${filterScriptPath} ${markerPath}`
    });

    await execa("git", ["clone", "--no-local", "--no-checkout", "--", sourceRepo, clonePath], {
      env: checkoutEnv
    });
    await execa("git", ["-C", clonePath, "checkout", "--force", "HEAD"], {
      env: checkoutEnv
    });

    const triggered = await fs
      .stat(markerPath)
      .then(() => true)
      .catch(() => false);

    assert.equal(triggered, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gitCheckoutSafetyEnv blocks host git filter drivers from running during checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-git-checkout-filter-"));
  const sourceRepo = path.join(root, "source");
  const maliciousHome = path.join(root, "malicious-home");
  const projectRoot = path.join(root, "project");
  const clonePath = path.join(root, "clone");
  const markerPath = path.join(root, "filter-triggered.txt");
  const filterScriptPath = path.join(root, "filter.mjs");

  try {
    await fs.mkdir(sourceRepo, { recursive: true });
    await fs.mkdir(maliciousHome, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });

    await execa("git", ["-C", sourceRepo, "init"]);
    await execa("git", ["-C", sourceRepo, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", sourceRepo, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(sourceRepo, ".gitattributes"), "payload.txt filter=pwn\n", "utf8");
    await fs.writeFile(path.join(sourceRepo, "payload.txt"), "hello\n", "utf8");
    await execa("git", ["-C", sourceRepo, "add", ".gitattributes", "payload.txt"]);
    await execa("git", ["-C", sourceRepo, "commit", "-m", "base"]);

    await fs.writeFile(
      filterScriptPath,
      [
        'import fs from "node:fs";',
        "const markerPath = process.argv[2];",
        'fs.appendFileSync(markerPath, "triggered\\n", "utf8");',
        "process.stdin.pipe(process.stdout);"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(maliciousHome, ".gitconfig"),
      [
        '[filter "pwn"]',
        `    smudge = ${process.execPath} ${filterScriptPath} ${markerPath}`
      ].join("\n"),
      "utf8"
    );

    const checkoutEnv = gitCheckoutSafetyEnv({
      PATH: process.env.PATH,
      HOME: maliciousHome,
      XDG_CONFIG_HOME: path.join(maliciousHome, ".config"),
      PROJECT_ROOT: projectRoot
    });

    await execa("git", ["clone", "--no-local", "--no-checkout", "--", sourceRepo, clonePath], {
      env: checkoutEnv
    });
    await execa("git", ["-C", clonePath, "checkout", "--force", "HEAD"], {
      env: checkoutEnv
    });

    const triggered = await fs
      .stat(markerPath)
      .then(() => true)
      .catch(() => false);

    assert.equal(triggered, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sanitizeGithubGitAuthError redacts token-bearing git command fields", () => {
  const extraHeader = githubHttpExtraHeaderConfig("secret-installation-token");
  const error = Object.assign(
    new Error(`git failed with ${extraHeader}`),
    {
      shortMessage: `Command failed: git -c '${extraHeader}' fetch`,
      command: `git -c ${extraHeader} fetch`,
      escapedCommand: `git -c '${extraHeader}' fetch`
    }
  );

  const sanitized = sanitizeGithubGitAuthError(error) as Error & {
    shortMessage?: string;
    command?: string;
    escapedCommand?: string;
  };

  assert.doesNotMatch(sanitized.message, /AUTHORIZATION: basic [A-Za-z0-9+/=]+/);
  assert.match(sanitized.message, /\[REDACTED\]/);
  assert.doesNotMatch(String(sanitized.shortMessage || ""), /AUTHORIZATION: basic [A-Za-z0-9+/=]+/);
  assert.doesNotMatch(String(sanitized.command || ""), /AUTHORIZATION: basic [A-Za-z0-9+/=]+/);
  assert.doesNotMatch(String(sanitized.escapedCommand || ""), /AUTHORIZATION: basic [A-Za-z0-9+/=]+/);
});
