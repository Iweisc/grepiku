import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";

const READ_ONLY_GIT_COMMANDS = new Set([
  "diff",
  "show",
  "log",
  "status",
  "ls-files",
  "grep",
  "blame",
  "rev-parse",
  "merge-base",
  "cat-file"
]);

const BLOCKED_GIT_COMMANDS = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
  "stash",
  "merge",
  "rebase",
  "cherry-pick",
  "fetch",
  "pull",
  "push",
  "worktree",
  "submodule",
  "config"
]);

const GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GLOBAL_OPTIONS_WITH_OPTIONAL_EQUALS = new Set(["--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GLOBAL_FLAGS = new Set([
  "--no-pager",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--bare"
]);

const WRITE_CAPABLE_OPTIONS = new Set(["--output", "-o"]);
const WRITE_CAPABLE_OPTION_PREFIXES = ["--output="];

export type GitWrapperDecision = {
  allowed: boolean;
  subcommand: string | null;
  reason?: string;
};

function isGlobalOptionWithInlineValue(arg: string): boolean {
  return Array.from(GLOBAL_OPTIONS_WITH_OPTIONAL_EQUALS).some((option) => arg.startsWith(`${option}=`));
}

export function resolveGitSubcommand(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--") {
      return args[index + 1] || null;
    }
    if (GLOBAL_FLAGS.has(arg) || isGlobalOptionWithInlineValue(arg)) {
      continue;
    }
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    return arg;
  }
  return null;
}

function hasWriteCapableOption(args: string[]): string | null {
  for (const arg of args) {
    if (WRITE_CAPABLE_OPTIONS.has(arg)) return arg;
    if (WRITE_CAPABLE_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix))) return arg;
  }
  return null;
}

export function decideReadOnlyGit(args: string[]): GitWrapperDecision {
  const subcommand = resolveGitSubcommand(args);
  if (!subcommand) {
    return { allowed: false, subcommand: null, reason: "missing or unsupported git subcommand" };
  }
  const writeOption = hasWriteCapableOption(args);
  if (writeOption) {
    return { allowed: false, subcommand, reason: `blocked write-capable git option: ${writeOption}` };
  }
  if (BLOCKED_GIT_COMMANDS.has(subcommand)) {
    return { allowed: false, subcommand, reason: `blocked mutating or network git command: ${subcommand}` };
  }
  if (!READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    return { allowed: false, subcommand, reason: `git command is not on the read-only allowlist: ${subcommand}` };
  }
  return { allowed: true, subcommand };
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function currentWrapperDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.GREPIKU_GIT_WRAPPER_DIR || "";
  if (configured.trim()) return path.resolve(configured);
  const invoked = process.argv[1];
  if (!invoked) return null;
  try {
    return path.dirname(fs.realpathSync(invoked));
  } catch {
    return path.dirname(path.resolve(invoked));
  }
}

export function resolveRealGitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GREPIKU_REAL_GIT_PATH || env.REAL_GIT_PATH || "";
  if (configured && isExecutable(configured)) return configured;

  const wrapperDir = currentWrapperDir(env);
  const pathEntries = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const resolvedEntry = path.resolve(entry);
    if (wrapperDir && resolvedEntry === wrapperDir) continue;
    const candidate = path.join(resolvedEntry, "git");
    if (isExecutable(candidate)) return candidate;
  }
  for (const candidate of ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"]) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error("unable to locate real git binary outside the wrapper PATH");
}

export async function runReadOnlyGitWrapper(args = process.argv.slice(2)): Promise<number> {
  const decision = decideReadOnlyGit(args);
  if (!decision.allowed) {
    process.stderr.write(`grepiku git wrapper: ${decision.reason}\n`);
    return 126;
  }

  const realGit = resolveRealGitPath();
  return await new Promise<number>((resolve) => {
    const child = spawn(realGit, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0"
      }
    });
    child.once("error", (error) => {
      process.stderr.write(`grepiku git wrapper: ${error.message}\n`);
      resolve(127);
    });
    child.once("close", (code) => resolve(Number.isInteger(code) ? code ?? 1 : 1));
  });
}

export const __readOnlyGitInternals = {
  READ_ONLY_GIT_COMMANDS,
  BLOCKED_GIT_COMMANDS,
  resolveGitSubcommand,
  decideReadOnlyGit,
  resolveRealGitPath
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  runReadOnlyGitWrapper().then((code) => {
    process.exitCode = code;
  });
}
