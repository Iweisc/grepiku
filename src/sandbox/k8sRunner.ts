import fs from "fs/promises";
import { createWriteStream } from "fs";
import os from "os";
import path from "path";
import { PassThrough, Readable, Writable } from "stream";
import { pipeline } from "stream/promises";
import { once } from "events";
import { execa } from "execa";
import {
  CoreV1Api,
  Exec,
  KubeConfig,
  type V1Pod,
  type V1Status
} from "@kubernetes/client-node";
import { loadEnv, type Env } from "../config/env.js";
import type { CodexRunParams, CodexStageMetrics } from "../runner/codexRunner.js";
import type { DirectModelRunParams } from "../runner/directModelRunner.js";
import type { MentionChecksOutput } from "../review/schemas.js";
import type { RepoConfig } from "../review/config.js";
import {
  collectLocalTreeEntries,
  syncSandboxRepoBack,
  validateTarEntryPath,
  validateSymlinkTarget,
  type LocalTreeEntry
} from "./transfer.js";
import {
  SANDBOX_BUNDLE_PATH,
  SANDBOX_CODEX_HOME_PATH,
  SANDBOX_OUT_PATH,
  SANDBOX_REPO_PATH,
  SANDBOX_TASK_PATH,
  type SandboxTask,
  type SandboxTaskResult
} from "./task.js";

const SERVICE_ACCOUNT_NAMESPACE_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
const SANDBOX_CONTAINER_NAME = "sandbox";
const SANDBOX_WORK_VOLUME_NAME = "workdir";
const SANDBOX_TRANSFER_TIMEOUT_MS = 120_000;

type KubernetesSandboxRequest = {
  task: SandboxTask;
  localRepoPath?: string;
  localBundleDir?: string;
  localOutDir: string;
  syncRepoBack?: boolean;
  includeGit?: boolean;
};

type SandboxUploadPlanEntry = {
  sourceDir: string;
  targetDir: string;
  excludeGit: boolean;
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

function sanitizePodNamePart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 40) || "task"
  );
}

export function shouldUseKubernetesSandbox(env: Pick<Env, "sandboxExecutionMode">): boolean {
  return env.sandboxExecutionMode === "kubernetes";
}

function sandboxImage(env: Env): string {
  if (env.k8sSandboxImage) return env.k8sSandboxImage;
  throw new Error("K8S_SANDBOX_IMAGE is required when SANDBOX_EXECUTION_MODE=kubernetes");
}

