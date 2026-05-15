import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEditorDecisionOutput,
  buildCompactEditorInput,
  buildDeterministicEditorDecisionOutput
} from "../src/review/editorDecision.js";
import type { EditorDecisionOutput, ReviewOutput } from "../src/review/schemas.js";

function reviewWithComments(): ReviewOutput {
  return {
    summary: {
      overview: "Long overview",
      risk: "high",
      confidence: 0.8,
      key_concerns: ["security", "race"],
      what_to_test: ["test auth"],
      file_breakdown: []
    },
    comments: [
      {
        comment_id: "nit-1",
        comment_key: "nit-1",
        path: "src/style.ts",
        side: "RIGHT",
        line: 4,
        severity: "nit",
        category: "style",
        title: "Style",
        body: "nit",
        evidence: "+nit",
        confidence: "high"
      },
      {
        comment_id: "bug-1",
        comment_key: "bug-1",
        path: "src/auth.ts",
        side: "RIGHT",
        line: 8,
        severity: "blocking",
        category: "security",
        title: "Auth bug",
        body: "important",
        evidence: "+bug",
        suggested_patch: "fix()",
        confidence: "high"
      },
      {
        comment_id: "bug-2",
        comment_key: "bug-2",
        path: "src/race.ts",
        side: "RIGHT",
        line: 12,
        severity: "important",
        category: "bug",
        title: "Race",
        body: "race",
        evidence: "+race",
        suggested_patch: "lock()",
        confidence: "medium"
      },
      {
        comment_id: "bug-3",
        comment_key: "bug-3",
        path: "src/plain.ts",
        side: "RIGHT",
        line: 16,
        severity: "important",
        category: "bug",
        title: "Plain bug",
        body: "plain",
        evidence: "+plain",
        suggested_patch: "plain()",
        confidence: "high"
      }
    ]
  };
}

test("buildCompactEditorInput prioritizes severe actionable findings", () => {
  const input = buildCompactEditorInput({ draft: reviewWithComments(), maxComments: 2 });

  assert.deepEqual(input.comments.map((comment) => comment.comment_id), ["bug-1", "bug-2"]);
  assert.deepEqual(input.omitted_comment_ids, ["nit-1", "bug-3"]);
  assert.equal(input.comments[0]?.has_suggested_patch, true);
});

test("applyEditorDecisionOutput keeps compact candidates and records omitted drops", () => {
  const draft = reviewWithComments();
  const editorInput = buildCompactEditorInput({ draft, maxComments: 2 });
  const decisionOutput: EditorDecisionOutput = {
    summary: {
      overview: "Edited",
      risk: "high",
      confidence: 0.9,
      key_concerns: ["security"],
      what_to_test: ["test auth"]
    },
    verdicts: {
      verdicts: [
        {
          comment_id: "bug-1",
          decision: "keep",
          confidence: "high",
          reason: "real"
        },
        {
          comment_id: "bug-2",
          decision: "drop",
          confidence: "medium",
          reason: "duplicate"
        }
      ]
    }
  };

  const result = applyEditorDecisionOutput({ draft, editorInput, decisionOutput });

  assert.deepEqual(result.finalReview.comments.map((comment) => comment.comment_id), ["bug-1"]);
  assert.equal(result.finalReview.summary.overview, "Edited");
  assert.equal(result.verdicts.verdicts.some((verdict) => verdict.comment_id === "nit-1"), true);
});

test("buildDeterministicEditorDecisionOutput keeps compact candidates without a model call", () => {
  const draft = reviewWithComments();
  const editorInput = buildCompactEditorInput({ draft, maxComments: 2 });
  const decisionOutput = buildDeterministicEditorDecisionOutput(editorInput);
  const result = applyEditorDecisionOutput({ draft, editorInput, decisionOutput });

  assert.deepEqual(result.finalReview.comments.map((comment) => comment.comment_id), ["bug-1", "bug-2"]);
  assert.equal(result.verdicts.verdicts.find((verdict) => verdict.comment_id === "bug-1")?.decision, "keep");
  assert.equal(result.verdicts.verdicts.find((verdict) => verdict.comment_id === "nit-1")?.decision, "drop");
});
