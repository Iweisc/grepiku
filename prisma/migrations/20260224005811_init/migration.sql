-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('open', 'fixed', 'obsolete');

-- CreateEnum
CREATE TYPE "ToolKind" AS ENUM ('lint', 'build', 'test');

-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('pass', 'fail', 'timeout', 'skipped', 'error');

-- CreateTable
CREATE TABLE "RepoInstallation" (
    "id" SERIAL NOT NULL,
    "installationId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" SERIAL NOT NULL,
    "repoInstallationId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" SERIAL NOT NULL,
    "pullRequestId" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "draftJson" JSONB,
    "finalJson" JSONB,
    "verdictsJson" JSONB,
    "checksJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" SERIAL NOT NULL,
    "pullRequestId" INTEGER NOT NULL,
    "runId" INTEGER NOT NULL,
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
    "githubCommentId" TEXT,
    "githubReviewId" TEXT,
    "firstSeenRunId" INTEGER NOT NULL,
    "lastSeenRunId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolRun" (
    "id" SERIAL NOT NULL,
    "repoInstallationId" INTEGER NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "tool" "ToolKind" NOT NULL,
    "status" "ToolStatus" NOT NULL,
    "summary" TEXT NOT NULL,
    "topErrors" JSONB NOT NULL,
    "logPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusComment" (
    "id" SERIAL NOT NULL,
    "pullRequestId" INTEGER NOT NULL,
    "githubCommentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatusComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepoInstallation_installationId_key" ON "RepoInstallation"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repoInstallationId_number_key" ON "PullRequest"("repoInstallationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Run_pullRequestId_headSha_key" ON "Run"("pullRequestId", "headSha");

-- CreateIndex
CREATE UNIQUE INDEX "ToolRun_repoInstallationId_prNumber_headSha_tool_key" ON "ToolRun"("repoInstallationId", "prNumber", "headSha", "tool");

-- CreateIndex
CREATE UNIQUE INDEX "StatusComment_pullRequestId_key" ON "StatusComment"("pullRequestId");

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_repoInstallationId_fkey" FOREIGN KEY ("repoInstallationId") REFERENCES "RepoInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_repoInstallationId_fkey" FOREIGN KEY ("repoInstallationId") REFERENCES "RepoInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusComment" ADD CONSTRAINT "StatusComment_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
