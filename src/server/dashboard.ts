import { FastifyInstance } from "fastify";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

function authorize(request: any): boolean {
  if (!env.internalApiKey) return false;
  const header = request.headers["x-internal-key"] || request.headers["authorization"];
  if (!header) return false;
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) return false;
  if (token.startsWith("Bearer ")) {
    return token.slice("Bearer ".length) === env.internalApiKey;
  }
  return token === env.internalApiKey;
}

export function registerDashboard(app: FastifyInstance) {
  app.get("/dashboard", async (_request, reply) => {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Grepiku Dashboard</title>
    <style>
      body { font-family: "IBM Plex Sans", sans-serif; background: #f6f3ee; color: #1b1b1b; padding: 24px; }
      h1 { font-size: 28px; margin-bottom: 12px; }
      .card { background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
      .metric { font-size: 20px; font-weight: 600; }
      ul { padding-left: 18px; }
    </style>
  </head>
  <body>
    <h1>Grepiku Analytics</h1>
    <div class="grid">
      <div class="card">
        <div class="metric" id="run-count">Runs: --</div>
        <div class="metric" id="avg-latency">Avg Latency: --</div>
      </div>
      <div class="card">
        <div class="metric" id="acceptance">Acceptance: --</div>
        <div class="metric" id="merge-time">Avg Merge Time: --</div>
      </div>
    </div>
    <div class="card">
      <h2>Rule Suggestions</h2>
      <ul id="suggestions"></ul>
    </div>
    <div class="card">
      <h2>Insights</h2>
      <div id="insights"></div>
    </div>
    <script>
      async function load() {
        const summary = await fetch('/api/analytics/summary').then(r => r.json());
        document.getElementById('run-count').textContent = 'Runs: ' + summary.runCount;
        document.getElementById('avg-latency').textContent = 'Avg Latency: ' + summary.avgLatencyMs + 'ms';
        document.getElementById('acceptance').textContent = 'Acceptance: ' + summary.acceptanceRate + '%';
        document.getElementById('merge-time').textContent = 'Avg Merge Time: ' + summary.avgMergeTimeHours + 'h';

        const suggestions = await fetch('/api/rules/suggestions').then(r => r.json());
        const list = document.getElementById('suggestions');
        list.innerHTML = '';
        suggestions.items.forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item.reason;
          list.appendChild(li);
        });

        const insights = await fetch('/api/analytics/insights').then(r => r.json());
        const insightsDiv = document.getElementById('insights');
        insightsDiv.innerHTML = '<strong>Top Issues</strong><ul>' +
          insights.topIssues.map(i => '<li>' + i.category + ': ' + i.count + '</li>').join('') +
          '</ul><strong>Hot Paths</strong><ul>' +
          insights.hotPaths.map(i => '<li>' + i.path + ': ' + i.count + '</li>').join('') +
          '</ul>';
      }
      load();
    </script>
  </body>
</html>`;
    reply.type("text/html").send(html);
  });

  app.get("/api/analytics/summary", async (_request, reply) => {
    const runs = await prisma.reviewRun.findMany();
    const completed = runs.filter((run) => run.completedAt && run.startedAt);
    const avgLatencyMs =
      completed.length > 0
        ? Math.round(
            completed.reduce((sum, run) => sum + (run.completedAt!.getTime() - run.startedAt!.getTime()), 0) /
              completed.length
          )
        : 0;
    const feedback = await prisma.feedback.findMany();
    const positive = feedback.filter((item) => item.sentiment === "thumbs_up" || item.action === "resolved").length;
    const negative = feedback.filter((item) => item.sentiment === "thumbs_down").length;
    const acceptanceRate = positive + negative > 0 ? Math.round((positive / (positive + negative)) * 100) : 0;
    const avgMergeTimeHours = 0;
    reply.send({
      runCount: runs.length,
      avgLatencyMs,
      acceptanceRate,
      avgMergeTimeHours
    });
  });

  app.get("/api/rules/suggestions", async (_request, reply) => {
    const suggestions = await prisma.ruleSuggestion.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    reply.send({
      items: suggestions.map((suggestion) => ({
        id: suggestion.id,
        reason: suggestion.reason,
        status: suggestion.status,
        rule: suggestion.ruleJson
      }))
    });
  });

  app.post("/api/rules/suggestions/:id/approve", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const id = Number((request.params as any).id);
    const suggestion = await prisma.ruleSuggestion.findFirst({ where: { id } });
    if (!suggestion) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    await prisma.ruleSuggestion.update({ where: { id }, data: { status: "accepted" } });
    const repoConfig = await prisma.repoConfig.findFirst({ where: { repoId: suggestion.repoId } });
    if (repoConfig) {
      const config = repoConfig.configJson as any;
      config.rules = [...(config.rules || []), suggestion.ruleJson];
      await prisma.repoConfig.update({ where: { id: repoConfig.id }, data: { configJson: config } });
    }
    reply.send({ ok: true });
  });

  app.post("/api/rules/suggestions/:id/reject", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const id = Number((request.params as any).id);
    await prisma.ruleSuggestion.update({ where: { id }, data: { status: "rejected" } });
    reply.send({ ok: true });
  });

  app.get("/api/analytics/export", async (request, reply) => {
    const format = (request.query as any)?.format || "json";
    const events = await prisma.analyticsEvent.findMany({ orderBy: { createdAt: "desc" } });
    if (format === "csv") {
      const lines = ["id,repoId,runId,kind,createdAt,payload"];
      for (const event of events) {
        lines.push(
          [
            event.id,
            event.repoId,
            event.runId || "",
            event.kind,
            event.createdAt.toISOString(),
            JSON.stringify(event.payload || {}).replace(/"/g, '""')
          ].join(",")
        );
      }
      reply.type("text/csv").send(lines.join("\n"));
      return;
    }
    reply.send({ items: events });
  });

  app.get("/api/analytics/insights", async (_request, reply) => {
    const findings = await prisma.finding.findMany();
    const byCategory: Record<string, number> = {};
    const byPath: Record<string, number> = {};
    for (const finding of findings) {
      byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
      byPath[finding.path] = (byPath[finding.path] || 0) + 1;
    }
    const topIssues = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => ({ category, count }));
    const hotPaths = Object.entries(byPath)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, count]) => ({ path, count }));
    reply.send({ topIssues, hotPaths });
  });
}
