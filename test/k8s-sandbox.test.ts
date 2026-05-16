import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  __k8sSandboxInternals,
  buildSandboxPodSpec,
  runMentionChecksInKubernetes
} from "../src/sandbox/k8sRunner.js";
import {
  SANDBOX_BUNDLE_PATH,
  SANDBOX_CODEX_HOME_PATH,
  SANDBOX_OUT_PATH,
  SANDBOX_REPO_PATH
} from "../src/sandbox/task.js";
import {
  collectLocalTreeEntries,
  syncSandboxRepoBack,
  validateSymlinkTarget,
  validateTarEntryPath
} from "../src/sandbox/transfer.js";
import type { Env } from "../src/config/env.js";

function sampleEnv(): Env {
  return {
    port: 3000,
    databaseUrl: "postgresql://secret",
    redisUrl: "redis://secret",
    githubAppId: 1,
    githubPrivateKey: "secret-private-key",
    githubWebhookSecret: "secret-webhook",
    githubBotLogin: "",
    internalApiKey: "secret-internal-key",
    openaiBaseUrl: "https://models.example/v1",
    openaiApiKey: "secret-openai-key",
    openaiModel: "gpt-test",
    openaiEmbeddingsModel: "text-embedding-3-small",
    openaiEmbeddingsDimensions: null,
    openaiEmbeddingsMaxChars: 12000,
    openaiEmbeddingsBatchSize: 16,
    openaiTimeoutMs: 120000,
    openaiMaxRetries: 3,
    codexStageTimeoutMs: 900000,
    projectRoot: "/app",
    codexExecPath: "/usr/local/bin/codex-exec",
    codexStageLogOutput: false,
    codexModelReasoningEffort: "high",
    internalApiUrl: "http://web:3000/internal/retrieval",
    sandboxExecutionMode: "kubernetes",
    k8sNamespace: "ns-0kkzfz",
    k8sSandboxImage: "grepiku-sandbox:test",
    k8sSandboxServiceAccount: "grepiku-sandbox",
    k8sSandboxImagePullSecret: "grepiku-regcred",
    k8sSandboxCpuRequest: "500m",
    k8sSandboxCpuLimit: "2",
    k8sSandboxMemoryRequest: "512Mi",
    k8sSandboxMemoryLimit: "2Gi",
    k8sSandboxActiveDeadlineSeconds: 1200,
    k8sSandboxPodReadyTimeoutMs: 120000,
    k8sSandboxTarMaxBytes: 100 * 1024 * 1024,
    k8sSandboxSyncMaxBytes: 10 * 1024 * 1024,
    logLevel: "info"
  };
}

test("Kubernetes sandbox pod spec is restricted and short lived", () => {
  const pod = buildSandboxPodSpec({
    name: "grepiku-sandbox-test",
    image: "grepiku-sandbox:test",
    serviceAccountName: "grepiku-sandbox",
    env: sampleEnv(),
    taskKind: "codex-stage"
  });

  assert.equal(pod.spec?.automountServiceAccountToken, false);
  assert.equal(pod.spec?.activeDeadlineSeconds, 1200);
  assert.equal(pod.spec?.serviceAccountName, "grepiku-sandbox");
  assert.equal(pod.spec?.imagePullSecrets?.[0]?.name, "grepiku-regcred");
  assert.equal(pod.spec?.volumes?.[0]?.name, "workdir");
  assert.equal(pod.spec?.volumes?.[0]?.emptyDir != null, true);
  assert.equal(pod.metadata?.labels?.["grepiku.io/task-kind"], "codex-stage");
  assert.equal(pod.spec?.securityContext?.runAsNonRoot, true);
  assert.equal(pod.spec?.securityContext?.seccompProfile?.type, "RuntimeDefault");

  const container = pod.spec?.containers?.[0];
  assert.equal(container?.securityContext?.allowPrivilegeEscalation, false);
  assert.deepEqual(container?.securityContext?.capabilities?.drop, ["ALL"]);
  assert.equal(container?.resources?.requests?.cpu, "500m");
  assert.equal(container?.resources?.limits?.memory, "2Gi");

  const envByName = new Map((container?.env || []).map((item) => [item.name, item.value]));
  assert.equal(envByName.get("OPENAI_COMPAT_API_KEY"), "secret-openai-key");
  assert.equal(envByName.get("INTERNAL_API_KEY"), undefined);
  assert.equal(envByName.get("DATABASE_URL"), "unused://sandbox");
  assert.equal(envByName.get("GITHUB_PRIVATE_KEY"), "unused");
});

