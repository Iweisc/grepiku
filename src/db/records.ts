import { prisma } from "./client.js";
import { ProviderKind } from "../providers/types.js";

export async function ensureProvider(params: { kind: ProviderKind; name: string; baseUrl: string; apiUrl?: string | null }) {
  const existing = await prisma.provider.findFirst({
    where: { kind: params.kind, baseUrl: params.baseUrl }
  });
  if (existing) return existing;
  return prisma.provider.create({
    data: {
      kind: params.kind,
      name: params.name,
      baseUrl: params.baseUrl,
      apiUrl: params.apiUrl || null
    }
  });
}

export async function ensureInstallation(params: {
  providerId: number;
  externalId: string;
  accountLogin: string;
  accountType?: string | null;
  metadata?: any;
}) {
  const existing = await prisma.installation.findFirst({
    where: { providerId: params.providerId, externalId: params.externalId }
  });
  if (existing) return existing;
  return prisma.installation.create({
    data: {
      providerId: params.providerId,
      externalId: params.externalId,
      accountLogin: params.accountLogin,
      accountType: params.accountType || null,
      metadata: params.metadata || undefined
    }
  });
}

export async function ensureRepo(params: {
  providerId: number;
  externalId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string | null;
  archived?: boolean;
  private?: boolean;
}) {
  const existing = await prisma.repo.findFirst({
    where: { providerId: params.providerId, externalId: params.externalId }
  });
  if (existing) {
    return prisma.repo.update({
      where: { id: existing.id },
      data: {
        owner: params.owner,
        name: params.name,
        fullName: params.fullName,
        defaultBranch: params.defaultBranch || null,
        archived: params.archived ?? existing.archived,
        private: params.private ?? existing.private
      }
    });
  }
  return prisma.repo.create({
    data: {
      providerId: params.providerId,
      externalId: params.externalId,
      owner: params.owner,
      name: params.name,
      fullName: params.fullName,
      defaultBranch: params.defaultBranch || null,
      archived: params.archived ?? false,
      private: params.private ?? true
    }
  });
}

export async function ensureRepoInstallation(params: {
  repoId: number;
  installationId: number;
  permissions?: any;
}) {
  const existing = await prisma.repoInstallation.findFirst({
    where: { repoId: params.repoId, installationId: params.installationId }
  });
  if (existing) {
    return prisma.repoInstallation.update({
      where: { id: existing.id },
      data: { permissions: params.permissions || existing.permissions }
    });
  }
  return prisma.repoInstallation.create({
    data: {
      repoId: params.repoId,
      installationId: params.installationId,
      permissions: params.permissions || undefined
    }
  });
}

export async function ensureUser(params: {
  providerId: number;
  externalId: string;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}) {
  const existing = await prisma.user.findFirst({
    where: { providerId: params.providerId, externalId: params.externalId }
  });
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        login: params.login,
        name: params.name || null,
        avatarUrl: params.avatarUrl || null
      }
    });
  }
  return prisma.user.create({
    data: {
      providerId: params.providerId,
      externalId: params.externalId,
      login: params.login,
      name: params.name || null,
      avatarUrl: params.avatarUrl || null
    }
  });
}

export async function upsertPullRequest(params: {
  repoId: number;
  externalId: string;
  number: number;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  state: string;
  baseRef?: string | null;
  headRef?: string | null;
  baseSha?: string | null;
  headSha: string;
  draft?: boolean;
  authorId?: number | null;
}) {
  const existing = await prisma.pullRequest.findFirst({
    where: { repoId: params.repoId, number: params.number }
  });
  if (existing) {
    return prisma.pullRequest.update({
      where: { id: existing.id },
      data: {
        externalId: params.externalId,
        title: params.title || null,
        body: params.body || null,
        url: params.url || null,
        state: params.state,
        baseRef: params.baseRef || null,
        headRef: params.headRef || null,
        baseSha: params.baseSha || existing.baseSha || null,
        headSha: params.headSha || existing.headSha,
        draft: params.draft ?? existing.draft,
        authorId: params.authorId ?? existing.authorId
      }
    });
  }
  return prisma.pullRequest.create({
    data: {
      repoId: params.repoId,
      externalId: params.externalId,
      number: params.number,
      title: params.title || null,
      body: params.body || null,
      url: params.url || null,
      state: params.state,
      baseRef: params.baseRef || null,
      headRef: params.headRef || null,
      baseSha: params.baseSha || null,
      headSha: params.headSha,
      draft: params.draft ?? false,
      authorId: params.authorId || null
    }
  });
}
