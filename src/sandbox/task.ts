import type { CodexRunParams, CodexStageMetrics } from "../runner/codexRunner.js";
import type { DirectModelRunParams } from "../runner/directModelRunner.js";
import type { MentionChecksOutput } from "../review/schemas.js";
import type { RepoConfig } from "../review/config.js";

export const SANDBOX_REPO_PATH = "/work/repo";
export const SANDBOX_BUNDLE_PATH = "/work/bundle";
export const SANDBOX_OUT_PATH = "/work/out";
export const SANDBOX_CODEX_HOME_PATH = "/work/codex-home";
export const SANDBOX_TASK_PATH = "/work/task.json";

export type SandboxTaskKind =
  | "codex-stage"
  | "direct-model-stage"
  | "mention-checks"
  | "mention-implementation-sync";

export type SandboxCodexTask = {
  kind: "codex-stage" | "mention-implementation-sync";
  params: CodexRunParams;
};

export type SandboxDirectModelTask = {
  kind: "direct-model-stage";
  params: DirectModelRunParams;
};

export type SandboxMentionChecksTask = {
  kind: "mention-checks";
  tools: RepoConfig["tools"];
};

export type SandboxTask =
  | SandboxCodexTask
  | SandboxDirectModelTask
  | SandboxMentionChecksTask;

export type SandboxTaskResult = {
  metrics?: CodexStageMetrics;
  mentionChecks?: MentionChecksOutput;
};
