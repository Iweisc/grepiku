import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseAndValidateJson,
  readAndValidateJsonWithFallback
} from "../src/review/json.js";
import { ReviewSchema, VerdictsSchema } from "../src/review/schemas.js";

const sampleReview = {
  summary: {
    overview: "The PR looks safe after the edit pass.",
    risk: "low" as const,
    confidence: 0.82,
    key_concerns: ["Keep an eye on the cache invalidation branch."],
    what_to_test: ["Run the mention follow-up flow once end to end."],
    file_breakdown: [
      {
        path: "src/review/pipeline.ts",
        summary: "Tightens output parsing for stage results.",
        risk: "low" as const
      }
    ]
  },
  comments: []
};

const sampleVerdicts = {
  verdicts: [
    {
      comment_id: "c1",
      decision: "keep" as const,
      confidence: "high" as const,
      reason: "The finding is specific and well supported."
    }
  ]
};

test("parseAndValidateJson extracts wrapped review output", () => {
  const raw = JSON.stringify(
    {
      final_review: sampleReview,
      verdicts: sampleVerdicts
    },
    null,
    2
  );

  const parsed = parseAndValidateJson(raw, ReviewSchema);

  assert.deepEqual(parsed, sampleReview);
});

test("parseAndValidateJson extracts the matching object from multi-object text", () => {
  const raw = [
    "Saved both outputs:",
    "",
    "final_review.json",
    JSON.stringify(sampleReview, null, 2),
    "",
    "verdicts.json",
    JSON.stringify(sampleVerdicts, null, 2)
  ].join("\n");

  const parsed = parseAndValidateJson(raw, VerdictsSchema);

  assert.deepEqual(parsed, sampleVerdicts);
});

test("readAndValidateJsonWithFallback uses last message when the primary file is invalid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-review-json-"));
  const filePath = path.join(root, "final_review.json");
  const fallbackPath = path.join(root, "last_message_editor.txt");

  try {
    await fs.writeFile(filePath, JSON.stringify({ status: "not-a-review" }, null, 2), "utf8");
    await fs.writeFile(
      fallbackPath,
      [
        "Wrote the outputs.",
        "",
        "```json",
        JSON.stringify(sampleReview, null, 2),
        "```"
      ].join("\n"),
      "utf8"
    );

    const parsed = await readAndValidateJsonWithFallback(filePath, fallbackPath, ReviewSchema);

    assert.deepEqual(parsed, sampleReview);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
