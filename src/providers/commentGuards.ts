const MENTION_REPLY_MARKER = /<!--\s*grepiku-mention:\s*[\w-]+\s*-->/i;

export function normalizeBotAwareLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/i, "");
}

export function isSelfBotComment(params: { authorLogin: string; botLogin: string }): boolean {
  const author = normalizeBotAwareLogin(params.authorLogin);
  const bot = normalizeBotAwareLogin(params.botLogin);
  if (!author) return false;
  if (bot && author === bot) return true;
  return /\[bot\]$/i.test(params.authorLogin.trim()) && author.startsWith("grepiku");
}

export function isGeneratedMentionReply(body: string): boolean {
  return MENTION_REPLY_MARKER.test(body || "");
}
