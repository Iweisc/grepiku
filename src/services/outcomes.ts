import { prisma } from "../db/client.js";
import { updateFindingWeights } from "./weights.js";

export async function detectOutcomesOnClose(params: {
  pullRequestId: number;
  repoId: number;
}): Promise<void> {
  const findings = await prisma.finding.findMany({
    where: { pullRequestId: params.pullRequestId }
  });

  if (findings.length === 0) return;

  const outcomes: Array<{ category: string; ruleId?: string; addressed: boolean }> = [];

  for (const finding of findings) {
    const addressed = finding.status === "fixed" || finding.status === "obsolete";
    outcomes.push({
      category: finding.category,
      ruleId: finding.ruleId ?? undefined,
      addressed
    });
  }

  await updateFindingWeights(params.repoId, outcomes);
}
