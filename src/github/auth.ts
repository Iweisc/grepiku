import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

const appAuth = createAppAuth({
  appId: env.githubAppId,
  privateKey: env.githubPrivateKey
});

let appSlugCache: string | null = null;

export function getInstallationOctokit(installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.githubAppId,
      privateKey: env.githubPrivateKey,
      installationId
    }
  });
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const auth = await appAuth({ type: "installation", installationId });
  return auth.token;
}

export async function getAppSlug(): Promise<string> {
  if (appSlugCache) return appSlugCache;
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.githubAppId,
      privateKey: env.githubPrivateKey
    }
  });
  const { data } = await octokit.apps.getAuthenticated();
  const slug = data?.slug || data?.name || "";
  appSlugCache = slug;
  return slug;
}
