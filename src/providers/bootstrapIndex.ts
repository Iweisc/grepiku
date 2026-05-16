export function selectBootstrapIndexSha(params: {
  baseSha?: string | null;
  headSha?: string | null;
}): string | null {
  const baseSha = params.baseSha?.trim();
  if (baseSha) {
    return baseSha;
  }
  return null;
}

export function selectTrustedPullRequestIndexSha(params: {
  baseSha?: string | null;
  headSha?: string | null;
}): string | null {
  return selectBootstrapIndexSha(params);
}
