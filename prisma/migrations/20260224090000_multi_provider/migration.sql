-- Rename legacy tables if present to allow new schema creation
DO $$
BEGIN
  IF to_regclass('public."RepoInstallation"') IS NOT NULL AND to_regclass('public."Legacy_RepoInstallation"') IS NULL THEN
    ALTER TABLE "RepoInstallation" RENAME TO "Legacy_RepoInstallation";
  END IF;
  IF to_regclass('public."PullRequest"') IS NOT NULL AND to_regclass('public."Legacy_PullRequest"') IS NULL THEN
    ALTER TABLE "PullRequest" RENAME TO "Legacy_PullRequest";
  END IF;
  IF to_regclass('public."Run"') IS NOT NULL AND to_regclass('public."Legacy_Run"') IS NULL THEN
    ALTER TABLE "Run" RENAME TO "Legacy_Run";
  END IF;
  IF to_regclass('public."Finding"') IS NOT NULL AND to_regclass('public."Legacy_Finding"') IS NULL THEN
    ALTER TABLE "Finding" RENAME TO "Legacy_Finding";
  END IF;
  IF to_regclass('public."ToolRun"') IS NOT NULL AND to_regclass('public."Legacy_ToolRun"') IS NULL THEN
    ALTER TABLE "ToolRun" RENAME TO "Legacy_ToolRun";
  END IF;
  IF to_regclass('public."StatusComment"') IS NOT NULL AND to_regclass('public."Legacy_StatusComment"') IS NULL THEN
    ALTER TABLE "StatusComment" RENAME TO "Legacy_StatusComment";
  END IF;
END $$;