test("Kubernetes sandbox task rewriting remaps prompt paths into /work roots", () => {
  const task = {
    kind: "codex-stage" as const,
    params: {
      stage: "reviewer" as const,
      repoPath: "/app/var/repos/demo",
      bundleDir: "/app/var/runs/9/bundle",
      outDir: "/app/var/runs/9/out",
      codexHomeDir: "/app/var/runs/9/codex-home",
      prompt: [
        "Context files:",
        "- /app/var/runs/9/bundle/pr.md",
        "- /app/var/runs/9/bundle/diff.patch",
        "- Repo checkout: /app/var/repos/demo (read-only)",
        "- Write JSON to /app/var/runs/9/out/draft_review.json"
      ].join("\n"),
      headSha: "abc123",
      repoId: 1,
      reviewRunId: 9,
      prNumber: 44,
      executionMode: "local" as const
    }
  };

  const rewritten = __k8sSandboxInternals.rewriteTaskForPod(task);
  assert.equal(rewritten.kind, "codex-stage");
  if (rewritten.kind !== "codex-stage") return;
  assert.equal(rewritten.params.repoPath, SANDBOX_REPO_PATH);
  assert.equal(rewritten.params.bundleDir, SANDBOX_BUNDLE_PATH);
  assert.equal(rewritten.params.outDir, SANDBOX_OUT_PATH);
  assert.equal(rewritten.params.codexHomeDir, SANDBOX_CODEX_HOME_PATH);
  assert.equal(rewritten.params.executionMode, "kubernetes-sandbox");
  assert.match(rewritten.params.prompt, /\/work\/bundle\/pr\.md/);
  assert.match(rewritten.params.prompt, /\/work\/bundle\/diff\.patch/);
  assert.match(rewritten.params.prompt, /Repo checkout: \/work\/repo \(read-only\)/);
  assert.match(rewritten.params.prompt, /\/work\/out\/draft_review\.json/);
  assert.doesNotMatch(rewritten.params.prompt, /\/app\/var\/runs\/9\/bundle/);
  assert.doesNotMatch(rewritten.params.prompt, /\/app\/var\/runs\/9\/out/);
  assert.doesNotMatch(rewritten.params.prompt, /\/app\/var\/repos\/demo/);
});

test("Kubernetes sandbox seeds verifier out artifacts into /work/out", () => {
  const uploads = __k8sSandboxInternals.buildSandboxUploadPlan({
    task: {
      kind: "codex-stage",
      params: {
        stage: "verifier",
        repoPath: "/app/var/repos/demo",
        bundleDir: "/app/var/runs/9/bundle",
        outDir: "/app/var/runs/9/out",
        codexHomeDir: "/app/var/runs/9/codex-home",
        prompt: "read /app/var/runs/9/out/inline_findings.json",
        headSha: "abc123",
        repoId: 1,
        reviewRunId: 9,
        prNumber: 44,
        executionMode: "local"
      }
    },
    localRepoPath: "/app/var/repos/demo",
    localBundleDir: "/app/var/runs/9/bundle",
    localOutDir: "/app/var/runs/9/out",
    includeGit: true
  });

  assert.deepEqual(uploads, [
    {
      sourceDir: "/app/var/repos/demo",
      targetDir: SANDBOX_REPO_PATH,
      excludeGit: false
    },
    {
      sourceDir: "/app/var/runs/9/bundle",
      targetDir: SANDBOX_BUNDLE_PATH,
      excludeGit: true
    },
    {
      sourceDir: "/app/var/runs/9/out",
      targetDir: SANDBOX_OUT_PATH,
      excludeGit: true
    }
  ]);
});

test("Kubernetes sandbox does not upload prior out artifacts for reviewer stage", () => {
  const uploads = __k8sSandboxInternals.buildSandboxUploadPlan({
    task: {
      kind: "codex-stage",
      params: {
        stage: "reviewer",
        repoPath: "/app/var/repos/demo",
        bundleDir: "/app/var/runs/9/bundle",
        outDir: "/app/var/runs/9/out",
        codexHomeDir: "/app/var/runs/9/codex-home",
        prompt: "write /app/var/runs/9/out/draft_review.json",
        headSha: "abc123",
        repoId: 1,
        reviewRunId: 9,
        prNumber: 44,
        executionMode: "local"
      }
    },
    localRepoPath: "/app/var/repos/demo",
    localBundleDir: "/app/var/runs/9/bundle",
    localOutDir: "/app/var/runs/9/out",
    includeGit: false
  });

  assert.deepEqual(uploads, [
    {
      sourceDir: "/app/var/repos/demo",
      targetDir: SANDBOX_REPO_PATH,
      excludeGit: true
    },
    {
      sourceDir: "/app/var/runs/9/bundle",
      targetDir: SANDBOX_BUNDLE_PATH,
      excludeGit: true
    }
  ]);
});

