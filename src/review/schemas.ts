import { z } from "zod";

export const ReviewCommentSchema = z.object({
  comment_id: z.string(),
  comment_key: z.string(),
  path: z.string(),
  side: z.enum(["RIGHT", "LEFT"]),
  line: z.number().int().positive(),
  severity: z.enum(["blocking", "important", "nit"]),
  category: z.enum([
    "bug",
    "security",
    "performance",
    "maintainability",
    "testing",
    "style"
  ]),
  title: z.string(),
  body: z.string(),
  evidence: z.string(),
  suggested_patch: z.string().optional()
});

export const ReviewSchema = z.object({
  summary: z.object({
    overview: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    key_concerns: z.array(z.string()),
    what_to_test: z.array(z.string())
  }),
  comments: z.array(ReviewCommentSchema)
});

export const VerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      comment_id: z.string(),
      decision: z.enum(["keep", "revise", "drop"]),
      confidence: z.enum(["high", "medium", "low"]),
      reason: z.string(),
      revised_comment: z.record(z.any()).optional()
    })
  )
});

const ToolResultSchema = z.object({
  status: z.enum(["pass", "fail", "timeout", "skipped", "error"]),
  summary: z.string(),
  top_errors: z.array(z.string())
});

export const ChecksSchema = z.object({
  head_sha: z.string(),
  checks: z.object({
    lint: ToolResultSchema,
    build: ToolResultSchema,
    test: ToolResultSchema
  })
});

export const ReplySchema = z.object({
  body: z.string().min(1)
});

export type ReviewOutput = z.infer<typeof ReviewSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type VerdictsOutput = z.infer<typeof VerdictsSchema>;
export type ChecksOutput = z.infer<typeof ChecksSchema>;
export type ReplyOutput = z.infer<typeof ReplySchema>;
