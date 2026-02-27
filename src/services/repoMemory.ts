import crypto from "crypto";
import { prisma } from "../db/client.js";
import type { RuleConfig } from "../review/config.js";

const MEMORY_REASON_PREFIX = "memory:";
const MAX_MEMORY_CHARS = 220;

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstDirectiveLine(value: string): string {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(">"));
  if (lines.length === 0) return "";
  return lines[0];
}

export function extractRepoMemoryInstruction(commentBody: string): string | null {
  if (!commentBody) return null;
  let candidate = firstDirectiveLine(commentBody);
  if (!candidate) return null;
  candidate = candidate.replace(/^@\S+\s*/g, "");
  candidate = candidate.replace(/^remember\s*:?\s*/i, "");
  candidate = candidate.replace(/^note\s*:?\s*/i, "");
  candidate = normalizeWhitespace(candidate);

  if (candidate.length < 12) return null;
  if (candidate.length > MAX_MEMORY_CHARS) {
    candidate = `${candidate.slice(0, MAX_MEMORY_CHARS - 1).trimEnd()}.`;
  }

  const directive =
    /(^|\b)(don't|do not|never|avoid|prefer|always|please avoid|please don't)\b/i.test(candidate);
  const questionLike = /\?\s*$/.test(candidate);
  const enoughWords = candidate.split(" ").filter(Boolean).length >= 4;
  if (!directive || questionLike || !enoughWords) return null;

  return candidate;
}

function normalizeReasonValue(instruction: string): string {
  return normalizeWhitespace(instruction).toLowerCase();
}

function memoryRuleId(instruction: string): string {
  const digest = crypto.createHash("sha1").update(instruction).digest("hex");
  return `memory-${digest.slice(0, 12)}`;
}

function toMemoryRule(params: {
  instruction: string;
  author?: string | null;
  commentUrl?: string | null;
}): RuleConfig {
  const instruction = normalizeWhitespace(params.instruction);
  const title = `Team preference: ${instruction}`.slice(0, 110);
  const descriptionPrefix = params.author
    ? `Learned from reviewer feedback by ${params.author}:`
    : "Learned from reviewer feedback:";
  const rule: RuleConfig = {
    id: memoryRuleId(instruction),
    title,
    description: `${descriptionPrefix} ${instruction}`,
    severity: "important",
    category: "maintainability",
    commentType: "inline",
    strictness: "medium",
    pattern: instruction,
    scope: "**/*"
  };
  if (params.commentUrl) {
    rule.docs = [params.commentUrl];
  }
  return rule;
}

export async function rememberRepoInstruction(params: {
  repoId: number;
  commentBody: string;
  author?: string | null;
  commentId?: string | null;
  commentUrl?: string | null;
}): Promise<{ stored: boolean; instruction?: string }> {
  const instruction = extractRepoMemoryInstruction(params.commentBody);
  if (!instruction) return { stored: false };

  const normalized = normalizeReasonValue(instruction);
  const reason = `${MEMORY_REASON_PREFIX}${normalized}`;
  const existing = await prisma.ruleSuggestion.findFirst({
    where: { repoId: params.repoId, reason }
  });
  if (existing) {
    return { stored: false, instruction };
  }

  const rule = toMemoryRule({
    instruction,
    author: params.author,
    commentUrl: params.commentUrl
  });

  await prisma.ruleSuggestion.create({
    data: {
      repoId: params.repoId,
      status: "pending",
      reason,
      ruleJson: {
        ...rule,
        source: "repo_memory",
        learnedFromCommentId: params.commentId || null
      }
    }
  });

  return { stored: true, instruction };
}

function coerceRuleConfig(value: unknown): RuleConfig | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || typeof source.title !== "string") return null;

  const rule: RuleConfig = {
    id: source.id,
    title: source.title
  };

  if (typeof source.description === "string") rule.description = source.description;
  if (typeof source.severity === "string") rule.severity = source.severity;
  if (typeof source.category === "string") rule.category = source.category;
  if (typeof source.pattern === "string") rule.pattern = source.pattern;
  if (typeof source.scope === "string") rule.scope = source.scope;
  if (source.commentType === "inline" || source.commentType === "summary") {
    rule.commentType = source.commentType;
  }
  if (source.strictness === "low" || source.strictness === "medium" || source.strictness === "high") {
    rule.strictness = source.strictness;
  }
  if (Array.isArray(source.docs) && source.docs.every((item) => typeof item === "string")) {
    rule.docs = source.docs as string[];
  }

  return rule;
}

export async function loadAcceptedRepoMemoryRules(repoId: number): Promise<RuleConfig[]> {
  const learned = await prisma.ruleSuggestion.findMany({
    where: {
      repoId,
      status: "accepted",
      reason: { startsWith: MEMORY_REASON_PREFIX }
    },
    orderBy: { createdAt: "asc" },
    take: 300
  });

  const rules: RuleConfig[] = [];
  for (const suggestion of learned) {
    const parsed = coerceRuleConfig(suggestion.ruleJson);
    if (parsed) rules.push(parsed);
  }
  return rules;
}

export function mergeRulesWithRepoMemory(baseRules: RuleConfig[], memoryRules: RuleConfig[]): RuleConfig[] {
  if (memoryRules.length === 0) return baseRules;
  const merged = [...baseRules];
  const seen = new Set(baseRules.map((rule) => rule.id));
  for (const rule of memoryRules) {
    if (seen.has(rule.id)) continue;
    merged.push(rule);
    seen.add(rule.id);
  }
  return merged;
}
