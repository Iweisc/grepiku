import { prisma } from "../db/client.js";

const PROTECTED_PATTERNS = [
  "security",
  "injection",
  "authz",
  "xss",
  "sql injection"
];

function isProtectedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PROTECTED_PATTERNS.some(
    (pattern) => lower === pattern || lower.startsWith(`${pattern}:`)
  );
}

function computeWeight(params: {
  addressed: number;
  ignored: number;
  positive: number;
  negative: number;
}): number {
  const outcomeTotal = params.addressed + params.ignored;
  const outcomeSignal =
    outcomeTotal > 0 ? (params.addressed - params.ignored) / (outcomeTotal + 1) : 0;

  const reactionTotal = params.positive + params.negative;
  const reactionSignal =
    reactionTotal > 0 ? (params.positive - params.negative) / (reactionTotal + 1) : 0;

  const weight = outcomeTotal > 0 && reactionTotal > 0
    ? outcomeSignal * 0.6 + reactionSignal * 0.4
    : outcomeTotal > 0
      ? outcomeSignal
      : reactionSignal;

  return Math.max(-1, Math.min(1, weight));
}

export async function updateFindingWeights(
  repoId: number,
  outcomes: Array<{ category: string; ruleId?: string; addressed: boolean }>
): Promise<void> {
  const buckets = new Map<string, { addressed: number; ignored: number }>();

  for (const outcome of outcomes) {
    const keys = [outcome.category];
    if (outcome.ruleId) {
      keys.push(`${outcome.category}:${outcome.ruleId}`);
    }
    for (const key of keys) {
      const entry = buckets.get(key) || { addressed: 0, ignored: 0 };
      if (outcome.addressed) {
        entry.addressed += 1;
      } else {
        entry.ignored += 1;
      }
      buckets.set(key, entry);
    }
  }

  for (const [key, counts] of buckets.entries()) {
    const existing = await prisma.findingWeight.findUnique({
      where: { repoId_key: { repoId, key } }
    });

    const addressed = (existing?.addressed ?? 0) + counts.addressed;
    const ignored = (existing?.ignored ?? 0) + counts.ignored;
    const positive = existing?.positive ?? 0;
    const negative = existing?.negative ?? 0;

    let weight = computeWeight({ addressed, ignored, positive, negative });
    if (isProtectedKey(key) && weight < 0) {
      weight = 0;
    }

    await prisma.findingWeight.upsert({
      where: { repoId_key: { repoId, key } },
      create: { repoId, key, weight, addressed, ignored, positive, negative },
      update: { weight, addressed, ignored }
    });
  }
}

export async function recalculateWeightsFromReactions(repoId: number): Promise<void> {
  const POSITIVE_REACTIONS = new Set(["thumbs_up", "+1", "heart", "laugh", "hooray"]);
  const NEGATIVE_REACTIONS = new Set(["thumbs_down", "-1", "confused"]);

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const feedback = await prisma.feedback.findMany({
    where: {
      createdAt: { gte: since },
      reviewRun: { pullRequest: { repoId } }
    },
    orderBy: { createdAt: "desc" },
    take: 2000
  });

  if (feedback.length === 0) return;

  const reviewComments = await prisma.reviewComment.findMany({
    where: {
      createdAt: { gte: since },
      pullRequest: { repoId }
    },
    include: { finding: true }
  });

  const providerToFinding = new Map<string, { category: string; ruleId: string | null }>();
  for (const comment of reviewComments) {
    if (!comment.finding) continue;
    providerToFinding.set(comment.providerCommentId, {
      category: comment.finding.category,
      ruleId: comment.finding.ruleId
    });
  }

  const buckets = new Map<string, { positive: number; negative: number }>();
  for (const fb of feedback) {
    if (!fb.commentId) continue;
    const finding = providerToFinding.get(fb.commentId);
    if (!finding) continue;

    const keys = [finding.category];
    if (finding.ruleId) keys.push(`${finding.category}:${finding.ruleId}`);

    for (const key of keys) {
      const entry = buckets.get(key) || { positive: 0, negative: 0 };
      if (fb.type === "reaction" && fb.sentiment) {
        if (POSITIVE_REACTIONS.has(fb.sentiment)) entry.positive += 1;
        if (NEGATIVE_REACTIONS.has(fb.sentiment)) entry.negative += 1;
      }
      if (fb.type === "reply" && fb.action === "resolved") entry.positive += 1;
      buckets.set(key, entry);
    }
  }

  for (const [key, counts] of buckets.entries()) {
    const existing = await prisma.findingWeight.findUnique({
      where: { repoId_key: { repoId, key } }
    });

    const addressed = existing?.addressed ?? 0;
    const ignored = existing?.ignored ?? 0;
    const positive = counts.positive;
    const negative = counts.negative;

    let weight = computeWeight({ addressed, ignored, positive, negative });
    if (isProtectedKey(key) && weight < 0) {
      weight = 0;
    }

    await prisma.findingWeight.upsert({
      where: { repoId_key: { repoId, key } },
      create: { repoId, key, weight, addressed, ignored, positive, negative },
      update: { weight, positive, negative }
    });
  }
}

export async function getRepoWeights(repoId: number): Promise<Map<string, number>> {
  const weights = await prisma.findingWeight.findMany({
    where: { repoId }
  });
  const map = new Map<string, number>();
  for (const w of weights) {
    map.set(w.key, w.weight);
  }
  return map;
}

// Exported for testing
export { computeWeight, isProtectedKey };