async function resolveNamespace(env: Env): Promise<string> {
  if (env.k8sNamespace) return env.k8sNamespace;
  const namespace = await fs
    .readFile(SERVICE_ACCOUNT_NAMESPACE_PATH, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (namespace) return namespace;
  throw new Error("K8S_NAMESPACE is required outside an in-cluster service account");
}

function baseSandboxEnv(env: Env): Array<{ name: string; value: string }> {
  return [
    { name: "NODE_ENV", value: "production" },
    { name: "SANDBOX_EXECUTION_MODE", value: "local" },
    { name: "PROJECT_ROOT", value: "/app" },
    { name: "DATABASE_URL", value: "unused://sandbox" },
    { name: "REDIS_URL", value: "redis://unused" },
    { name: "GITHUB_APP_ID", value: "0" },
    { name: "GITHUB_PRIVATE_KEY", value: "unused" },
    { name: "GITHUB_WEBHOOK_SECRET", value: "unused" },
    { name: "OPENAI_COMPAT_BASE_URL", value: env.openaiBaseUrl },
    { name: "OPENAI_COMPAT_API_KEY", value: env.openaiApiKey },
    { name: "OPENAI_COMPAT_MODEL", value: env.openaiModel },
    { name: "OPENAI_TIMEOUT_MS", value: String(env.openaiTimeoutMs) },
    { name: "OPENAI_MAX_RETRIES", value: String(env.openaiMaxRetries) },
    { name: "CODEX_STAGE_TIMEOUT_MS", value: String(env.codexStageTimeoutMs) },
    { name: "CODEX_MODEL_REASONING_EFFORT", value: env.codexModelReasoningEffort },
    { name: "CODEX_STAGE_LOG_OUTPUT", value: String(env.codexStageLogOutput) },
    { name: "CODEX_EXEC_PATH", value: "/usr/local/bin/codex-exec" }
  ];
}

export function buildSandboxPodSpec(params: {
  name: string;
  image: string;
  serviceAccountName: string;
  env: Env;
  taskKind: string;
}): V1Pod {
  const labels = {
    app: "grepiku",
    component: "sandbox",
    "grepiku.io/task-kind": sanitizePodNamePart(params.taskKind)
  };
  const imagePullSecrets = params.env.k8sSandboxImagePullSecret
    ? [{ name: params.env.k8sSandboxImagePullSecret }]
    : undefined;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: params.name,
      labels
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: params.serviceAccountName,
      imagePullSecrets,
      automountServiceAccountToken: false,
      activeDeadlineSeconds: params.env.k8sSandboxActiveDeadlineSeconds,
      enableServiceLinks: false,
      volumes: [
        {
          name: SANDBOX_WORK_VOLUME_NAME,
          emptyDir: {}
        }
      ],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" }
      },
      containers: [
        {
          name: SANDBOX_CONTAINER_NAME,
          image: params.image,
          imagePullPolicy: "IfNotPresent",
          command: ["sh", "-lc", "mkdir -p /work/repo /work/bundle /work/out /work/codex-home /work/tool-home/.tmp && sleep 3600"],
          env: baseSandboxEnv(params.env),
          volumeMounts: [
            {
              name: SANDBOX_WORK_VOLUME_NAME,
              mountPath: "/work"
            }
          ],
          resources: {
            requests: {
              cpu: params.env.k8sSandboxCpuRequest,
              memory: params.env.k8sSandboxMemoryRequest
            },
            limits: {
              cpu: params.env.k8sSandboxCpuLimit,
              memory: params.env.k8sSandboxMemoryLimit
            }
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: false,
            capabilities: { drop: ["ALL"] }
          }
        }
      ]
    }
  };
}

function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc;
}