test("sandbox tar validation rejects traversal and external symlinks", () => {
  assert.equal(validateTarEntryPath("./src/index.ts"), "src/index.ts");
  assert.equal(validateTarEntryPath("./.verifier-cache/"), ".verifier-cache");
  assert.throws(() => validateTarEntryPath("../secret"), /escapes target/);
  assert.throws(() => validateTarEntryPath("/etc/passwd"), /absolute/);
  assert.doesNotThrow(() =>
    validateSymlinkTarget({ entryPath: "src/current", linkTarget: "../README.md" })
  );
  assert.throws(
    () => validateSymlinkTarget({ entryPath: "src/current", linkTarget: "../../secret" }),
    /points outside/
  );
});

test("sandbox transfer enforces size caps and rejects external local symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-k8s-transfer-"));
  const outside = path.join(root, "..", `${path.basename(root)}-outside`);
  try {
    await fs.writeFile(path.join(root, "big.txt"), "abcdef", "utf8");
    await assert.rejects(
      () => collectLocalTreeEntries({ root, maxBytes: 4 }),
      /exceeded byte limit/
    );

    await fs.writeFile(outside, "secret", "utf8");
    await fs.symlink(outside, path.join(root, "escape"));
    await assert.rejects(
      () => collectLocalTreeEntries({ root, maxBytes: 1024 }),
      /points outside/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});

test("mention implementation repo sync excludes git metadata and applies bounded file changes", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-k8s-target-"));
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-k8s-source-"));
  try {
    await fs.mkdir(path.join(target, ".git"), { recursive: true });
    await fs.writeFile(path.join(target, ".git", "config"), "keep", "utf8");
    await fs.writeFile(path.join(target, "keep.txt"), "old", "utf8");
    await fs.writeFile(path.join(target, "delete.txt"), "remove", "utf8");
    const originalEntries = await collectLocalTreeEntries({ root: target, excludeGit: true });

    await fs.writeFile(path.join(source, "keep.txt"), "new", "utf8");
    await fs.writeFile(path.join(source, "added.txt"), "added", "utf8");
    await fs.mkdir(path.join(source, ".git"), { recursive: true });
    await fs.writeFile(path.join(source, ".git", "config"), "replace", "utf8");

    await syncSandboxRepoBack({
      sourceRoot: source,
      targetRoot: target,
      originalEntries,
      maxBytes: 1024
    });

    assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(target, "added.txt"), "utf8"), "added");
    await assert.rejects(() => fs.stat(path.join(target, "delete.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(target, ".git", "config"), "utf8"), "keep");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
    await fs.rm(source, { recursive: true, force: true });
  }
});

test(
  "optional Kubernetes sandbox integration runs a tiny mention-checks task",
  { skip: process.env.RUN_K8S_SANDBOX_TESTS !== "1" },
  async () => {
    const required: Record<string, string> = {
      DATABASE_URL: "postgresql://unused",
      REDIS_URL: "redis://unused",
      GITHUB_APP_ID: "0",
      GITHUB_PRIVATE_KEY: "unused",
      GITHUB_WEBHOOK_SECRET: "unused",
      OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
      OPENAI_COMPAT_API_KEY: "unused",
      PROJECT_ROOT: process.cwd(),
      SANDBOX_EXECUTION_MODE: "kubernetes",
      K8S_NAMESPACE: process.env.K8S_NAMESPACE || "ns-0kkzfz",
      K8S_SANDBOX_IMAGE:
        process.env.K8S_SANDBOX_IMAGE || "ghcr.io/iweisc/grepiku-sandbox:sealos-dev-a0f8302-gpt55high",
      K8S_SANDBOX_IMAGE_PULL_SECRET: process.env.K8S_SANDBOX_IMAGE_PULL_SECRET || "grepiku-regcred"
    };
    for (const [key, value] of Object.entries(required)) {
      if (!process.env[key]) process.env[key] = value;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-k8s-integration-"));
    const repoPath = path.join(root, "repo");
    const outDir = path.join(root, "out");
    try {
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, "package.json"), "{\"name\":\"fixture\"}", "utf8");
      const checks = await runMentionChecksInKubernetes({
        repoPath,
        outDir,
        tools: {
          lint: { cmd: "node -e \"process.exit(0)\"", timeout_sec: 30 },
          build: undefined,
          test: undefined
        }
      });

      assert.equal(checks.checks.lint.status, "pass");
      assert.equal(checks.checks.build.status, "skipped");
      assert.equal(checks.checks.test.status, "skipped");
      await fs.stat(path.join(outDir, "mention_checks.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
