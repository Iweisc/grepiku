import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { z } from "zod";
import { prisma } from "../db/client.js";

export type ToolConfig = {
  cmd: string;
  timeout_sec: number;
};

export type RuleConfig = {
  id: string;
  title: string;
  description?: string;
  severity?: string;
  category?: string;
  pattern?: string;
  scope?: string;
  commentType?: "inline" | "summary";
  strictness?: "low" | "medium" | "high";
  docs?: string[];
};

export type RepoConfig = {
  ignore: string[];
  tools: {
    lint?: ToolConfig;
    build?: ToolConfig;
    test?: ToolConfig;
  };
  limits: {
    max_inline_comments: number;
    max_key_concerns: number;
  };
  rules: RuleConfig[];
  scopes: Array<{
    name: string;
    include: string[];
    exclude?: string[];
    docs?: string[];
  }>;
  patternRepositories: Array<{
    name: string;
    url: string;
    ref?: string;
    scope?: string;
  }>;
  strictness: "low" | "medium" | "high";
  commentTypes: {
    allow: Array<"inline" | "summary">;
  };
  output: {
    summaryOnly: boolean;
    destination: "comment" | "pr_body" | "both";
  };
  statusChecks: {
    name: string;
    required: boolean;
  };
  triggers: {
    manualOnly: boolean;
    allowAutoOnPush: boolean;
    labels: { include: string[]; exclude: string[] };
    branches: { include: string[]; exclude: string[] };
    authors: { include: string[]; exclude: string[] };
    keywords: { include: string[]; exclude: string[] };
    commentTriggers: string[];
  };
};

const GrepikuSchema = z.object({
  ignore: z.array(z.string()).default(["node_modules/**", "dist/**"]),
  tools: z
    .object({
      lint: z.object({ cmd: z.string(), timeout_sec: z.number().int().positive() }).optional(),
      build: z.object({ cmd: z.string(), timeout_sec: z.number().int().positive() }).optional(),
      test: z.object({ cmd: z.string(), timeout_sec: z.number().int().positive() }).optional()
    })
    .default({}),
  limits: z
    .object({
      max_inline_comments: z.number().int().positive().default(20),
      max_key_concerns: z.number().int().positive().default(5)
    })
    .default({ max_inline_comments: 20, max_key_concerns: 5 }),
  rules: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string().optional(),
        severity: z.string().optional(),
        category: z.string().optional(),
        pattern: z.string().optional(),
        scope: z.string().optional(),
        commentType: z.enum(["inline", "summary"]).optional(),
        strictness: z.enum(["low", "medium", "high"]).optional(),
        docs: z.array(z.string()).optional()
      })
    )
    .default([]),
  scopes: z
    .array(
      z.object({
        name: z.string(),
        include: z.array(z.string()),
        exclude: z.array(z.string()).optional(),
        docs: z.array(z.string()).optional()
      })
    )
    .default([]),
  patternRepositories: z
    .array(
      z.object({
        name: z.string(),
        url: z.string(),
        ref: z.string().optional(),
        scope: z.string().optional()
      })
    )
    .default([]),
  strictness: z.enum(["low", "medium", "high"]).default("medium"),
  commentTypes: z
    .object({
      allow: z.array(z.enum(["inline", "summary"])).default(["inline", "summary"])
    })
    .default({ allow: ["inline", "summary"] }),
  output: z
    .object({
      summaryOnly: z.boolean().default(false),
      destination: z.enum(["comment", "pr_body", "both"]).default("comment")
    })
    .default({ summaryOnly: false, destination: "comment" }),
  statusChecks: z
    .object({
      name: z.string().default("Grepiku Review"),
      required: z.boolean().default(false)
    })
    .default({ name: "Grepiku Review", required: false }),
  triggers: z
    .object({
      manualOnly: z.boolean().default(false),
      allowAutoOnPush: z.boolean().default(true),
      labels: z.object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) }).default({ include: [], exclude: [] }),
      branches: z.object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) }).default({ include: [], exclude: [] }),
      authors: z.object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) }).default({ include: [], exclude: [] }),
      keywords: z.object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) }).default({ include: [], exclude: [] }),
      commentTriggers: z.array(z.string()).default(["/review", "@grepiku"])
    })
    .default({
      manualOnly: false,
      allowAutoOnPush: true,
      labels: { include: [], exclude: [] },
      branches: { include: [], exclude: [] },
      authors: { include: [], exclude: [] },
      keywords: { include: [], exclude: [] },
      commentTriggers: ["/review", "@grepiku"]
    })
});

const defaultConfig: RepoConfig = GrepikuSchema.parse({});

export async function loadRepoConfig(repoPath: string): Promise<{ config: RepoConfig; warnings: string[] }> {
  const warnings: string[] = [];
  const candidates = [
    { path: path.join(repoPath, "grepiku.json"), name: "grepiku.json", legacy: false },
    { path: path.join(repoPath, "greptile.json"), name: "greptile.json", legacy: true }
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate.path, "utf8");
      const parsed = JSON.parse(raw);
      const result = GrepikuSchema.safeParse(parsed);
      if (!result.success) {
        warnings.push(...result.error.errors.map((err) => `config:${err.path.join(".")}: ${err.message}`));
        return { config: defaultConfig, warnings };
      }
      if (candidate.legacy) {
        warnings.push(`Using legacy ${candidate.name}; migrate to grepiku.json`);
      }
      return { config: result.data, warnings };
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        warnings.push(`config: ${err.message || `Failed to read ${candidate.name}`}`);
        return { config: defaultConfig, warnings };
      }
    }
  }

  // fallback to legacy .prreviewer.yml if present
  const legacyPath = path.join(repoPath, ".prreviewer.yml");
  try {
    const raw = await fs.readFile(legacyPath, "utf8");
    const parsed = (yaml.load(raw) || {}) as any;
    const legacy: RepoConfig = {
      ...defaultConfig,
      ignore: Array.isArray(parsed.ignore) ? parsed.ignore : defaultConfig.ignore,
      tools: {
        lint: parsed.tools?.lint,
        build: parsed.tools?.build,
        test: parsed.tools?.test
      },
      limits: {
        max_inline_comments:
          parsed.limits?.max_inline_comments ?? defaultConfig.limits.max_inline_comments,
        max_key_concerns:
          parsed.limits?.max_key_concerns ?? defaultConfig.limits.max_key_concerns
      }
    };
    warnings.push("Using legacy .prreviewer.yml; migrate to grepiku.json");
    return { config: legacy, warnings };
  } catch {
    return { config: defaultConfig, warnings };
  }
}

export async function resolveRepoConfig(repoId: number, providerKind?: string): Promise<RepoConfig> {
  const existing = await prisma.repoConfig.findFirst({ where: { repoId } });
  let config = existing?.configJson ? (existing.configJson as RepoConfig) : defaultConfig;
  const triggerSetting = await prisma.triggerSetting.findFirst({ where: { repoId } });
  if (triggerSetting?.configJson) {
    config = { ...config, triggers: triggerSetting.configJson as RepoConfig["triggers"] };
  }
  return config;
}

export async function saveRepoConfig(repoId: number, config: RepoConfig, warnings: string[]) {
  const existing = await prisma.repoConfig.findFirst({ where: { repoId } });
  if (existing) {
    await prisma.repoConfig.update({
      where: { id: existing.id },
      data: { configJson: config, warnings }
    });
  } else {
    await prisma.repoConfig.create({
      data: { repoId, configJson: config, warnings }
    });
  }
}
