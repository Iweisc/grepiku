DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ReviewRun_pullRequestId_headSha_key') THEN
    EXECUTE 'DROP INDEX "ReviewRun_pullRequestId_headSha_key"';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Run_pullRequestId_headSha_key') THEN
    EXECUTE 'DROP INDEX "Run_pullRequestId_headSha_key"';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ReviewRun') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "ReviewRun_pullRequestId_headSha_createdAt_idx" ON "ReviewRun"("pullRequestId", "headSha", "createdAt")';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Run') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "Run_pullRequestId_headSha_createdAt_idx" ON "Run"("pullRequestId", "headSha", "createdAt")';
  END IF;
END $$;
