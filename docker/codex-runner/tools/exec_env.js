import fs from "fs/promises";
import os from "os";
import path from "path";

const SAFE_COMMAND_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "TZ"
];
const SAFE_GIT_CONFIG_ENTRIES = [
  ["filter.lfs.process", ""],
  ["filter.lfs.smudge", ""],
  ["filter.lfs.required", "false"]
];

function applyIsolatedHomeEnv(output, homeDir) {
  if (!homeDir || !homeDir.trim()) {
    return output;
  }
  output.HOME = homeDir;
  output.XDG_CONFIG_HOME = `${homeDir}/.config`;
  output.XDG_CACHE_HOME = `${homeDir}/.cache`;
  output.XDG_STATE_HOME = `${homeDir}/.state`;
  output.TMPDIR = `${homeDir}/.tmp`;
  output.TMP = output.TMPDIR;
  output.TEMP = output.TMPDIR;
  return output;
}

export function buildRepoCommandEnv(sourceEnv = process.env, options = {}) {
  const output = { CI: "1" };
  for (const key of SAFE_COMMAND_ENV_KEYS) {
    const value = sourceEnv[key];
    if (typeof value === "string" && value.trim().length > 0) {
      output[key] = value;
    }
  }
  return applyIsolatedHomeEnv(output, options.homeDir);
}

export function createSerializedToolRunner() {
  let previous = Promise.resolve();

  return async function runSerialized(task) {
    const prior = previous.catch(() => undefined);
    let release;
    previous = new Promise((resolve) => {
      release = resolve;
    });

    await prior;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function appendGitConfigEntries(sourceEnv, entries) {
  const output = { ...sourceEnv };
  const currentCountRaw = Number(sourceEnv.GIT_CONFIG_COUNT || 0);
  let currentCount =
    Number.isInteger(currentCountRaw) && currentCountRaw >= 0 ? currentCountRaw : 0;
  for (const [key, value] of entries) {
    output[`GIT_CONFIG_KEY_${currentCount}`] = key;
    output[`GIT_CONFIG_VALUE_${currentCount}`] = value;
    currentCount += 1;
  }
  output.GIT_CONFIG_COUNT = String(currentCount);
  return output;
}

function stripInheritedGitEnv(sourceEnv) {
  const output = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value == null || key.startsWith("GIT_")) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function gitCheckoutHomeDir(sourceEnv, options = {}) {
  const configuredHomeDir =
    typeof options.homeDir === "string" ? options.homeDir.trim() : "";
  if (configuredHomeDir) {
    return path.resolve(configuredHomeDir);
  }
  const workOutRoot =
    typeof sourceEnv.WORK_OUT_ROOT === "string" ? sourceEnv.WORK_OUT_ROOT.trim() : "";
  if (workOutRoot) {
    return path.join(path.dirname(path.resolve(workOutRoot)), ".git-checkout-home");
  }
  return path.join(os.tmpdir(), "grepiku-git-checkout-home");
}

export function gitCheckoutSafetyEnv(sourceEnv = process.env, options = {}) {
  const checkoutHomeDir = gitCheckoutHomeDir(sourceEnv, options);
  const output = appendGitConfigEntries(stripInheritedGitEnv(sourceEnv), SAFE_GIT_CONFIG_ENTRIES);
  output.GIT_LFS_SKIP_SMUDGE = "1";
  output.GIT_CONFIG_NOSYSTEM = "1";
  output.GIT_CONFIG_GLOBAL = os.devNull;
  output.HOME = checkoutHomeDir;
  output.XDG_CONFIG_HOME = path.join(checkoutHomeDir, ".config");
  output.XDG_CACHE_HOME = path.join(checkoutHomeDir, ".cache");
  output.XDG_STATE_HOME = path.join(checkoutHomeDir, ".state");
  return output;
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function buildRepoCommandWorkspacePaths(outRoot, namespace = "verifier-workspace") {
  const resolvedOutRoot = path.resolve((outRoot || "/work/out").trim() || "/work/out");
  const stateRoot = path.join(path.dirname(resolvedOutRoot), `.${namespace}`);
  return {
    stateRoot,
    repoPath: path.join(stateRoot, "repo_rw"),
    homeDir: path.join(stateRoot, "repo_cmd_home")
  };
}

export function buildIsolatedRepoCloneArgs(sourceRepoPath, repoPath) {
  return [
    "clone",
    "--quiet",
    "--no-local",
    "--no-checkout",
    "--",
    sourceRepoPath,
    repoPath
  ];
}

export async function assertWorkspaceHasNoExternalSymlinks(rootDir, label = "workspace") {
  const resolvedRoot = await fs.realpath(rootDir);

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) {
        continue;
      }

      const linkTarget = await fs.readlink(entryPath);
      const lexicalTarget = path.resolve(
        path.dirname(entryPath),
        path.isAbsolute(linkTarget) ? linkTarget : linkTarget
      );
      if (!isWithinRoot(resolvedRoot, lexicalTarget)) {
        throw new Error(
          `blocked: repo symlink ${path.relative(rootDir, entryPath) || entry.name} resolves outside the ${label}`
        );
      }

      const realTarget = await fs.realpath(entryPath).catch((err) => {
        if (err?.code === "ENOENT") {
          return null;
        }
        throw err;
      });
      if (realTarget && !isWithinRoot(resolvedRoot, realTarget)) {
        throw new Error(
          `blocked: repo symlink ${path.relative(rootDir, entryPath) || entry.name} resolves outside the ${label}`
        );
      }
    }
  }

  await walk(rootDir);
}

export function buildSandboxedRepoCommandInvocation(params = {}) {
  const repoPath = typeof params.repoPath === "string" ? params.repoPath.trim() : "";
  const homeDir = typeof params.homeDir === "string" ? params.homeDir.trim() : "";
  const command = typeof params.command === "string" ? params.command : "";
  const writableRoots = Array.from(new Set([repoPath, homeDir].filter(Boolean)));
  const sandboxPolicy = JSON.stringify({
    type: "workspace-write",
    writable_roots: writableRoots,
    read_only_access: {
      type: "restricted",
      include_platform_defaults: true,
      readable_roots: []
    },
    network_access: false,
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: true
  });
  return {
    file: params.codexExecPath || "codex-exec",
    args: [
      "--sandbox-policy-cwd",
      repoPath,
      "--sandbox-policy",
      sandboxPolicy,
      "--use-bwrap-sandbox",
      "--",
      "/bin/sh",
      "-lc",
      command
    ],
    options: {
      argv0: "codex-linux-sandbox",
      cwd: repoPath,
      env: params.env,
      shell: false
    }
  };
}