async function waitForPodRunning(params: {
  core: CoreV1Api;
  namespace: string;
  podName: string;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const pod = await params.core.readNamespacedPod({
      namespace: params.namespace,
      name: params.podName
    });
    const phase = pod.status?.phase;
    if (phase === "Running") return;
    if (phase === "Failed" || phase === "Succeeded") {
      throw new Error(`sandbox pod ${params.podName} ended before execution: ${phase}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`sandbox pod ${params.podName} did not start within ${params.timeoutMs}ms`);
}

function statusExitCode(status: V1Status | null): number {
  const causes = status?.details?.causes || [];
  const exitCause = causes.find((cause) => cause.reason === "ExitCode");
  const code = Number(exitCause?.message);
  return Number.isFinite(code) ? code : status?.status === "Success" ? 0 : 1;
}

async function waitForSocketClose(socket: { on: (...args: any[]) => unknown; readyState?: number }): Promise<void> {
  if (socket.readyState === 3) return;
  await once(socket as any, "close");
}

function closeExecSocket(socket: { readyState?: number; close?: () => void } | null): void {
  if (socket?.readyState !== 3 && typeof socket?.close === "function") {
    socket.close();
  }
}

function execTimeout(params: {
  timeoutMs: number;
  command: string[];
  getSocket: () => { readyState?: number; close?: () => void } | null;
}): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      closeExecSocket(params.getSocket());
      reject(
        new Error(
          `sandbox exec timed out after ${params.timeoutMs}ms: ${params.command.join(" ")}`
        )
      );
    }, params.timeoutMs);
    timer.unref();
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    }
  };
}

async function execInPod(params: {
  execClient: Exec;
  namespace: string;
  podName: string;
  command: string[];
  stdin?: Readable | null;
  stdout?: Writable | null;
  stderr?: Writable | null;
  timeoutMs?: number;
}): Promise<void> {
  let status: V1Status | null = null;
  let resolveStatus!: (value: V1Status | null) => void;
  let socket: { on: (...args: any[]) => unknown; readyState?: number; close?: () => void } | null =
    null;
  const statusPromise = new Promise<V1Status | null>((resolve) => {
    resolveStatus = resolve;
  });
  const completion = (async () => {
    const execSocket = await params.execClient.exec(
      params.namespace,
      params.podName,
      SANDBOX_CONTAINER_NAME,
      params.command,
      params.stdout ?? null,
      params.stderr ?? null,
      params.stdin ?? null,
      false,
      (receivedStatus) => {
        status = receivedStatus;
        resolveStatus(receivedStatus);
      }
    );
    socket = execSocket;
    await Promise.race([statusPromise, waitForSocketClose(execSocket).then(() => status)]);
  })();
  const timeout =
    params.timeoutMs && params.timeoutMs > 0
      ? execTimeout({
          timeoutMs: params.timeoutMs,
          command: params.command,
          getSocket: () => socket
        })
      : null;
  try {
    await (timeout ? Promise.race([completion, timeout.promise]) : completion);
  } finally {
    timeout?.cancel();
  }
  closeExecSocket(socket);
  const exitCode = statusExitCode(status);
  if (exitCode !== 0) {
    throw new Error(`sandbox exec failed (${exitCode}): ${params.command.join(" ")}`);
  }
}

async function execCapture(params: {
  execClient: Exec;
  namespace: string;
  podName: string;
  command: string[];
  timeoutMs?: number;
}): Promise<ExecResult> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  await execInPod({
    execClient: params.execClient,
    namespace: params.namespace,
    podName: params.podName,
    command: params.command,
    stdout,
    stderr,
    timeoutMs: params.timeoutMs
  });
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8")
  };
}

async function tarToPod(params: {
  execClient: Exec;
  namespace: string;
  podName: string;
  sourceDir: string;
  targetDir: string;
  maxBytes: number;
  excludeGit?: boolean;
}): Promise<void> {
  const entries = await collectLocalTreeEntries({
    root: params.sourceDir,
    maxBytes: params.maxBytes,
    excludeGit: params.excludeGit
  });
  if (entries.length === 0) return;
  const listDir = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-sandbox-tar-list-"));
  const listPath = path.join(listDir, "files");
  await fs.writeFile(listPath, `${entries.map((entry) => entry.path).join("\0")}\0`, "utf8");
  const tarArgs = ["-cf", "-", "-C", params.sourceDir, "--null", "--files-from", listPath];
  if (params.excludeGit) {
    tarArgs.splice(0, 0, "--exclude=.git");
  }
  const tar = execa("tar", tarArgs, {
    stdout: "pipe",
    stderr: "pipe",
    buffer: false
  });
  const stdin = new PassThrough({ highWaterMark: 1024 * 1024 });
  const stderr = new PassThrough();
  const stderrChunks: Buffer[] = [];
  const tarStderrChunks: Buffer[] = [];
  stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  tar.stderr?.on("data", (chunk) => tarStderrChunks.push(Buffer.from(chunk)));
  try {
    if (!tar.stdout) {
      tar.kill("SIGKILL");
      throw new Error("local tar stdout pipe was not created");
    }
    const execPromise = execInPod({
      execClient: params.execClient,
      namespace: params.namespace,
      podName: params.podName,
      command: [
        "tar",
        "--no-same-owner",
        "--no-same-permissions",
        "--touch",
        "-C",
        params.targetDir,
        "-xf",
        "-"
      ],
      stdin,
      stderr,
      timeoutMs: SANDBOX_TRANSFER_TIMEOUT_MS
    }).finally(() => stdin.destroy());
    const pipePromise = pipeline(tar.stdout, stdin);
    await Promise.all([execPromise, pipePromise, tar]);
  } catch (error) {
    tar.kill("SIGKILL");
    stdin.destroy();
    const details = [
      Buffer.concat(stderrChunks).toString("utf8").trim(),
      Buffer.concat(tarStderrChunks).toString("utf8").trim()
    ]
      .filter(Boolean)
      .join(": ");
    if (details) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${details}`);
    }
    throw error;
  } finally {
    await fs.rm(listDir, { recursive: true, force: true });
  }
}

