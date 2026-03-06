import path from "path";
import { readAndValidateJsonWithFallback } from "./json.js";
import { ChecksSchema, type ChecksOutput } from "./schemas.js";

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    return err.message || fallback;
  }
  if (typeof err === "string" && err.trim().length > 0) {
    return err.trim();
  }
  return fallback;
}

export function buildVerifierErrorChecks(params: {
  headSha: string;
  summary: string;
  topErrors?: string[];
}): ChecksOutput {
  const result = {
    status: "error" as const,
    summary: params.summary,
    top_errors: params.topErrors ?? []
  };
  return {
    head_sha: params.headSha,
    checks: {
      lint: { ...result },
      build: { ...result },
      test: { ...result }
    }
  };
}

export async function readVerifierChecks(params: {
  outDir: string;
  headSha: string;
  stageError?: unknown;
  logPrefix?: string;
}): Promise<ChecksOutput> {
  const checksPath = path.join(params.outDir, "checks.json");
  const fallbackPath = path.join(params.outDir, "last_message_verifier.txt");
  try {
    return await readAndValidateJsonWithFallback(checksPath, fallbackPath, ChecksSchema);
  } catch (readError) {
    const prefix = params.logPrefix ? `${params.logPrefix} ` : "";
    const topError = errorMessage(params.stageError ?? readError, "verifier output unavailable");
    const summary = params.stageError
      ? `verifier stage failed: ${topError}`
      : "verifier did not produce valid checks output";
    console.warn(`${prefix}using synthesized verifier checks`, {
      checksPath,
      fallbackPath,
      error: topError
    });
    return buildVerifierErrorChecks({
      headSha: params.headSha,
      summary,
      topErrors: [topError]
    });
  }
}
