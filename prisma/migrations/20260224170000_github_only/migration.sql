-- Restrict ProviderKind enum to GitHub only
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProviderKind') THEN
    UPDATE "Provider" SET "kind" = 'github' WHERE "kind"::text <> 'github';
    ALTER TYPE "ProviderKind" RENAME TO "ProviderKind_old";
    CREATE TYPE "ProviderKind" AS ENUM ('github');
    ALTER TABLE "Provider" ALTER COLUMN "kind" TYPE "ProviderKind" USING "kind"::text::"ProviderKind";
    DROP TYPE "ProviderKind_old";
  END IF;
END $$;
