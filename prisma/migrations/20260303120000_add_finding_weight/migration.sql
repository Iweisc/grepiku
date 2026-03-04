-- CreateTable
CREATE TABLE "FindingWeight" (
    "id" SERIAL NOT NULL,
    "repoId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "positive" INTEGER NOT NULL DEFAULT 0,
    "negative" INTEGER NOT NULL DEFAULT 0,
    "addressed" INTEGER NOT NULL DEFAULT 0,
    "ignored" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingWeight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FindingWeight_repoId_idx" ON "FindingWeight"("repoId");

-- CreateIndex
CREATE UNIQUE INDEX "FindingWeight_repoId_key_key" ON "FindingWeight"("repoId", "key");

-- AddForeignKey
ALTER TABLE "FindingWeight" ADD CONSTRAINT "FindingWeight_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
