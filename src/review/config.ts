import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { loadAcceptedRepoMemoryRules, mergeRulesWithRepoMemory } from "../services/repoMemory.js";

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
  graph: {
    exclude_dirs: string[];
    traversal: {
      max_depth: number;
      min_score: number;
      max_related_files: number;
      max_graph_links: number;
      hard_include_files: number;
      max_nodes_visited: number;
    };
  };
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
    syncSummaryWithStatus: boolean;
    allowIncrementalPrBodyUpdates: boolean;
  };
  retrieval: {
    topK: number;
    maxPerPath: number;
    semanticWeight: number;
    lexicalWeight: number;
    rrfWeight: number;
    changedPathBoost: number;
    sameDirectoryBoost: number;
    patternBoost: number;
    symbolBoost: number;
    chunkBoost: number;
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
  graph: z
    .object({
      exclude_dirs: z.array(z.string()).default(["internal_harness"]),
      traversal: z
        .object({
          max_depth: z.number().int().min(1).max(8).default(5),
          min_score: z.number().min(0.01).max(0.5).default(0.07),
          max_related_files: z.number().int().min(6).max(80).default(28),
          max_graph_links: z.number().int().min(10).max(240).default(110),
          hard_include_files: z.number().int().min(0).max(24).default(8),
          max_nodes_visited: z.number().int().min(200).max(12000).default(2600)
        })
        .default({
          max_depth: 5,
          min_score: 0.07,
          max_related_files: 28,
          max_graph_links: 110,
          hard_include_files: 8,
          max_nodes_visited: 2600
        })
    })
    .default({
      exclude_dirs: ["internal_harness"],
      traversal: {
        max_depth: 5,
        min_score: 0.07,
        max_related_files: 28,
        max_graph_links: 110,
        hard_include_files: 8,
        max_nodes_visited: 2600
      }
    }),
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
      destination: z.enum(["comment", "pr_body", "both"]).default("both"),
      syncSummaryWithStatus: z.boolean().default(true),
      allowIncrementalPrBodyUpdates: z.boolean().default(true)
    })
    .default({
      summaryOnly: false,
      destination: "both",
      syncSummaryWithStatus: true,
      allowIncrementalPrBodyUpdates: true
    }),
  retrieval: z
    .object({
      topK: z.number().int().min(4).max(60).default(28),
      maxPerPath: z.number().int().min(1).max(12).default(6),
      semanticWeight: z.number().min(0).max(1).default(0.62),
      lexicalWeight: z.number().min(0).max(1).default(0.22),
      rrfWeight: z.number().min(0).max(1).default(0.08),
      changedPathBoost: z.number().min(0).max(1).default(0.16),
      sameDirectoryBoost: z.number().min(0).max(1).default(0.08),
      patternBoost: z.number().min(0).max(1).default(0.03),
      symbolBoost: z.number().min(0).max(1).default(0.02),
      chunkBoost: z.number().min(0).max(1).default(0.03)
    })
    .default({
      topK: 28,
      maxPerPath: 6,
      semanticWeight: 0.62,
      lexicalWeight: 0.22,
      rrfWeight: 0.08,
      changedPathBoost: 0.16,
      sameDirectoryBoost: 0.08,
      patternBoost: 0.03,
      symbolBoost: 0.02,
      chunkBoost: 0.03
    }),
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

const ScopedGrepikuSchema = z.object({
  strictness: z.enum(["low", "medium", "high"]).optional(),
  commentTypes: z
    .object({
      allow: z.array(z.enum(["inline", "summary"]))
    })
    .optional(),
  ignore: z.array(z.string()).optional(),
  limits: z
    .object({
      max_inline_comments: z.number().int().positive().optional(),
      max_key_concerns: z.number().int().positive().optional()
    })
    .optional(),
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
    .optional()
});

type ScopedOverride = z.infer<typeof ScopedGrepikuSchema>;

const SCOPED_KEYS: ReadonlyArray<keyof ScopedOverride> = [
  "strictness",
  "commentTypes",
  "ignore",
  "limits",
  "rules"
];

/** Walk from filePath's directory up to repoPath, collecting .grepiku/config.json paths (deepest first). */
export function collectScopedConfigPaths(repoPath: string, filePath: string): string[] {
  const resolved = path.resolve(repoPath);
  let dir = path.dirname(path.resolve(filePath));
  const paths: string[] = [];

  while (dir.startsWith(resolved) && dir !== resolved) {
    paths.push(path.join(dir, ".grepiku", "config.json"));
    dir = path.dirname(dir);
  }

  return paths;
}

