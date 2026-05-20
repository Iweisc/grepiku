import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import type { MentionChecksOutput } from "../review/schemas.js";
import type { RepoConfig, ToolConfig } from "../review/config.js";
import {
  SANDBOX_OUT_PATH,
  SANDBOX_REPO_PATH,
  SANDBOX_TASK_PATH,
  type SandboxTask,
  type SandboxTaskResult
} from "./task.js";

const SAFE_TOOL_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "TZ"
] as const;

type ToolName = "lint" | "build" | "test";
type MentionToolResult = MentionChecksOutput["checks"]["lint"];

function buildToolEnv(): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { CI: "1", HOME: "/work/tool-home" };
  for (const key of SAFE_TOOL_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      output[key] = value;
    }
  }
  output.XDG_CONFIG_HOME = "/work/tool-home/.config";
  output.XDG_CACHE_HOME = "/work/tool-home/.cache";
  output.XDG_STATE_HOME = "/work/tool-home/.state";
  output.TMPDIR = "/work/tool-home/.tmp";
  output.TMP = output.TMPDIR;
  output.TEMP = output.TMPDIR;
  return output;
}

function resultForExit(params: {
  exitCode: number | null;
  timedOut: boolean;
  hadStderr: boolean;
  timeoutSec: number;
}): MentionToolResult {
  const topErrors = params.hadStderr && (params.timedOut || params.exitCode !== 0)
    ? ["stderr output suppressed for security"]
    : [];
  if (params.timedOut) {
    return {
      status: "timeout",
      summary: `timed out after ${params.timeoutSec}s`,
      top_errors: topErrors
    };
  }
  if (params.exitCode === 0) {
    return { status: "pass", summary: "success", top_errors: [] };
  }
  return {
    status: "fail",
    summary: `exited with ${Number.isInteger(params.exitCode) ? params.exitCode : 1}`,
    top_errors: topErrors
  };
}

async function runTool(toolConfig: ToolConfig | undefined): Promise<MentionToolResult> {
  if (!toolConfig?.cmd) {
    return { status: "skipped", summary: "not configured", top_errors: [] };
  }
  const timeoutSec = Math.max(1, Math.floor(toolConfig.timeout_sec || 600));
  await fs.mkdir("/work/tool-home/.tmp", { recursive: true });
  return await new Promise<MentionToolResult>((resolve) => {
    const child = spawn("/bin/sh", ["-lc", toolConfig.cmd], {
      cwd: SANDBOX_REPO_PATH,
      env: buildToolEnv(),
      detached: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let hadStderr = false;
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      resolve(resultForExit({ exitCode: child.exitCode, timedOut: true, hadStderr, timeoutSec }));
    }, timeoutSec * 1000);
    child.stderr.on("data", () => {
      hadStderr = true;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: "error", summary: error.message, top_errors: [] });
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(resultForExit({ exitCode, timedOut: false, hadStderr, timeoutSec }));
    });
  });
}

async function runMentionChecks(tools: RepoConfig["tools"]): Promise<MentionChecksOutput> {
  const checks = {} as Record<ToolName, MentionToolResult>;
  for (const name of ["lint", "build", "test"] as ToolName[]) {
    checks[name] = await runTool(tools[name]);
  }
  const output = { checks } as MentionChecksOutput;
  await fs.mkdir(SANDBOX_OUT_PATH, { recursive: true });
  await fs.writeFile(path.join(SANDBOX_OUT_PATH, "mention_checks.json"), JSON.stringify(output, null, 2), "utf8");
  return output;
}

async function main(): Promise<void> {
  const task = JSON.parse(await fs.readFile(SANDBOX_TASK_PATH, "utf8")) as SandboxTask;
  let result: SandboxTaskResult;
  if (task.kind === "codex-stage" || task.kind === "mention-implementation-sync") {
    const { runCodexStageLocal } = await import("../runner/codexRunner.js");
    result = { metrics: await runCodexStageLocal(task.params) };
  } else if (task.kind === "direct-model-stage") {
    const { runDirectModelStageLocal } = await import("../runner/directModelRunner.js");
    result = { metrics: await runDirectModelStageLocal(task.params) };
  } else if (task.kind === "mention-checks") {
    result = { mentionChecks: await runMentionChecks(task.tools) };
  } else {
    throw new Error(`unknown sandbox task kind: ${(task as { kind?: string }).kind}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