class LimitedFileWriter extends Writable {
  private bytes = 0;
  private readonly target;
  constructor(
    filePath: string,
    private readonly maxBytes: number
  ) {
    super();
    this.target = createWriteStream(filePath);
  }

  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new Error(`sandbox tar output exceeded byte limit ${this.maxBytes}`));
      return;
    }
    this.target.write(chunk, encoding, callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.target.end(callback);
  }
}

function parseVerboseTarSymlink(line: string): { entryPath: string; target: string } | null {
  if (!line.startsWith("l")) return null;
  const arrow = line.indexOf(" -> ");
  if (arrow < 0) return null;
  const beforeArrow = line.slice(0, arrow).trim();
  const fields = beforeArrow.split(/\s+/);
  const entryPath = fields.slice(5).join(" ");
  return entryPath ? { entryPath, target: line.slice(arrow + 4).trim() } : null;
}

async function validateTarFile(tarPath: string): Promise<void> {
  const list = await execa("tar", ["-tf", tarPath], { stdout: "pipe" });
  for (const line of list.stdout.split("\n")) {
    if (!line.trim()) continue;
    validateTarEntryPath(line);
  }
  const verbose = await execa("tar", ["-tvf", tarPath], { stdout: "pipe" });
  for (const line of verbose.stdout.split("\n")) {
    const symlink = parseVerboseTarSymlink(line);
    if (symlink) {
      validateSymlinkTarget({ entryPath: symlink.entryPath, linkTarget: symlink.target });
    }
  }
}