/** Merge a scoped override into a base config, only touching allowed fields. */
export function mergeScopedOverride(base: RepoConfig, override: ScopedOverride): RepoConfig {
  const merged = { ...base };

  if (override.strictness !== undefined) {
    merged.strictness = override.strictness;
  }
  if (override.commentTypes !== undefined) {
    merged.commentTypes = override.commentTypes;
  }
  if (override.ignore !== undefined) {
    merged.ignore = override.ignore;
  }
  if (override.limits !== undefined) {
    merged.limits = {
      max_inline_comments: override.limits.max_inline_comments ?? base.limits.max_inline_comments,
      max_key_concerns: override.limits.max_key_concerns ?? base.limits.max_key_concerns
    };
  }
  if (override.rules !== undefined) {
    merged.rules = override.rules;
  }

  return merged;
}

export async function loadScopedConfig(params: {
  repoPath: string;
  filePath: string;
  rootConfig: RepoConfig;
}): Promise<RepoConfig> {
  const { repoPath, filePath, rootConfig } = params;
  const configPaths = collectScopedConfigPaths(repoPath, filePath);

  // Read configs deepest-first, collecting valid overrides (deepest = index 0)
  const overrides: ScopedOverride[] = [];
  for (const configPath of configPaths) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw);
      // Strip non-overridable keys before validation
      const scoped: Record<string, unknown> = {};
      for (const key of SCOPED_KEYS) {
        if (key in parsed) scoped[key] = parsed[key];
      }
      const result = ScopedGrepikuSchema.safeParse(scoped);
      if (result.success) overrides.push(result.data);
    } catch {
      // missing or unreadable config at this level; skip
    }
  }

  if (overrides.length === 0) return rootConfig;

  // Apply shallowest first so deepest (closest to file) wins last
  let config = rootConfig;
  for (let i = overrides.length - 1; i >= 0; i--) {
    config = mergeScopedOverride(config, overrides[i]);
  }
  return config;
}

const defaultConfig: RepoConfig = GrepikuSchema.parse({});

function parseJsonConfigText(raw: string): { parsed: unknown; repaired: boolean } {
  try {
    return { parsed: JSON.parse(raw), repaired: false };
  } catch {
    return { parsed: JSON.parse(jsonrepair(raw)), repaired: true };
  }
}

export async function loadRepoConfig(repoPath: string): Promise<{ config: RepoConfig; warnings: string[] }> {
  const warnings: string[] = [];
  const candidates = [
    { path: path.join(repoPath, "grepiku.json"), name: "grepiku.json", legacy: false },
    { path: path.join(repoPath, "greptile.json"), name: "greptile.json", legacy: true }
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate.path, "utf8");
      let parsed: unknown;
      let repaired = false;
      try {
        const result = parseJsonConfigText(raw);
        parsed = result.parsed;
        repaired = result.repaired;
      } catch (parseErr: any) {
        warnings.push(
          `config: unable to parse ${candidate.name}: ${parseErr?.message || "invalid JSON"}`
        );
        continue;
      }
      const result = GrepikuSchema.safeParse(parsed);
      if (!result.success) {
        warnings.push(
          ...result.error.errors.map((err) => {
            const fieldPath = err.path.length > 0 ? err.path.join(".") : "root";
            return `config:${candidate.name}:${fieldPath}: ${err.message}`;
          })
        );
        continue;
      }
      if (repaired) {
        warnings.push(`config: repaired malformed ${candidate.name}`);
      }
      if (candidate.legacy) {
        warnings.push(`Using legacy ${candidate.name}; migrate to grepiku.json`);
      }
      return { config: result.data, warnings };
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        warnings.push(`config: ${err.message || `Failed to read ${candidate.name}`}`);
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
      graph: {
        exclude_dirs: Array.isArray(parsed.graph?.exclude_dirs)
          ? parsed.graph.exclude_dirs
          : defaultConfig.graph.exclude_dirs,
        traversal: {
          ...defaultConfig.graph.traversal,
          ...(typeof parsed.graph?.traversal === "object" && parsed.graph?.traversal
            ? parsed.graph.traversal
            : {})
        }
      },
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
  const parsed = GrepikuSchema.safeParse(existing?.configJson ?? {});
  let config = parsed.success ? parsed.data : defaultConfig;
  const triggerSetting = await prisma.triggerSetting.findFirst({ where: { repoId } });
  if (triggerSetting?.configJson) {
    config = { ...config, triggers: triggerSetting.configJson as RepoConfig["triggers"] };
  }
  const memoryRules = await loadAcceptedRepoMemoryRules(repoId);
  if (memoryRules.length > 0) {
    config = {
      ...config,
      rules: mergeRulesWithRepoMemory(config.rules, memoryRules)
    };
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
