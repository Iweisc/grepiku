import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";

export type ToolConfig = {
  cmd: string;
  timeout_sec: number;
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
};

const defaultConfig: RepoConfig = {
  ignore: ["node_modules/**", "dist/**"],
  tools: {},
  limits: {
    max_inline_comments: 20,
    max_key_concerns: 5
  }
};

export async function loadRepoConfig(repoPath: string): Promise<RepoConfig> {
  const configPath = path.join(repoPath, ".prreviewer.yml");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = (yaml.load(raw) || {}) as any;
    return {
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
  } catch (err: any) {
    if (err.code === "ENOENT") return defaultConfig;
    throw err;
  }
}
