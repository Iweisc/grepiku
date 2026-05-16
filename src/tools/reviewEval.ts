import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { ReviewSchema, type ReviewOutput } from "../review/schemas.js";
import {
  ReviewEvalFileSchema,
  evaluateReviewCase,
  summarizeReviewEval
} from "../services/reviewEval.js";

type Options = {
  labels?: string;
  review?: string;
  output?: string;
  ci: boolean;
  minRecall?: number;
  minJudgedPrecision?: number;
};

function parseNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { ci: false };
  for (const arg of argv) {
    if (arg === "--ci") {
      options.ci = true;
      continue;
    }
    if (arg.startsWith("--labels=")) {
      options.labels = arg.slice("--labels=".length);
      continue;
    }
    if (arg.startsWith("--review=")) {
      options.review = arg.slice("--review=".length);
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("--min-recall=")) {
      options.minRecall = parseNumber(arg.slice("--min-recall=".length));
      continue;
    }
    if (arg.startsWith("--min-judged-precision=")) {
      options.minJudgedPrecision = parseNumber(arg.slice("--min-judged-precision=".length));
    }
  }
  return options;
}

function selectReviewPathRaw(evalCaseReviewPath: string | undefined, overrideReviewPath: string | undefined): string | undefined {
  return overrideReviewPath || evalCaseReviewPath;
}

async function readJsonFile<T>(filePath: string, schema: z.ZodSchema<T>): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return schema.parse(JSON.parse(raw));
}

async function readReview(filePath: string): Promise<ReviewOutput> {
  return readJsonFile(filePath, ReviewSchema);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.labels) {
    throw new Error("Missing --labels=<path>");
  }
  const labelsPath = path.resolve(options.labels);
  const evalFile = await readJsonFile(labelsPath, ReviewEvalFileSchema);
  const labelDir = path.dirname(labelsPath);
  const cases = [];
  for (const evalCase of evalFile.cases) {
    const reviewPathRaw = selectReviewPathRaw(evalCase.reviewPath, options.review);
    if (!reviewPathRaw) {
      throw new Error(`Missing review path for eval case ${evalCase.id}`);
    }
    const reviewPath = path.resolve(labelDir, reviewPathRaw);
    const review = await readReview(reviewPath);
    cases.push(
      evaluateReviewCase({
        case: {
          ...evalCase,
          expectedFindings: evalCase.expectedFindings || [],
          falsePositiveFindings: evalCase.falsePositiveFindings || []
        },
        review
      })
    );
  }
  const summary = summarizeReviewEval({
    cases,
    minRecall: options.minRecall ?? evalFile.thresholds?.minRecall,
    minJudgedPrecision:
      options.minJudgedPrecision ?? evalFile.thresholds?.minJudgedPrecision
  });
  const output = JSON.stringify(summary, null, 2);
  if (options.output) {
    await fs.writeFile(options.output, output, "utf8");
  } else {
    console.log(output);
  }
  if (options.ci && !summary.thresholdStatus.pass) {
    process.exitCode = 1;
  }
}

export const __reviewEvalToolInternals = {
  parseArgs,
  selectReviewPathRaw
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error("[review-eval] failed", err);
    process.exitCode = 1;
  });
}