async function tarFromPod(params: {
  execClient: Exec;
  namespace: string;
  podName: string;
  sourceDir: string;
  targetDir: string;
  maxBytes: number;
  excludeGit?: boolean;
}): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-sandbox-tar-"));
  const tarPath = path.join(tempDir, "payload.tar");
  try {
    const stdout = new LimitedFileWriter(tarPath, params.maxBytes);
    const stderr = new PassThrough();
    const command = ["tar"];
    if (params.excludeGit) command.push("--exclude=.git");
    command.push("-C", params.sourceDir, "-cf", "-", ".");
    await execInPod({
      execClient: params.execClient,
      namespace: params.namespace,
      podName: params.podName,
      command,
      stdout,
      stderr,
      timeoutMs: SANDBOX_TRANSFER_TIMEOUT_MS
    });
    await validateTarFile(tarPath);
    await fs.mkdir(params.targetDir, { recursive: true });
    await execa("tar", ["-xf", tarPath, "-C", params.targetDir], { stdout: "ignore" });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function rewritePromptPaths(prompt: string, replacements: Array<[string, string]>): string {
  const ordered = replacements
    .filter(([from, to]) => from.trim().length > 0 && from !== to)
    .sort((a, b) => b[0].length - a[0].length);
  let output = prompt;
  for (const [from, to] of ordered) {
    output = output.split(from).join(to);
  }
  return output;
}

function rewriteCodexTaskForPod(task: SandboxTask): SandboxTask {
  if (task.kind !== "codex-stage" && task.kind !== "mention-implementation-sync") {
    return task;
  }
  const repoPath = task.params.repoPath ? SANDBOX_REPO_PATH : undefined;
  const rewrittenPrompt = rewritePromptPaths(task.params.prompt, [
    [task.params.repoPath || "", repoPath || ""],
    [task.params.bundleDir, SANDBOX_BUNDLE_PATH],
    [task.params.outDir, SANDBOX_OUT_PATH],
    [task.params.codexHomeDir, SANDBOX_CODEX_HOME_PATH]
  ]);
  return {
    kind: task.kind,
    params: {
      ...task.params,
      prompt: rewrittenPrompt,
      repoPath,
      bundleDir: SANDBOX_BUNDLE_PATH,
      outDir: SANDBOX_OUT_PATH,
      codexHomeDir: SANDBOX_CODEX_HOME_PATH,
      executionMode: "kubernetes-sandbox"
    }
  };
}

function rewriteDirectTaskForPod(task: SandboxTask): SandboxTask {
  if (task.kind !== "direct-model-stage") return task;
  return {
    kind: task.kind,
    params: {
      ...task.params,
      prompt: rewritePromptPaths(task.params.prompt, [[task.params.outDir, SANDBOX_OUT_PATH]]),
      outDir: SANDBOX_OUT_PATH,
      executionMode: "kubernetes-sandbox"
    }
  };
}

function rewriteTaskForPod(task: SandboxTask): SandboxTask {
  return rewriteDirectTaskForPod(rewriteCodexTaskForPod(task));
}

function shouldSeedSandboxOutDir(task: SandboxTask): boolean {
  return task.kind === "codex-stage" && task.params.stage === "verifier";
}

function buildSandboxUploadPlan(request: KubernetesSandboxRequest): SandboxUploadPlanEntry[] {
  const uploads: SandboxUploadPlanEntry[] = [];
  if (request.localRepoPath) {
    uploads.push({
      sourceDir: request.localRepoPath,
      targetDir: SANDBOX_REPO_PATH,
      excludeGit: !request.includeGit
    });
  }
  if (request.localBundleDir) {
    uploads.push({
      sourceDir: request.localBundleDir,
      targetDir: SANDBOX_BUNDLE_PATH,
      excludeGit: true
    });
  }
  if (shouldSeedSandboxOutDir(request.task)) {
    uploads.push({
      sourceDir: request.localOutDir,
      targetDir: SANDBOX_OUT_PATH,
      excludeGit: true
    });
  }
  return uploads;
}

function parseSandboxTaskResult(stdout: string): SandboxTaskResult {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as SandboxTaskResult;
      if (parsed && (parsed.metrics || parsed.mentionChecks)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  throw new Error("sandbox task did not emit a result JSON line");
}

async function writeTaskFile(params: {
  execClient: Exec;
  namespace: string;
  podName: string;
  task: SandboxTask;
}): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-sandbox-task-"));
  try {
    await fs.writeFile(path.join(tempDir, "task.json"), JSON.stringify(params.task, null, 2), "utf8");
    await tarToPod({
      execClient: params.execClient,
      namespace: params.namespace,
      podName: params.podName,
      sourceDir: tempDir,
      targetDir: "/work",
      maxBytes: 1024 * 1024,
      excludeGit: true
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runKubernetesSandbox(request: KubernetesSandboxRequest): Promise<SandboxTaskResult> {
  const env = loadEnv();
  const namespace = await resolveNamespace(env);
  const kc = loadKubeConfig();
  const core = kc.makeApiClient(CoreV1Api);
  const execClient = new Exec(kc);
  const podName = `grepiku-sandbox-${sanitizePodNamePart(request.task.kind)}-${Date.now().toString(36)}`;
  const pod = buildSandboxPodSpec({
    name: podName,
    image: sandboxImage(env),
    serviceAccountName: env.k8sSandboxServiceAccount,
    env,
    taskKind: request.task.kind
  });
  let originalEntries: LocalTreeEntry[] = [];

  await fs.mkdir(request.localOutDir, { recursive: true });
  await core.createNamespacedPod({ namespace, body: pod });
  try {
    await waitForPodRunning({
      core,
      namespace,
      podName,
      timeoutMs: env.k8sSandboxPodReadyTimeoutMs
    });
    if (request.localRepoPath) {
      originalEntries = await collectLocalTreeEntries({
        root: request.localRepoPath,
        maxBytes: env.k8sSandboxTarMaxBytes,
        excludeGit: !request.includeGit
      });
    }
    for (const upload of buildSandboxUploadPlan(request)) {
      await tarToPod({
        execClient,
        namespace,
        podName,
        sourceDir: upload.sourceDir,
        targetDir: upload.targetDir,
        maxBytes: env.k8sSandboxTarMaxBytes,
        excludeGit: upload.excludeGit
      });
    }
    await writeTaskFile({
      execClient,
      namespace,
      podName,
      task: rewriteTaskForPod(request.task)
    });
    const result = await execCapture({
      execClient,
      namespace,
      podName,
      command: ["node", "/app/dist/sandbox/entrypoint.js"],
      timeoutMs: env.k8sSandboxActiveDeadlineSeconds * 1000
    });
    if (result.stderr.trim()) {
      console.warn(`[sandbox ${podName}] stderr: ${result.stderr.trim()}`);
    }
    await tarFromPod({
      execClient,
      namespace,
      podName,
      sourceDir: SANDBOX_OUT_PATH,
      targetDir: request.localOutDir,
      maxBytes: env.k8sSandboxTarMaxBytes,
      excludeGit: true
    });
    if (request.syncRepoBack && request.localRepoPath) {
      const repoTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-sandbox-repo-"));
      try {
        await tarFromPod({
          execClient,
          namespace,
          podName,
          sourceDir: SANDBOX_REPO_PATH,
          targetDir: repoTempDir,
          maxBytes: env.k8sSandboxTarMaxBytes,
          excludeGit: true
        });
        await syncSandboxRepoBack({
          sourceRoot: repoTempDir,
          targetRoot: request.localRepoPath,
          originalEntries,
          maxBytes: env.k8sSandboxSyncMaxBytes
        });
      } finally {
        await fs.rm(repoTempDir, { recursive: true, force: true });
      }
    }
    return parseSandboxTaskResult(result.stdout);
  } finally {
    await core
      .deleteNamespacedPod({
        namespace,
        name: podName,
        gracePeriodSeconds: 0,
        body: {}
      })
      .catch(() => undefined);
  }
}

export async function runCodexStageInKubernetes(params: CodexRunParams): Promise<CodexStageMetrics> {
  const result = await runKubernetesSandbox({
    task: {
      kind: params.stage === "mention" ? "mention-implementation-sync" : "codex-stage",
      params
    },
    localRepoPath: params.repoPath,
    localBundleDir: params.bundleDir,
    localOutDir: params.outDir,
    syncRepoBack: params.stage === "mention",
    includeGit: params.stage !== "mention"
  });
  if (!result.metrics) {
    throw new Error("sandbox codex stage did not return metrics");
  }
  return result.metrics;
}

export async function runDirectModelStageInKubernetes(
  params: DirectModelRunParams
): Promise<CodexStageMetrics> {
  const result = await runKubernetesSandbox({
    task: { kind: "direct-model-stage", params },
    localOutDir: params.outDir
  });
  if (!result.metrics) {
    throw new Error("sandbox direct model stage did not return metrics");
  }
  return result.metrics;
}

export async function runMentionChecksInKubernetes(params: {
  repoPath: string;
  tools: RepoConfig["tools"];
  outDir: string;
}): Promise<MentionChecksOutput> {
  const result = await runKubernetesSandbox({
    task: { kind: "mention-checks", tools: params.tools },
    localRepoPath: params.repoPath,
    localOutDir: params.outDir,
    includeGit: true
  });
  if (!result.mentionChecks) {
    throw new Error("sandbox mention checks did not return results");
  }
  return result.mentionChecks;
}

export const __k8sSandboxInternals = {
  baseSandboxEnv,
  sanitizePodNamePart,
  resolveNamespace,
  runKubernetesSandbox,
  validateTarFile,
  parseVerboseTarSymlink,
  parseSandboxTaskResult,
  rewriteTaskForPod,
  rewritePromptPaths,
  shouldSeedSandboxOutDir,
  buildSandboxUploadPlan
};
