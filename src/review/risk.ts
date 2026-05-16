export type ReviewFileRisk = "low" | "medium" | "high";

const HIGH_IMPACT_PATH_PATTERNS = [
  /(^|\/)(auth|security|middleware)\//,
  /(^|\/)(jwt|token|secret|permission|authorization|rate_limiter|api_key)[^/]*\./,
  /(^|\/)[^/]*(jwt|token|secret|permission|authorization|rate_limiter|api_key)[^/]*\./,
  /(^|\/)(deploy|deployment|infra|ops|patroni|pgbouncer|rabbitmq)\//,
  /(^|\/)(dockerfile|docker-compose\.(ya?ml)|patroni\.ya?ml|pgbouncer\.ini|rabbitmq\.conf)$/,
  /(^|\/)\.auth\/state\.json$/,
  /(^|\/)(background|content)\.(ts|tsx|js|jsx)$/,
  /(^|\/)packages\/web-script\/src\/backend\/[^/]*(opfs|queue)[^/]*\.(ts|tsx|js|jsx)$/,
  /(^|\/)(services|repositories|controllers)\/[^/]*(conversation|thread|session)[^/]*\./,
  /(^|\/)(models|db|migrations)\/[^/]*(conversation|thread|session)[^/]*\./,
  /(^|\/)db\/migrations\/[^/]*(conversation|thread|session)[^/]*\./
];

const STATEFUL_PATH_PATTERNS = [
  /(^|\/)(services|controllers|routers|repositories|worker|queue|db|models)\//,
  /(^|\/)[^/]*(service|controller|router|repository|worker|queue|session|conversation|thread)[^/]*\./
];

export function isHighImpactReviewPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return HIGH_IMPACT_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isStatefulReviewPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return STATEFUL_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyChangedFileRisk(params: {
  path: string;
  additions?: number;
  deletions?: number;
}): ReviewFileRisk {
  const churn = Math.max(0, params.additions || 0) + Math.max(0, params.deletions || 0);
  if (churn >= 250 || isHighImpactReviewPath(params.path)) return "high";
  if (churn >= 80 || isStatefulReviewPath(params.path)) return "medium";
  return "low";
}
