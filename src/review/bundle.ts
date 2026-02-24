import fs from "fs/promises";
import path from "path";
import { RepoConfig } from "./config.js";

export type BundlePaths = {
  runDir: string;
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
};

export async function createRunDirs(root: string, runId: number): Promise<BundlePaths> {
  const runDir = path.join(root, "var", "runs", String(runId));
  const bundleDir = path.join(runDir, "bundle");
  const outDir = path.join(runDir, "out");
  const codexHomeDir = path.join(runDir, "codex-home");
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(codexHomeDir, { recursive: true });
  await fs.mkdir(path.join(bundleDir, "repo_hints"), { recursive: true });
  return { runDir, bundleDir, outDir, codexHomeDir };
}

export async function writeBundleFiles(params: {
  bundleDir: string;
  prMarkdown: string;
  diffPatch: string;
  changedFiles: unknown;
  repoConfig: RepoConfig;
  resolvedConfig?: RepoConfig;
  contextPack?: unknown;
  warnings?: string[];
}) {
  const { bundleDir, prMarkdown, diffPatch, changedFiles, repoConfig, resolvedConfig, contextPack, warnings } = params;
  await fs.writeFile(path.join(bundleDir, "pr.md"), prMarkdown, "utf8");
  await fs.writeFile(path.join(bundleDir, "diff.patch"), diffPatch, "utf8");
  await fs.writeFile(
    path.join(bundleDir, "changed_files.json"),
    JSON.stringify(changedFiles, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(bundleDir, "bot_config.json"),
    JSON.stringify(
      {
        ignore: repoConfig.ignore,
        tools: repoConfig.tools,
        limits: repoConfig.limits,
        strictness: repoConfig.strictness,
        commentTypes: repoConfig.commentTypes,
        output: repoConfig.output,
        statusChecks: repoConfig.statusChecks,
        triggers: repoConfig.triggers
      },
      null,
      2
    ),
    "utf8"
  );
  if (resolvedConfig) {
    await fs.writeFile(
      path.join(bundleDir, "rules.json"),
      JSON.stringify(resolvedConfig.rules || [], null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(bundleDir, "scopes.json"),
      JSON.stringify(resolvedConfig.scopes || [], null, 2),
      "utf8"
    );
  }
  if (contextPack) {
    await fs.writeFile(
      path.join(bundleDir, "context_pack.json"),
      JSON.stringify(contextPack, null, 2),
      "utf8"
    );
  }
  await fs.writeFile(
    path.join(bundleDir, "config_warnings.json"),
    JSON.stringify(warnings ?? [], null, 2),
    "utf8"
  );
}