-- Core enums
DO $$ BEGIN
  CREATE TYPE "ProviderKind" AS ENUM ('github', 'gitlab', 'ghes');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReviewRunStatus" AS ENUM ('queued', 'running', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "FindingStatus" AS ENUM ('open', 'fixed', 'obsolete');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReviewCommentKind" AS ENUM ('inline', 'summary');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "CheckStatus" AS ENUM ('queued', 'in_progress', 'completed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "CheckConclusion" AS ENUM ('success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "FeedbackType" AS ENUM ('reaction', 'reply', 'resolution');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ToolKind" AS ENUM ('lint', 'build', 'test');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ToolStatus" AS ENUM ('pass', 'fail', 'timeout', 'skipped', 'error');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Provider + core entities
CREATE TABLE "Provider" (
  "id" SERIAL PRIMARY KEY,
  "kind" "ProviderKind" NOT NULL,
  "name" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "apiUrl" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "Installation" (
  "id" SERIAL PRIMARY KEY,
  "providerId" INTEGER NOT NULL REFERENCES "Provider"("id") ON DELETE CASCADE,
  "externalId" TEXT NOT NULL,
  "accountLogin" TEXT NOT NULL,
  "accountType" TEXT,
  "metadata" JSONB,
  "configJson" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "Installation_provider_external" ON "Installation" ("providerId", "externalId");

CREATE TABLE "Repo" (
  "id" SERIAL PRIMARY KEY,
  "providerId" INTEGER NOT NULL REFERENCES "Provider"("id") ON DELETE CASCADE,
  "externalId" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "defaultBranch" TEXT,
  "archived" BOOLEAN NOT NULL DEFAULT FALSE,
  "private" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "Repo_provider_external" ON "Repo" ("providerId", "externalId");

CREATE TABLE "RepoInstallation" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "installationId" INTEGER NOT NULL REFERENCES "Installation"("id") ON DELETE CASCADE,
  "permissions" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "RepoInstallation_repo_installation" ON "RepoInstallation" ("repoId", "installationId");

CREATE TABLE "User" (
  "id" SERIAL PRIMARY KEY,
  "providerId" INTEGER NOT NULL REFERENCES "Provider"("id") ON DELETE CASCADE,
  "externalId" TEXT NOT NULL,
  "login" TEXT NOT NULL,
  "name" TEXT,
  "avatarUrl" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "User_provider_external" ON "User" ("providerId", "externalId");

CREATE TABLE "PullRequest" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "externalId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "title" TEXT,
  "body" TEXT,
  "url" TEXT,
  "state" TEXT NOT NULL,
  "baseRef" TEXT,
  "headRef" TEXT,
  "baseSha" TEXT,
  "headSha" TEXT NOT NULL,
  "draft" BOOLEAN NOT NULL DEFAULT FALSE,
  "authorId" INTEGER REFERENCES "User"("id"),
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "PullRequest_repo_number" ON "PullRequest" ("repoId", "number");

CREATE TABLE "ReviewRun" (
  "id" SERIAL PRIMARY KEY,
  "pullRequestId" INTEGER NOT NULL REFERENCES "PullRequest"("id") ON DELETE CASCADE,
  "installationId" INTEGER REFERENCES "Installation"("id"),
  "headSha" TEXT NOT NULL,
  "status" "ReviewRunStatus" NOT NULL,
  "trigger" TEXT NOT NULL,
  "startedAt" TIMESTAMP,
  "completedAt" TIMESTAMP,
  "configJson" JSONB,
  "rulesResolvedJson" JSONB,
  "rulesUsedJson" JSONB,
  "contextPackJson" JSONB,
  "draftJson" JSONB,
  "finalJson" JSONB,
  "verdictsJson" JSONB,
  "checksJson" JSONB,
  "summaryJson" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "ReviewRun_pull_head" ON "ReviewRun" ("pullRequestId", "headSha");

CREATE TABLE "Finding" (
  "id" SERIAL PRIMARY KEY,
  "pullRequestId" INTEGER NOT NULL REFERENCES "PullRequest"("id") ON DELETE CASCADE,
  "reviewRunId" INTEGER NOT NULL REFERENCES "ReviewRun"("id") ON DELETE CASCADE,
  "status" "FindingStatus" NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "hunkHash" TEXT NOT NULL,
  "contextHash" TEXT NOT NULL,
  "commentId" TEXT NOT NULL,
  "commentKey" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "line" INTEGER NOT NULL,
  "side" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "suggestedPatch" TEXT,
  "ruleId" TEXT,
  "ruleReason" TEXT,
  "firstSeenRunId" INTEGER,
  "lastSeenRunId" INTEGER,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "ReviewComment" (
  "id" SERIAL PRIMARY KEY,
  "pullRequestId" INTEGER REFERENCES "PullRequest"("id") ON DELETE CASCADE,
  "findingId" INTEGER UNIQUE REFERENCES "Finding"("id") ON DELETE SET NULL,
  "kind" "ReviewCommentKind" NOT NULL,
  "providerCommentId" TEXT NOT NULL,
  "providerReviewId" TEXT,
  "body" TEXT NOT NULL,
  "url" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "StatusCheck" (
  "id" SERIAL PRIMARY KEY,
  "reviewRunId" INTEGER NOT NULL REFERENCES "ReviewRun"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "status" "CheckStatus" NOT NULL,
  "conclusion" "CheckConclusion",
  "detailsUrl" TEXT,
  "providerCheckId" TEXT,
  "outputJson" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "Feedback" (
  "id" SERIAL PRIMARY KEY,
  "reviewRunId" INTEGER NOT NULL REFERENCES "ReviewRun"("id") ON DELETE CASCADE,
  "userId" INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "type" "FeedbackType" NOT NULL,
  "sentiment" TEXT,
  "action" TEXT,
  "commentId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "RepoConfig" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL UNIQUE REFERENCES "Repo"("id") ON DELETE CASCADE,
  "configJson" JSONB NOT NULL,
  "warnings" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "TriggerSetting" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL UNIQUE REFERENCES "Repo"("id") ON DELETE CASCADE,
  "configJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "PatternRepository" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "ref" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "PatternRepository_url" ON "PatternRepository" ("url");

CREATE TABLE "PatternRepositoryLink" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "patternRepoId" INTEGER NOT NULL REFERENCES "PatternRepository"("id") ON DELETE CASCADE,
  "scope" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "PatternRepositoryLink_unique" ON "PatternRepositoryLink" ("repoId", "patternRepoId");

CREATE TABLE "IndexRun" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "headSha" TEXT,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMP,
  "completedAt" TIMESTAMP,
  "lastCommitSha" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "FileIndex" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "path" TEXT NOT NULL,
  "language" TEXT,
  "blobSha" TEXT,
  "size" INTEGER,
  "contentHash" TEXT NOT NULL,
  "lastIndexedAt" TIMESTAMP NOT NULL,
  "isPattern" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "FileIndex_repo_path" ON "FileIndex" ("repoId", "path", "isPattern");

CREATE TABLE "Symbol" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "fileId" INTEGER NOT NULL REFERENCES "FileIndex"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "signature" TEXT,
  "startLine" INTEGER NOT NULL,
  "endLine" INTEGER NOT NULL,
  "doc" TEXT,
  "hash" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "Symbol_repo_file_hash" ON "Symbol" ("repoId", "fileId", "hash");

CREATE TABLE "SymbolReference" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "fileId" INTEGER NOT NULL REFERENCES "FileIndex"("id") ON DELETE CASCADE,
  "symbolId" INTEGER REFERENCES "Symbol"("id") ON DELETE SET NULL,
  "refName" TEXT NOT NULL,
  "line" INTEGER NOT NULL,
  "kind" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "GraphNode" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "fileId" INTEGER,
  "symbolId" INTEGER,
  "data" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "GraphEdge" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "fromNodeId" INTEGER NOT NULL,
  "toNodeId" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "data" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "Embedding" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "fileId" INTEGER REFERENCES "FileIndex"("id") ON DELETE SET NULL,
  "symbolId" INTEGER REFERENCES "Symbol"("id") ON DELETE SET NULL,
  "kind" TEXT NOT NULL,
  "vector" DOUBLE PRECISION[] NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "AnalyticsEvent" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "runId" INTEGER,
  "kind" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "ToolRun" (
  "id" SERIAL PRIMARY KEY,
  "reviewRunId" INTEGER NOT NULL REFERENCES "ReviewRun"("id") ON DELETE CASCADE,
  "tool" "ToolKind" NOT NULL,
  "status" "ToolStatus" NOT NULL,
  "summary" TEXT NOT NULL,
  "topErrors" JSONB NOT NULL,
  "logPath" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "ToolRun_unique" ON "ToolRun" ("reviewRunId", "tool");

CREATE TABLE "RuleSuggestion" (
  "id" SERIAL PRIMARY KEY,
  "repoId" INTEGER NOT NULL REFERENCES "Repo"("id") ON DELETE CASCADE,
  "ruleJson" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Backfill (best-effort) from legacy schema if present
DO $$
BEGIN
  IF to_regclass('public."Legacy_RepoInstallation"') IS NOT NULL THEN
    INSERT INTO "Provider" ("kind","name","baseUrl","createdAt","updatedAt")
    VALUES ('github','GitHub','https://github.com',NOW(),NOW())
    ON CONFLICT DO NOTHING;

    INSERT INTO "Installation" ("providerId","externalId","accountLogin","createdAt","updatedAt")
    SELECT p."id", r."installationId"::text, r."owner", NOW(), NOW()
    FROM "Legacy_RepoInstallation" r
    JOIN "Provider" p ON p."kind"='github'
    ON CONFLICT DO NOTHING;

    INSERT INTO "Repo" ("providerId","externalId","owner","name","fullName","createdAt","updatedAt")
    SELECT p."id", r."owner" || '/' || r."repo", r."owner", r."repo", r."owner" || '/' || r."repo", NOW(), NOW()
    FROM "Legacy_RepoInstallation" r
    JOIN "Provider" p ON p."kind"='github'
    ON CONFLICT DO NOTHING;

    INSERT INTO "RepoInstallation" ("repoId","installationId","createdAt","updatedAt")
    SELECT repo."id", inst."id", NOW(), NOW()
    FROM "Repo" repo
    JOIN "Installation" inst ON inst."accountLogin" = repo."owner"
    ON CONFLICT DO NOTHING;

    INSERT INTO "PullRequest" ("repoId","externalId","number","title","url","headSha","baseSha","state","createdAt","updatedAt")
    SELECT repo."id", pr."id"::text, pr."number", pr."title", pr."url", pr."headSha", pr."baseSha", pr."state", pr."createdAt", pr."updatedAt"
    FROM "Legacy_PullRequest" pr
    JOIN "Legacy_RepoInstallation" ri ON ri."id"=pr."repoInstallationId"
    JOIN "Repo" repo ON repo."owner"=ri."owner" AND repo."name"=ri."repo"
    ON CONFLICT DO NOTHING;

    INSERT INTO "ReviewRun" ("pullRequestId","headSha","status","startedAt","completedAt","draftJson","finalJson","verdictsJson","checksJson","createdAt","updatedAt","trigger")
    SELECT newpr."id", r."headSha", r."status"::text::"ReviewRunStatus", r."startedAt", r."completedAt", r."draftJson", r."finalJson", r."verdictsJson", r."checksJson", r."createdAt", r."updatedAt", 'legacy'
    FROM "Legacy_Run" r
    JOIN "Legacy_PullRequest" pr ON pr."id"=r."pullRequestId"
    JOIN "Legacy_RepoInstallation" ri ON ri."id"=pr."repoInstallationId"
    JOIN "Repo" repo ON repo."owner"=ri."owner" AND repo."name"=ri."repo"
    JOIN "PullRequest" newpr ON newpr."number"=pr."number" AND newpr."repoId"=repo."id"
    ON CONFLICT DO NOTHING;

    INSERT INTO "Finding" ("pullRequestId","reviewRunId","status","fingerprint","hunkHash","contextHash","commentId","commentKey","path","line","side","severity","category","title","body","evidence","suggestedPatch","createdAt","updatedAt","firstSeenRunId","lastSeenRunId")
    SELECT newpr."id", newrun."id", f."status", f."fingerprint", f."hunkHash", f."contextHash", f."commentId", f."commentKey", f."path", f."line", f."side", f."severity", f."category", f."title", f."body", f."evidence", f."suggestedPatch", f."createdAt", f."updatedAt", f."firstSeenRunId", f."lastSeenRunId"
    FROM "Legacy_Finding" f
    JOIN "Legacy_Run" r ON r."id"=f."runId"
    JOIN "Legacy_PullRequest" pr ON pr."id"=r."pullRequestId"
    JOIN "Legacy_RepoInstallation" ri ON ri."id"=pr."repoInstallationId"
    JOIN "Repo" repo ON repo."owner"=ri."owner" AND repo."name"=ri."repo"
    JOIN "PullRequest" newpr ON newpr."number"=pr."number" AND newpr."repoId"=repo."id"
    JOIN "ReviewRun" newrun ON newrun."headSha"=r."headSha" AND newrun."pullRequestId"=newpr."id"
    ON CONFLICT DO NOTHING;

    INSERT INTO "ToolRun" ("reviewRunId","tool","status","summary","topErrors","logPath","createdAt","updatedAt")
    SELECT newrun."id", t."tool", t."status", t."summary", t."topErrors", t."logPath", t."createdAt", t."updatedAt"
    FROM "Legacy_ToolRun" t
    JOIN "Legacy_RepoInstallation" ri ON ri."id"=t."repoInstallationId"
    JOIN "Repo" repo ON repo."owner"=ri."owner" AND repo."name"=ri."repo"
    JOIN "Legacy_PullRequest" pr ON pr."number"=t."prNumber" AND pr."repoInstallationId"=ri."id"
    JOIN "PullRequest" newpr ON newpr."number"=pr."number" AND newpr."repoId"=repo."id"
    JOIN "ReviewRun" newrun ON newrun."headSha"=t."headSha" AND newrun."pullRequestId"=newpr."id"
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
