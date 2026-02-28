import { FastifyInstance } from "fastify";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import {
  DEFAULT_TRAVERSAL_THRESHOLDS,
  computeTraversalRunMetrics,
  summarizeTraversalMetrics,
  type TraversalRunMetrics
} from "../services/traversalMetrics.js";

const env = loadEnv();
const DASHBOARD_AUTH_REALM = "Grepiku Dashboard";
const MAX_GRAPH_EDGES = 20_000;

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseBasicAuthToken(value: string): string | null {
  const encoded = value.slice("Basic ".length).trim();
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (!decoded) return null;
    const separator = decoded.indexOf(":");
    if (separator >= 0) return decoded.slice(separator + 1);
    return decoded;
  } catch {
    return null;
  }
}

function internalApiKeyFromRequest(request: any): string | null {
  const header = request.headers["x-internal-key"] || request.headers["authorization"];
  const token = firstHeaderValue(header);
  if (!token) return null;
  if (token.startsWith("Bearer ")) {
    return token.slice("Bearer ".length);
  }
  if (token.startsWith("Basic ")) {
    return parseBasicAuthToken(token);
  }
  return token;
}

function authorize(request: any): boolean {
  if (!env.internalApiKey) return false;
  const token = internalApiKeyFromRequest(request);
  return token === env.internalApiKey;
}

function firstHeaderValue(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function isSameOriginRequest(request: any): boolean {
  const originHeader = firstHeaderValue(request.headers?.origin);
  const refererHeader = firstHeaderValue(request.headers?.referer);
  const requestOrigin = normalizeOrigin(originHeader || refererHeader || "");
  if (!requestOrigin) return false;

  const forwardedProto = firstHeaderValue(request.headers?.["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(request.headers?.["x-forwarded-host"]);
  const host = forwardedHost || firstHeaderValue(request.headers?.host);
  if (!host) return false;

  const proto = (forwardedProto || request.protocol || "http").split(",")[0]?.trim() || "http";
  const expectedOrigin = normalizeOrigin(`${proto}://${host}`);
  return Boolean(expectedOrigin && requestOrigin === expectedOrigin);
}

function canMutateRuleSuggestion(request: any): boolean {
  // Origin/Referer checks can help CSRF posture but are not authentication.
  return authorize(request);
}

function sendDashboardUnauthorized(reply: any): void {
  reply.header("WWW-Authenticate", `Basic realm="${DASHBOARD_AUTH_REALM}"`);
  reply.code(401).send({ error: "Unauthorized" });
}

/* =====================================================================
   Dashboard HTML
   ===================================================================== */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Grepiku</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-deep:#0A0705;--bg:#110D09;--bg-raised:#1A1410;--bg-raised-2:#211A14;--bg-hover:#2A2118;
  --accent:#E8734A;--accent-soft:#F4A87D;--accent-dim:rgba(232,115,74,.15);--accent-glow:rgba(232,115,74,.08);
  --border:rgba(232,115,74,.1);--border-hi:rgba(232,115,74,.22);
  --text:#F0E6DC;--text-2:#9B8A7A;--text-3:#5E5047;
  --green:#6BC46B;--green-d:rgba(107,196,107,.12);
  --yellow:#E8B44A;--yellow-d:rgba(232,180,74,.12);
  --red:#E85A4A;--red-d:rgba(232,90,74,.12);
  --f:"DM Sans",system-ui,sans-serif;
  --fm:"JetBrains Mono",monospace;
  --sw:240px;--r:14px;--rs:10px
}
html{font-size:14px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--f);background:var(--bg-deep);color:var(--text);display:flex;min-height:100vh;overflow-x:hidden}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:.025;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}

::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--text-3);border-radius:3px}

/* Sidebar */
.sb{position:fixed;top:0;left:0;bottom:0;width:var(--sw);background:var(--bg);
  border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:100}
.logo{padding:28px 22px 24px;display:flex;align-items:center;gap:12px}
.logo svg{width:34px;height:34px;color:var(--accent);flex-shrink:0}
.logo span{font-size:18px;font-weight:700;color:var(--text);letter-spacing:-.3px}
.nv{flex:1;padding:4px 12px;display:flex;flex-direction:column;gap:2px}
.ni{display:flex;align-items:center;gap:11px;padding:10px 14px;border-radius:var(--rs);
  color:var(--text-2);font-size:13px;font-weight:500;cursor:pointer;transition:all .2s;
  border:none;background:none;text-align:left;width:100%;position:relative}
.ni:hover{color:var(--text);background:var(--bg-raised)}
.ni.on{color:var(--accent);background:var(--accent-dim)}
.ni.on::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;
  background:var(--accent);border-radius:0 2px 2px 0}
.ni svg{width:18px;height:18px;flex-shrink:0;stroke-width:1.5}
.ns{height:1px;background:var(--border);margin:8px 14px}
.sf{padding:20px 22px;font-size:11px;color:var(--text-3)}

/* Main */
.mn{margin-left:var(--sw);flex:1;min-height:100vh;position:relative}
.mn::before,.mn::after{content:"";position:fixed;border-radius:50%;pointer-events:none;z-index:0}
.mn::before{top:-180px;right:-120px;width:560px;height:560px;
  background:radial-gradient(circle,rgba(232,115,74,.07) 0%,transparent 65%)}
.mn::after{bottom:-200px;left:var(--sw);width:400px;height:400px;
  background:radial-gradient(circle,rgba(232,115,74,.04) 0%,transparent 65%)}
.vw{display:none;padding:36px 40px 60px;position:relative;z-index:1}
.vw.on{display:block;animation:vIn .4s cubic-bezier(.4,0,.2,1)}
@keyframes vIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.vh{margin-bottom:32px}
.vt{font-size:26px;font-weight:700;color:var(--text);margin-bottom:4px;letter-spacing:-.3px}
.vs{font-size:13px;color:var(--text-3);font-weight:400}

/* Stats */
.sts{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.st{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:22px 24px;position:relative;overflow:hidden;transition:all .25s;
  animation:cUp .5s cubic-bezier(.4,0,.2,1) both;animation-delay:calc(var(--i,0)*90ms)}
.st::before{content:"";position:absolute;top:0;left:24px;right:24px;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.5}
.st:hover{border-color:var(--border-hi);box-shadow:0 0 40px var(--accent-glow);transform:translateY(-2px)}
.sl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:12px}
.sv{font-family:var(--fm);font-size:32px;font-weight:600;color:var(--text);line-height:1}
.sv-na{font-family:var(--fm);font-size:24px;font-weight:500;color:var(--text-3);line-height:1}
.sn{font-size:11px;color:var(--text-3);margin-top:10px}
@keyframes cUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}

/* Cards */
.cd{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:24px 26px;transition:border-color .2s,box-shadow .2s}
.cd:hover{border-color:var(--border-hi)}
.ch{font-size:16px;font-weight:600;color:var(--text);margin-bottom:18px;
  display:flex;align-items:center;justify-content:space-between}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.mt14{margin-top:14px}

/* Status labels - plain text, uniform */
.bd{font-size:12px;font-weight:500;color:var(--text-2);min-width:76px;display:inline-block;text-transform:capitalize;flex-shrink:0}

/* Reviews */
.ri{display:flex;align-items:center;gap:14px;padding:13px 0;
  border-bottom:1px solid rgba(232,115,74,.05);transition:all .15s}
.ri:last-child{border-bottom:none}
.ri:hover{padding-left:8px}
.rb{flex:1;min-width:0}
.rt{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rr{font-size:11px;color:var(--text-3);font-family:var(--fm);margin-top:2px}
.rx{display:flex;align-items:center;gap:14px;flex-shrink:0}
.rx span{font-size:11px;color:var(--text-2)}
.rtime{font-size:11px;color:var(--text-3);min-width:50px;text-align:right}

/* Repo cards */
.rg{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
.rc{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:22px 24px;transition:all .25s;animation:cUp .4s ease both}
.rc:hover{border-color:var(--border-hi);box-shadow:0 0 30px var(--accent-glow)}
.rch{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.rcn{font-family:var(--fm);font-size:13px;font-weight:600;color:var(--text)}
.rcv{font-size:10px;color:var(--text-3);border:1px solid var(--border);border-radius:20px;padding:2px 8px;text-transform:uppercase;letter-spacing:.5px}
.lang-bar{display:flex;height:5px;border-radius:3px;overflow:hidden;background:var(--bg-deep);margin:12px 0 6px}
.lang-seg{height:100%;min-width:3px}
.lang-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:10px}
.lang-dot{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--text-3)}
.lang-dot i{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
.rc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding-top:10px;border-top:1px solid rgba(232,115,74,.06)}
.rc-stat{font-size:11px;color:var(--text-3)}.rc-stat strong{display:block;font-family:var(--fm);font-size:14px;font-weight:600;color:var(--text);margin-bottom:1px}
.rc-foot{display:flex;align-items:center;justify-content:space-between;margin-top:12px}
.rc-idx{font-size:11px;color:var(--text-3)}
.rc-more{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:var(--rs);
  font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:transparent;
  color:var(--text-2);transition:all .2s;font-family:var(--f)}
.rc-more:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}

/* Bar chart */
.brow{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.blbl{width:100px;font-size:12px;color:var(--text-2);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.btrk{flex:1;height:20px;background:var(--bg-deep);border-radius:6px;overflow:hidden}
.bfil{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-soft));border-radius:6px;
  display:flex;align-items:center;padding-left:8px;transition:width .8s cubic-bezier(.25,.46,.45,.94)}
.bnum{font-size:10px;font-weight:600;color:var(--bg-deep);font-family:var(--fm)}

/* Hot paths */
.hp{display:flex;align-items:center;justify-content:space-between;padding:9px 0;
  border-bottom:1px solid rgba(232,115,74,.05)}.hp:last-child{border-bottom:none}
.hpp{font-family:var(--fm);font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:12px}
.hpc{font-family:var(--fm);font-size:11px;font-weight:600;color:var(--accent);
  background:var(--accent-dim);padding:2px 10px;border-radius:10px}

/* Rules */
.rl{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:20px 24px;margin-bottom:12px;animation:cUp .4s ease both}
.rtx{font-size:13px;color:var(--text);line-height:1.6;margin-bottom:14px}
.rla{display:flex;gap:8px}
.rbt{padding:7px 16px;border-radius:var(--rs);font-size:12px;font-weight:600;cursor:pointer;
  border:1px solid var(--border);background:transparent;color:var(--text-2);transition:all .15s;font-family:var(--f)}
.rbt:hover{border-color:var(--accent);color:var(--accent)}
.rby{border-color:var(--green);color:var(--green);background:var(--green-d)}
.rby:hover{background:var(--green);color:var(--bg-deep)}
.rbn{border-color:var(--red);color:var(--red);background:var(--red-d)}
.rbn:hover{background:var(--red);color:var(--bg-deep)}

/* Metric progress */
.mw{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.ml{width:150px;font-size:13px;color:var(--text-2);flex-shrink:0}
.mtr{flex:1;height:6px;background:var(--bg-deep);border-radius:3px;overflow:hidden}
.mfl{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.4,0,.2,1)}
.mfg{background:var(--green)}.mfy{background:var(--yellow)}.mfr{background:var(--red)}
.mfa{background:linear-gradient(90deg,var(--accent),var(--accent-soft))}
.mn2{font-family:var(--fm);font-size:13px;font-weight:500;color:var(--text);min-width:65px;text-align:right}

/* Loading / Empty */
.ld{color:var(--text-3);font-size:13px;padding:20px 0;animation:fp 1.4s ease infinite}
@keyframes fp{0%,100%{opacity:1}50%{opacity:.3}}
.em{text-align:center;padding:48px 20px;color:var(--text-3);font-size:13px;line-height:1.6}

@media(max-width:1100px){.sts{grid-template-columns:repeat(2,1fr)}.g2{grid-template-columns:1fr}}
@media(max-width:768px){.sb{width:60px}.sb .logo span,.sb .ni span{display:none}
  .mn{margin-left:60px}.vw{padding:20px}.sts{grid-template-columns:1fr}}
</style>
</head>
<body>

<aside class="sb">
  <div class="logo">
    <svg viewBox="0 0 36 40" fill="currentColor">
      <ellipse cx="10" cy="8" rx="4.5" ry="5.5" transform="rotate(-12 10 8)"/>
      <ellipse cx="18" cy="5" rx="4" ry="5"/>
      <ellipse cx="26" cy="8" rx="4.5" ry="5.5" transform="rotate(12 26 8)"/>
      <ellipse cx="5.5" cy="17" rx="3.8" ry="5" transform="rotate(-28 5.5 17)"/>
      <path d="M8 24c0-5.5 4.5-9 10-9s10 3.5 10 9c0 6.5-4.5 11-10 11S8 30.5 8 24z"/>
      <path d="M14.8 24c0-1.4 1.2-2.3 2.1-1.4l1.1 1.2 1.1-1.2c.9-.9 2.1 0 2.1 1.4 0 2-3.2 4.2-3.2 4.2s-3.2-2.2-3.2-4.2z" fill="var(--bg)"/>
    </svg>
    <span>grepiku</span>
  </div>
  <nav class="nv">
    <button class="ni on" data-v="overview" onclick="go('overview')">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg>
      <span>Overview</span>
    </button>
    <button class="ni" data-v="repos" onclick="go('repos')">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="M2 6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
      <span>Repositories</span>
    </button>
    <button class="ni" data-v="reviews" onclick="go('reviews')">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="M3 4h14a1 1 0 011 1v8a1 1 0 01-1 1H7l-4 3V5a1 1 0 011-1z"/><path d="M7 8h6M7 11h3" stroke-linecap="round"/></svg>
      <span>Reviews</span>
    </button>
    <button class="ni" data-v="rules" onclick="go('rules')">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="M10 2l7 3v5c0 4-3 6.5-7 8-4-1.5-7-4-7-8V5l7-3z"/><path d="M7.5 10l2 2 3.5-4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Rules</span>
    </button>
    <button class="ni" data-v="insights" onclick="go('insights')">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><rect x="3" y="10" width="3" height="7" rx=".5"/><rect x="8.5" y="6" width="3" height="11" rx=".5"/><rect x="14" y="3" width="3" height="14" rx=".5"/></svg>
      <span>Insights</span>
    </button>
    <div class="ns"></div>
    <button class="ni" onclick="window.open('/api/analytics/export?format=csv','_blank')">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="M10 3v10M6 9l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
      <span>Export CSV</span>
    </button>
  </nav>
  <div class="sf">AI Code Review Engine</div>
</aside>

<main class="mn">

  <!-- OVERVIEW -->
  <section id="v-overview" class="vw on">
    <div class="vh"><h1 class="vt">Overview</h1><p class="vs">Your code review analytics at a glance</p></div>
    <div class="sts">
      <div class="st" style="--i:0"><div class="sl">Total Reviews</div><div class="sv" id="s-runs">&mdash;</div><div class="sn">all time</div></div>
      <div class="st" style="--i:1"><div class="sl">Avg Latency</div><div class="sv" id="s-lat">&mdash;</div><div class="sn">per review run</div></div>
      <div class="st" style="--i:2"><div class="sl">Acceptance</div><div class="sv" id="s-acc">&mdash;</div><div class="sn">feedback score</div></div>
      <div class="st" style="--i:3"><div class="sl">Traversal Recall</div><div class="sv" id="s-rec">&mdash;</div><div class="sn">cross-file context</div></div>
    </div>
    <div class="g2">
      <div class="cd"><div class="ch">Recent Reviews</div><div id="ov-rv"><div class="ld">Loading&#8230;</div></div></div>
      <div class="cd"><div class="ch">Top Issues</div><div id="ov-is"><div class="ld">Loading&#8230;</div></div></div>
    </div>
  </section>

  <!-- REPOS -->
  <section id="v-repos" class="vw">
    <div class="vh"><h1 class="vt">Repositories</h1><p class="vs">Connected repos and indexing status</p></div>
    <div class="rg" id="rp-ls"><div class="ld">Loading&#8230;</div></div>
  </section>

  <!-- REVIEWS -->
  <section id="v-reviews" class="vw">
    <div class="vh"><h1 class="vt">Reviews</h1><p class="vs">Recent review runs and outcomes</p></div>
    <div class="cd"><div id="rv-ls"><div class="ld">Loading&#8230;</div></div></div>
  </section>

  <!-- RULES -->
  <section id="v-rules" class="vw">
    <div class="vh"><h1 class="vt">Rule Suggestions</h1><p class="vs">AI-generated rules from review patterns</p></div>
    <div id="ru-ls"><div class="ld">Loading&#8230;</div></div>
  </section>

  <!-- INSIGHTS -->
  <section id="v-insights" class="vw">
    <div class="vh"><h1 class="vt">Insights</h1><p class="vs">Trends, quality metrics, and patterns</p></div>
    <div class="g2">
      <div class="cd"><div class="ch">Issue Categories</div><div id="in-ct"><div class="ld">Loading&#8230;</div></div></div>
      <div class="cd"><div class="ch">Hot Paths</div><div id="in-hp"><div class="ld">Loading&#8230;</div></div></div>
    </div>
    <div class="cd mt14"><div class="ch">Traversal Quality</div><div id="in-tv"><div class="ld">Loading&#8230;</div></div></div>
  </section>

</main>

<script>
var L={},D=document;
function $(id){return D.getElementById(id)}
function h(s){var d=D.createElement('div');d.textContent=s;return d.innerHTML}
function ago(d){var s=Math.floor((Date.now()-new Date(d).getTime())/1e3);
  if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';
  var hr=Math.floor(m/60);if(hr<24)return hr+'h ago';return Math.floor(hr/24)+'d ago'}
function fms(ms){if(!ms)return'--';if(ms>=6e4)return(ms/6e4).toFixed(1)+'m';
  if(ms>=1e3)return(ms/1e3).toFixed(1)+'s';return ms+'ms'}
function fn(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n)}
function floc(b){var l=Math.round((b||0)/40);return fn(l)}
function get(u){return fetch(u).then(function(r){return r.json()})}
function hasRecallSamples(t){return Number((t&&t.recallSampleCount)||0)>0}
function hasPrecisionSamples(t){return Number((t&&t.precisionSampleCount)||0)>0}

var LC={typescript:'#3178C6',javascript:'#F7DF1E',python:'#3572A5',go:'#00ADD8',rust:'#CE422B',java:'#B07219',ruby:'#CC342D',css:'#563D7C',html:'#E34C26',shell:'#89E051'};
function lc(lang){return LC[(lang||'').toLowerCase()]||'#5E5047'}

function go(v){
  D.querySelectorAll('.ni').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-v')===v)});
  D.querySelectorAll('.vw').forEach(function(s){s.classList.toggle('on',s.id==='v-'+v)});
  if(!L[v]){L[v]=1;ld(v)}
}
function ld(v){
  if(v==='overview')ldOv();
  else if(v==='repos')ldRp();
  else if(v==='reviews')ldRv();
  else if(v==='rules')ldRu();
  else if(v==='insights')ldIn();
}

/* Overview - fix N/A for zero stats */
function ldOv(){
  Promise.all([get('/api/analytics/summary'),get('/api/analytics/insights'),
    get('/api/analytics/traversal'),get('/api/reviews/recent?limit=8')])
  .then(function(r){
    var s=r[0],i=r[1],t=r[2],rv=r[3];
    $('s-runs').textContent=fn(s.runCount);
    $('s-lat').textContent=fms(s.avgLatencyMs);
    if(s.acceptanceRate===null){$('s-acc').className='sv-na';$('s-acc').textContent='N/A'}
    else{$('s-acc').textContent=s.acceptanceRate+'%'}
    if(!hasRecallSamples(t)){$('s-rec').className='sv-na';$('s-rec').textContent='N/A'}
    else{$('s-rec').textContent=(t.avgCrossFileRecall*100).toFixed(1)+'%'}
    rvList('ov-rv',rv.items,8);
    bars('ov-is',i.topIssues.map(function(x){return{l:x.category,v:x.count}}));
  }).catch(function(){});
}
function ldRp(){get('/api/repos').then(function(d){rpCards(d.items)}).catch(function(){$('rp-ls').innerHTML='<div class="em">Could not load repos</div>'})}
function ldRv(){get('/api/reviews/recent?limit=30').then(function(d){rvList('rv-ls',d.items,30)}).catch(function(){$('rv-ls').innerHTML='<div class="em">Could not load reviews</div>'})}
function ldRu(){get('/api/rules/suggestions').then(function(d){ruList(d.items)}).catch(function(){$('ru-ls').innerHTML='<div class="em">Could not load rules</div>'})}
function ldIn(){
  Promise.all([get('/api/analytics/insights'),get('/api/analytics/traversal')])
  .then(function(r){
    bars('in-ct',r[0].topIssues.map(function(x){return{l:x.category,v:x.count}}));
    hpList(r[0].hotPaths);tvMetrics(r[1]);
  }).catch(function(){});
}

/* Reviews - plain text status */
function rvList(id,items,mx){
  var el=$(id);
  if(!items||!items.length){el.innerHTML='<div class="em">No reviews yet</div>';return}
  var o='';items.slice(0,mx).forEach(function(r){
    o+='<div class="ri"><span class="bd">'+h(r.status)+'</span>'
      +'<div class="rb"><div class="rt">'+h(r.prTitle||'PR #'+r.prNumber)+'</div>'
      +'<div class="rr">'+h(r.repoName||'')+(r.prNumber?' #'+r.prNumber:'')+'</div></div>'
      +'<div class="rx"><span>'+fms(r.latencyMs)+'</span>'
      +'<span>'+r.findingCount+' finding'+(r.findingCount!==1?'s':'')+'</span></div>'
      +'<div class="rtime">'+ago(r.createdAt)+'</div></div>';
  });el.innerHTML=o;
}

/* Repo cards with stats, language bar, learn more */
function rpCards(items){
  var el=$('rp-ls');
  if(!items||!items.length){el.innerHTML='<div class="em">No repositories connected</div>';return}
  var o='';items.forEach(function(r,i){
    var langs=r.languages||[];
    var totalBytes=0;langs.forEach(function(l){totalBytes+=l.bytes});
    /* language bar */
    var barHtml='<div class="lang-bar">';
    langs.forEach(function(l){
      var pct=totalBytes>0?(l.bytes/totalBytes*100):0;
      if(pct<1)pct=1;
      barHtml+='<div class="lang-seg" style="width:'+pct.toFixed(1)+'%;background:'+lc(l.lang)+'"></div>';
    });
    barHtml+='</div>';
    /* legend */
    var legHtml='<div class="lang-legend">';
    langs.slice(0,5).forEach(function(l){
      var pct=totalBytes>0?Math.round(l.bytes/totalBytes*100):0;
      legHtml+='<span class="lang-dot"><i style="background:'+lc(l.lang)+'"></i>'+h(l.lang)+' '+pct+'%</span>';
    });
    legHtml+='</div>';

    o+='<div class="rc" style="animation-delay:'+i*60+'ms">'
      +'<div class="rch"><span class="rcn">'+h(r.fullName)+'</span>'
      +'<span class="rcv">'+(r.private?'private':'public')+'</span></div>'
      +barHtml+legHtml
      +'<div class="rc-stats">'
      +'<div class="rc-stat"><strong>'+fn(r.fileCount)+'</strong>files</div>'
      +'<div class="rc-stat"><strong>'+floc(totalBytes)+'</strong>lines (est)</div>'
      +'<div class="rc-stat"><strong>'+r.contributorCount+'</strong>contributors</div>'
      +'</div>'
      +'<div class="rc-foot">'
      +'<span class="rc-idx">'+(r.lastIndexed?'Indexed '+ago(r.lastIndexed):'Not indexed')+'</span>'
      +'<button class="rc-more" onclick="window.location.href=\\'/dashboard/repo/'+r.id+'\\'">Learn more &rarr;</button>'
      +'</div></div>';
  });el.innerHTML=o;
}

function bars(id,items){
  var el=$(id);
  if(!items||!items.length){el.innerHTML='<div class="em">No data</div>';return}
  var mx=Math.max.apply(null,items.map(function(i){return i.v}));
  var o='';items.forEach(function(it){
    var pct=mx>0?Math.round(it.v/mx*100):0;
    o+='<div class="brow"><span class="blbl" title="'+h(it.l)+'">'+h(it.l)+'</span>'
      +'<div class="btrk"><div class="bfil" style="width:0" data-w="'+pct+'"><span class="bnum">'+it.v+'</span></div></div></div>';
  });el.innerHTML=o;
  setTimeout(function(){el.querySelectorAll('.bfil').forEach(function(b){b.style.width=b.getAttribute('data-w')+'%'})},60);
}
function hpList(paths){
  var el=$('in-hp');
  if(!paths||!paths.length){el.innerHTML='<div class="em">No hot paths</div>';return}
  var o='';paths.forEach(function(p){
    o+='<div class="hp"><span class="hpp" title="'+h(p.path)+'">'+h(p.path)+'</span>'
      +'<span class="hpc">'+p.count+'</span></div>';
  });el.innerHTML=o;
}
function tvMetrics(t){
  var el=$('in-tv');
  var hasRecall=hasRecallSamples(t),hasPrecision=hasPrecisionSamples(t);
  if(!hasRecall&&!hasPrecision){el.innerHTML='<div class="em">No traversal data yet. Metrics appear after review runs complete.</div>';return}
  var rc=hasRecall?(t.avgCrossFileRecall*100).toFixed(1):'N/A',pr=hasPrecision?(t.avgSupportedPrecision*100).toFixed(1):'N/A';
  var rcw=hasRecall?Number(rc):0,prw=hasPrecision?Number(pr):0;
  var p95=t.p95TraversalMs||0,nd=t.p95VisitedNodes||0;
  function fc(v){return v>=80?'mfg':v>=50?'mfy':'mfr'}
  el.innerHTML=
    '<div class="mw"><span class="ml">Cross-file Recall</span><div class="mtr"><div class="mfl '+(hasRecall?fc(rcw):'mfa')+'" style="width:'+rcw+'%"></div></div><span class="mn2">'+(hasRecall?rc+'%':'N/A')+'</span></div>'
   +'<div class="mw"><span class="ml">Supported Precision</span><div class="mtr"><div class="mfl '+(hasPrecision?fc(prw):'mfa')+'" style="width:'+prw+'%"></div></div><span class="mn2">'+(hasPrecision?pr+'%':'N/A')+'</span></div>'
   +'<div class="mw"><span class="ml">p95 Latency</span><div class="mtr"><div class="mfl mfa" style="width:'+Math.min(p95/500*100,100)+'%"></div></div><span class="mn2">'+fms(p95)+'</span></div>'
   +'<div class="mw"><span class="ml">p95 Visited Nodes</span><div class="mtr"><div class="mfl mfa" style="width:'+Math.min(nd/200*100,100)+'%"></div></div><span class="mn2">'+nd+'</span></div>';
}
function ruList(items){
  var el=$('ru-ls');
  if(!items||!items.length){el.innerHTML='<div class="em">No rule suggestions yet. Grepiku will suggest rules as it learns from your reviews.</div>';return}
  var o='';items.forEach(function(r,i){
    var acts=r.status==='pending'
      ?'<button class="rbt rby" onclick="rAct('+r.id+',\\'approve\\')">Approve</button>'
       +'<button class="rbt rbn" onclick="rAct('+r.id+',\\'reject\\')">Reject</button>':'';
    o+='<div class="rl" style="animation-delay:'+i*50+'ms">'
      +'<div style="margin-bottom:10px"><span class="bd">'+h(r.status)+'</span></div>'
      +'<div class="rtx">'+h(r.reason)+'</div>'
      +'<div class="rla">'+acts+'</div></div>';
  });el.innerHTML=o;
}
function rAct(id,action){
  fetch('/api/rules/suggestions/'+id+'/'+action,{method:'POST'}).then(function(){L['rules']=0;ldRu()});
}
L['overview']=1;ldOv();
</script>
</body>
</html>`;

/* =====================================================================
   Repo detail page — full-page with interactive dependency graph
   ===================================================================== */
const REPO_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Grepiku - Repository</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-deep:#0A0705;--bg:#110D09;--bg-raised:#1A1410;--bg-raised-2:#211A14;
  --accent:#E8734A;--accent-soft:#F4A87D;--accent-dim:rgba(232,115,74,.15);--accent-glow:rgba(232,115,74,.08);
  --border:rgba(232,115,74,.1);--border-hi:rgba(232,115,74,.22);
  --text:#F0E6DC;--text-2:#9B8A7A;--text-3:#5E5047;
  --f:"DM Sans",system-ui,sans-serif;--fm:"JetBrains Mono",monospace;
  --r:14px;--rs:10px
}
html,body{height:100%}
html{font-size:14px;-webkit-font-smoothing:antialiased}
body{font-family:var(--f);background:var(--bg-deep);color:var(--text);overflow-x:hidden}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:.025;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--text-3);border-radius:3px}

.top{padding:24px 36px;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--border)}
.back{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--rs);border:1px solid var(--border);
  background:transparent;color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--f);text-decoration:none}
.back:hover{border-color:var(--accent);color:var(--accent)}
.top-title{font-size:20px;font-weight:700;color:var(--text);font-family:var(--fm)}
.top-vis{font-size:10px;color:var(--text-3);border:1px solid var(--border);border-radius:20px;padding:2px 8px;text-transform:uppercase;letter-spacing:.5px}

.info{padding:28px 36px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;grid-column:1/-1}
.sm{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--rs);padding:14px 16px;text-align:center}
.sm strong{display:block;font-family:var(--fm);font-size:20px;font-weight:600;color:var(--text);margin-bottom:3px}
.sm span{font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px}
.section{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);padding:20px 22px}
.sec-title{font-size:14px;font-weight:600;color:var(--text);margin-bottom:12px}
.lang-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bg-deep);margin-bottom:8px}
.lang-seg{height:100%;min-width:3px}
.lang-legend{display:flex;flex-wrap:wrap;gap:4px 10px}
.lang-dot{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--text-3)}
.lang-dot i{width:7px;height:7px;border-radius:50%;display:inline-block}
/* Lang detail rows */
.lang-rows{margin-top:14px}
.lang-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(232,115,74,.05)}
.lang-row:last-child{border-bottom:none}
.lang-row-color{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.lang-row-name{font-size:12px;font-weight:600;color:var(--text);width:90px;flex-shrink:0}
.lang-row-bar{flex:1;height:6px;background:var(--bg-deep);border-radius:3px;overflow:hidden}
.lang-row-fill{height:100%;border-radius:3px}
.lang-row-stats{display:flex;gap:12px;flex-shrink:0;font-size:11px;color:var(--text-2);font-family:var(--fm)}
.lang-row-stats span{min-width:60px;text-align:right}

.dep-list{list-style:none;padding:0}
.dep-item{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(232,115,74,.05);font-size:12px}
.dep-item:last-child{border-bottom:none}
.dep-name{font-family:var(--fm);color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:12px}
.dep-count{font-family:var(--fm);font-weight:600;color:var(--accent);background:var(--accent-dim);padding:2px 8px;border-radius:8px;font-size:11px;flex-shrink:0}
.dep-empty{padding:24px;text-align:center;color:var(--text-3);font-size:13px}

/* Graph */
.graph-section{padding:0 36px 36px}
.graph-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.graph-title{font-size:16px;font-weight:700;color:var(--text)}
.graph-hint{font-size:11px;color:var(--text-3)}
.graph-wrap{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;position:relative}
.graph-wrap canvas{display:block;width:100%;cursor:grab}
.graph-wrap canvas:active{cursor:grabbing}
.graph-legend{display:flex;flex-wrap:wrap;gap:10px;padding:12px 16px;border-top:1px solid var(--border)}
.legend-item{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-3)}
.legend-item i{width:10px;height:10px;border-radius:50%;display:inline-block}
.graph-tooltip{position:absolute;top:0;left:0;padding:4px 10px;background:var(--bg-raised-2);border:1px solid var(--border-hi);
  border-radius:6px;font-family:var(--fm);font-size:11px;color:var(--text);pointer-events:none;white-space:nowrap;
  opacity:0;transition:opacity .15s;z-index:10}
.ld{color:var(--text-3);font-size:13px;padding:20px;text-align:center;animation:fp 1.4s ease infinite}
@keyframes fp{0%,100%{opacity:1}50%{opacity:.3}}
@media(max-width:900px){.info{grid-template-columns:1fr}.stats-row{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="top">
  <a class="back" href="/dashboard">&larr; Dashboard</a>
  <span class="top-title" id="repo-name">Loading...</span>
  <span class="top-vis" id="repo-vis"></span>
</div>
<div id="info-area"><div class="ld">Loading...</div></div>
<div class="graph-section">
  <div class="graph-header">
    <span class="graph-title">File Dependency Graph</span>
    <span class="graph-hint">Scroll to zoom &middot; Drag to pan &middot; Hover for details</span>
  </div>
  <div class="graph-wrap" id="graph-wrap">
    <canvas id="gc"></canvas>
    <div class="graph-tooltip" id="tooltip"></div>
    <div class="graph-legend" id="legend"></div>
  </div>
</div>

<script>
var D=document;
function $(id){return D.getElementById(id)}
function h(s){var d=D.createElement('div');d.textContent=s;return d.innerHTML}
function fn(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n)}
function floc(b){return fn(Math.round((b||0)/40))}
function ago(d){var s=Math.floor((Date.now()-new Date(d).getTime())/1e3);if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var hr=Math.floor(m/60);if(hr<24)return hr+'h ago';return Math.floor(hr/24)+'d ago'}
function get(u){return fetch(u).then(function(r){return r.json()})}

var LC={typescript:'#3178C6',javascript:'#F7DF1E',python:'#3572A5',go:'#00ADD8',rust:'#CE422B',java:'#B07219',ruby:'#CC342D',css:'#563D7C',html:'#E34C26',shell:'#89E051'};
function lc(lang){return LC[(lang||'').toLowerCase()]||'#5E5047'}

var MC=['#E8734A','#3178C6','#6BC46B','#E8B44A','#CE422B','#3572A5','#F7DF1E','#CC342D','#563D7C','#00ADD8','#89E051','#9B8A7A'];

var repoId=window.location.pathname.split('/').pop();

/* Load repo info */
get('/api/repos').then(function(d){
  var r=null;
  d.items.forEach(function(item){if(String(item.id)===repoId)r=item});
  if(!r){$('repo-name').textContent='Repo not found';return}
  $('repo-name').textContent=r.fullName;
  $('repo-vis').textContent=r.private?'private':'public';
  D.title='Grepiku - '+r.fullName;

  var langs=r.languages||[];
  var tb=0;langs.forEach(function(l){tb+=l.bytes});
  var o='<div class="info"><div class="stats-row">';
  o+='<div class="sm"><strong>'+fn(r.fileCount)+'</strong><span>Files</span></div>';
  o+='<div class="sm"><strong>'+floc(tb)+'</strong><span>LOC (est)</span></div>';
  o+='<div class="sm"><strong>'+r.prCount+'</strong><span>Pull Requests</span></div>';
  o+='<div class="sm"><strong>'+r.contributorCount+'</strong><span>Contributors</span></div>';
  o+='</div>';

  /* Languages */
  if(langs.length>0){
    o+='<div class="section"><div class="sec-title">Languages</div><div class="lang-bar">';
    langs.forEach(function(l){var p=tb>0?(l.bytes/tb*100):0;if(p<1)p=1;o+='<div class="lang-seg" style="width:'+p.toFixed(1)+'%;background:'+lc(l.lang)+'"></div>'});
    o+='</div>';
    /* Detailed per-language rows */
    o+='<div class="lang-rows">';
    langs.forEach(function(l){
      var p=tb>0?(l.bytes/tb*100):0;
      var loc=Math.round((l.bytes||0)/40);
      o+='<div class="lang-row">'
        +'<span class="lang-row-color" style="background:'+lc(l.lang)+'"></span>'
        +'<span class="lang-row-name">'+h(l.lang)+'</span>'
        +'<div class="lang-row-bar"><div class="lang-row-fill" style="width:'+p.toFixed(1)+'%;background:'+lc(l.lang)+'"></div></div>'
        +'<div class="lang-row-stats">'
        +'<span>'+p.toFixed(1)+'%</span>'
        +'<span>'+fn(l.files)+' files</span>'
        +'<span>~'+fn(loc)+' loc</span>'
        +'</div></div>';
    });
    o+='</div></div>';
  }

  /* Top imports - fetch from graph data */
  o+='<div class="section" id="deps-section"><div class="sec-title">Top Dependencies</div><div class="ld">Loading...</div></div>';
  o+='</div>';
  $('info-area').innerHTML=o;
});

/* Load graph */
get('/api/repos/'+repoId+'/graph').then(function(data){
  if(!data.nodes||!data.nodes.length){
    $('gc').style.display='none';
    $('legend').innerHTML='<span style="padding:40px;color:var(--text-3)">No graph data. Run the indexer to build the dependency graph.</span>';
    return;
  }

  /* Fill top deps sidebar */
  var inMap={};
  data.edges.forEach(function(e){inMap[e.t]=(inMap[e.t]||0)+1});
  var topDeps=data.nodes.slice().sort(function(a,b){return(inMap[b.id]||0)-(inMap[a.id]||0)}).slice(0,12);
  var ds=$('deps-section');
  if(ds){
    var dh='<div class="sec-title">Most Imported Files</div><ul class="dep-list">';
    topDeps.forEach(function(d){
      var ct=inMap[d.id]||0;if(ct===0)return;
      var short=d.key.length>40?'...'+d.key.slice(-37):d.key;
      dh+='<li class="dep-item"><span class="dep-name" title="'+h(d.key)+'">'+h(short)+'</span><span class="dep-count">'+ct+'</span></li>';
    });
    dh+='</ul>';ds.innerHTML=dh;
  }

  /* Module color map */
  var modColor={};
  data.modules.forEach(function(m,i){modColor[m]=MC[i%MC.length]});

  /* Build node array with positions */
  var N=data.nodes.map(function(n){
    return{id:n.id,key:n.key,mod:n.module,inDeg:n.inDeg,color:modColor[n.module]||'#5E5047',
      x:0,y:0,vx:0,vy:0,r:3+Math.min((n.inDeg||0)*0.6,10)};
  });
  var nm={};N.forEach(function(n,i){nm[n.id]=i});
  var E=data.edges.map(function(e){return{si:nm[e.s],ti:nm[e.t],w:e.w,inf:e.inferred}}).filter(function(e){return e.si!==undefined&&e.ti!==undefined});

  /* Canvas setup */
  var canvas=$('gc');
  var wrap=$('graph-wrap');
  var W=wrap.clientWidth,H=Math.max(500,window.innerHeight-wrap.getBoundingClientRect().top-80);
  var dpr=window.devicePixelRatio||1;
  canvas.width=W*dpr;canvas.height=H*dpr;
  canvas.style.width=W+'px';canvas.style.height=H+'px';
  var ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);

  /* Initial positions - cluster by module */
  var modIdx={};var mi=0;
  data.modules.forEach(function(m){modIdx[m]=mi++;});
  var modCount=data.modules.length||1;
  N.forEach(function(n){
    var a=(modIdx[n.mod]||0)/modCount*Math.PI*2;
    var spread=W*0.25;
    n.x=W/2+Math.cos(a)*spread+(Math.random()-.5)*80;
    n.y=H/2+Math.sin(a)*spread+(Math.random()-.5)*80;
  });

  /* Force simulation */
  var simAlpha=1;
  function simStep(){
    simAlpha*=0.993;
    if(simAlpha<0.002)return false;
    var i,j,k,dx,dy,d2,d,f;
    /* Repulsion */
    for(i=0;i<N.length;i++){
      for(j=i+1;j<N.length;j++){
        dx=N[j].x-N[i].x;dy=N[j].y-N[i].y;
        d2=dx*dx+dy*dy;if(d2<1)d2=1;
        f=800*simAlpha/d2;
        d=Math.sqrt(d2);
        N[i].vx-=dx/d*f;N[i].vy-=dy/d*f;
        N[j].vx+=dx/d*f;N[j].vy+=dy/d*f;
      }
    }
    /* Attraction along edges */
    for(k=0;k<E.length;k++){
      var s=N[E[k].si],t=N[E[k].ti];
      dx=t.x-s.x;dy=t.y-s.y;d=Math.sqrt(dx*dx+dy*dy)||1;
      f=(d-60)*0.003*simAlpha*(E[k].inf?0.5:1);
      s.vx+=dx/d*f;s.vy+=dy/d*f;
      t.vx-=dx/d*f;t.vy-=dy/d*f;
    }
    /* Module clustering */
    for(i=0;i<N.length;i++){
      var a=(modIdx[N[i].mod]||0)/modCount*Math.PI*2;
      var cx=W/2+Math.cos(a)*W*0.18,cy=H/2+Math.sin(a)*H*0.18;
      N[i].vx+=(cx-N[i].x)*0.0004*simAlpha;
      N[i].vy+=(cy-N[i].y)*0.0004*simAlpha;
    }
    /* Center + damping */
    for(i=0;i<N.length;i++){
      N[i].vx+=(W/2-N[i].x)*0.0005*simAlpha;
      N[i].vy+=(H/2-N[i].y)*0.0005*simAlpha;
      N[i].vx*=0.88;N[i].vy*=0.88;
      N[i].x+=N[i].vx;N[i].y+=N[i].vy;
    }
    return true;
  }

  /* Pan/zoom state */
  var zoom=1,panX=0,panY=0;
  var dragging=false,dragStart=null,hoverNode=null;

  function draw(){
    ctx.save();
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    ctx.translate(panX,panY);
    ctx.scale(zoom,zoom);

    /* Edges */
    ctx.lineWidth=0.5/zoom;
    for(var k=0;k<E.length;k++){
      var s=N[E[k].si],t=N[E[k].ti];
      ctx.strokeStyle=E[k].inf?'rgba(232,115,74,0.04)':'rgba(232,115,74,0.1)';
      ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.lineTo(t.x,t.y);ctx.stroke();
    }

    /* Nodes */
    for(var i=0;i<N.length;i++){
      var n=N[i];
      ctx.beginPath();ctx.arc(n.x,n.y,n.r,0,Math.PI*2);
      ctx.fillStyle=n.color;
      ctx.globalAlpha=n===hoverNode?1:0.7;
      ctx.fill();
      if(n===hoverNode){
        ctx.strokeStyle=n.color;ctx.lineWidth=2/zoom;ctx.stroke();
      }
    }
    ctx.globalAlpha=1;

    /* Hover: highlight connected edges */
    if(hoverNode){
      var hi=nm[hoverNode.id];
      ctx.lineWidth=1.5/zoom;ctx.strokeStyle=hoverNode.color;
      for(var k=0;k<E.length;k++){
        if(E[k].si===hi||E[k].ti===hi){
          var s=N[E[k].si],t=N[E[k].ti];
          ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.lineTo(t.x,t.y);ctx.stroke();
        }
      }
    }

    ctx.restore();

    /* Tooltip */
    var tip=$('tooltip');
    if(hoverNode){
      tip.textContent=hoverNode.key+(hoverNode.inDeg?' ('+hoverNode.inDeg+' imports)':'');
      tip.style.opacity='1';
    } else {
      tip.style.opacity='0';
    }
  }

  /* Run sim with animation */
  function animate(){
    var running=simStep();
    draw();
    if(running)requestAnimationFrame(animate);
  }
  animate();

  /* Mouse interaction */
  function toGraph(ex,ey){return{x:(ex-panX)/zoom,y:(ey-panY)/zoom}}

  canvas.addEventListener('mousemove',function(e){
    var rect=canvas.getBoundingClientRect();
    var mx=e.clientX-rect.left,my=e.clientY-rect.top;
    var g=toGraph(mx,my);

    if(dragging&&dragStart){
      panX+=mx-dragStart.x;panY+=my-dragStart.y;
      dragStart={x:mx,y:my};
      draw();return;
    }

    /* Find hover node */
    hoverNode=null;var minD=12/zoom;
    for(var i=0;i<N.length;i++){
      var dx=N[i].x-g.x,dy=N[i].y-g.y;
      var dd=Math.sqrt(dx*dx+dy*dy);
      if(dd<minD){minD=dd;hoverNode=N[i]}
    }
    canvas.style.cursor=hoverNode?'pointer':'grab';

    /* Position tooltip near cursor */
    if(hoverNode){
      var tip=$('tooltip');
      tip.style.left=(mx+14)+'px';tip.style.top=(my-8)+'px';
    }
    if(simAlpha<0.002)draw();
  });

  canvas.addEventListener('mousedown',function(e){
    dragging=true;
    var rect=canvas.getBoundingClientRect();
    dragStart={x:e.clientX-rect.left,y:e.clientY-rect.top};
  });
  canvas.addEventListener('mouseup',function(){dragging=false;dragStart=null});
  canvas.addEventListener('mouseleave',function(){dragging=false;dragStart=null;hoverNode=null;if(simAlpha<0.002)draw()});

  canvas.addEventListener('wheel',function(e){
    e.preventDefault();
    var rect=canvas.getBoundingClientRect();
    var mx=e.clientX-rect.left,my=e.clientY-rect.top;
    var factor=e.deltaY>0?0.92:1.08;
    panX=mx-(mx-panX)*factor;
    panY=my-(my-panY)*factor;
    zoom*=factor;
    zoom=Math.max(0.1,Math.min(10,zoom));
    if(simAlpha<0.002)draw();
  },{passive:false});

  /* Legend */
  var legHtml='';
  data.modules.forEach(function(m){
    legHtml+='<span class="legend-item"><i style="background:'+(modColor[m]||'#5E5047')+'"></i>'+h(m)+'</span>';
  });
  legHtml+='<span class="legend-item" style="margin-left:auto;font-size:10px;color:var(--text-3)">'+data.nodes.length+' files &middot; '+data.edges.length+' deps</span>';
  $('legend').innerHTML=legHtml;
});
</script>
</body>
</html>`;

/* =====================================================================
   Route registration
   ===================================================================== */
export function registerDashboard(app: FastifyInstance) {
  app.register(async (dashboardApp) => {
    dashboardApp.addHook("onRequest", async (request, reply) => {
      if (authorize(request)) return;
      sendDashboardUnauthorized(reply);
      return reply;
    });

    dashboardApp.get("/dashboard", async (_request, reply) => {
      reply.type("text/html").send(DASHBOARD_HTML);
    });

    /* --- Repo detail page --- */
    dashboardApp.get("/dashboard/repo/:id", async (_request, reply) => {
      reply.type("text/html").send(REPO_PAGE_HTML);
    });

    /* --- Repos listing (enriched with language, LOC, contributors) --- */
    dashboardApp.get("/api/repos", async (_request, reply) => {
      const repos = await prisma.repo.findMany({
        orderBy: { updatedAt: "desc" },
        include: {
          _count: { select: { files: true, pullRequests: true } },
          indexRuns: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { completedAt: true, status: true }
          }
        }
      });
      const items = await Promise.all(
        repos.map(async (r) => {
          const [langStats, contribs] = await Promise.all([
            prisma.fileIndex.groupBy({
              by: ["language"],
              where: { repoId: r.id, isPattern: false, language: { not: null } },
              _count: { id: true },
              _sum: { size: true },
              orderBy: { _count: { id: "desc" } },
              take: 8
            }),
            prisma.pullRequest.findMany({
              where: { repoId: r.id, authorId: { not: null } },
              select: { authorId: true },
              distinct: ["authorId"]
            })
          ]);
          return {
            id: r.id,
            owner: r.owner,
            name: r.name,
            fullName: r.fullName,
            private: r.private,
            archived: r.archived,
            defaultBranch: r.defaultBranch,
            fileCount: r._count.files,
            prCount: r._count.pullRequests,
            lastIndexed: r.indexRuns[0]?.completedAt ?? null,
            indexStatus: r.indexRuns[0]?.status ?? "none",
            contributorCount: contribs.length,
            languages: langStats.map((l) => ({
              lang: l.language || "unknown",
              files: l._count.id,
              bytes: l._sum.size || 0
            }))
          };
        })
      );
      reply.send({ items });
    });

    /* --- Repo full graph (file dep graph used by grepiku) --- */
    dashboardApp.get("/api/repos/:id/graph", async (request, reply) => {
    const repoId = Number((request.params as any).id);
    if (!Number.isInteger(repoId) || repoId <= 0) {
      reply.code(400).send({ error: "Invalid repo id" });
      return;
    }

    const fileNodes = await prisma.graphNode.findMany({
      where: { repoId, type: "file" },
      select: { id: true, key: true }
    });
    if (fileNodes.length === 0) {
      reply.send({ nodes: [], edges: [], modules: [] });
      return;
    }

    const nodeIds = fileNodes.map((n) => n.id);
    const allEdges = await prisma.graphEdge.findMany({
      where: {
        repoId,
        type: { in: ["file_dep", "file_dep_inferred"] },
        fromNodeId: { in: nodeIds },
        toNodeId: { in: nodeIds }
      },
      select: { fromNodeId: true, toNodeId: true, type: true, data: true },
      take: MAX_GRAPH_EDGES
    });

    // Compute degree per node
    const inDeg: Record<number, number> = {};
    const outDeg: Record<number, number> = {};
    for (const e of allEdges) {
      inDeg[e.toNodeId] = (inDeg[e.toNodeId] || 0) + 1;
      outDeg[e.fromNodeId] = (outDeg[e.fromNodeId] || 0) + 1;
    }

    // If too many nodes, keep the most connected
    let selected = fileNodes;
    if (fileNodes.length > 300) {
      selected = fileNodes
        .map((n) => ({ ...n, deg: (inDeg[n.id] || 0) + (outDeg[n.id] || 0) }))
        .sort((a, b) => b.deg - a.deg)
        .slice(0, 300);
    }
    const selectedIds = new Set(selected.map((n) => n.id));
    const edges = allEdges.filter(
      (e) => selectedIds.has(e.fromNodeId) && selectedIds.has(e.toNodeId)
    );

    // Compute modules
    const moduleSet = new Set<string>();
    const nodeModule: Record<number, string> = {};
    for (const n of selected) {
      const parts = n.key.split("/");
      const mod = parts.length > 1 ? parts[0] : "(root)";
      moduleSet.add(mod);
      nodeModule[n.id] = mod;
    }

    reply.send({
      nodes: selected.map((n) => ({
        id: n.id,
        key: n.key,
        module: nodeModule[n.id],
        inDeg: inDeg[n.id] || 0
      })),
      edges: edges.map((e) => ({
        s: e.fromNodeId,
        t: e.toNodeId,
        w: (e.data as any)?.weight || 1,
        inferred: e.type === "file_dep_inferred"
      })),
      modules: Array.from(moduleSet).sort()
    });
    });

    /* --- Recent reviews --- */
    dashboardApp.get("/api/reviews/recent", async (request, reply) => {
    const limit = parseBoundedInt((request.query as any)?.limit, 20, 1, 100);
    const runs = await prisma.reviewRun.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        pullRequest: {
          select: { number: true, title: true, repo: { select: { fullName: true } } }
        },
        _count: { select: { findings: true } }
      }
    });
    reply.send({
      items: runs.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        prNumber: r.pullRequest.number,
        prTitle: r.pullRequest.title,
        repoName: r.pullRequest.repo.fullName,
        findingCount: r._count.findings,
        latencyMs:
          r.completedAt && r.startedAt
            ? r.completedAt.getTime() - r.startedAt.getTime()
            : null,
        createdAt: r.createdAt
      }))
    });
    });

    /* --- Analytics summary (null acceptance when no feedback) --- */
    dashboardApp.get("/api/analytics/summary", async (_request, reply) => {
    const runs = await prisma.reviewRun.findMany();
    const completed = runs.filter((run) => run.completedAt && run.startedAt);
    const avgLatencyMs =
      completed.length > 0
        ? Math.round(
            completed.reduce(
              (sum, run) => sum + (run.completedAt!.getTime() - run.startedAt!.getTime()),
              0
            ) / completed.length
          )
        : 0;
    const feedback = await prisma.feedback.findMany();
    const positive = feedback.filter(
      (item) => item.sentiment === "thumbs_up" || item.action === "resolved"
    ).length;
    const negative = feedback.filter((item) => item.sentiment === "thumbs_down").length;
    const acceptanceRate =
      positive + negative > 0 ? Math.round((positive / (positive + negative)) * 100) : null;
    const avgMergeTimeHours = 0;
    reply.send({ runCount: runs.length, avgLatencyMs, acceptanceRate, avgMergeTimeHours });
    });

    /* --- Rule suggestions --- */
    dashboardApp.get("/api/rules/suggestions", async (_request, reply) => {
    const suggestions = await prisma.ruleSuggestion.findMany({
      orderBy: { createdAt: "desc" },
      take: 20
    });
    reply.send({
      items: suggestions.map((s) => ({
        id: s.id,
        reason: s.reason,
        status: s.status,
        rule: s.ruleJson
      }))
    });
    });

    /* --- Traversal analytics (null when no data) --- */
    dashboardApp.get("/api/analytics/traversal", async (request, reply) => {
    const limit = parseBoundedInt((request.query as any)?.limit, 500, 20, 5000);
    const repoIdFilter = Number((request.query as any)?.repoId || 0) || undefined;
    const events = await prisma.analyticsEvent.findMany({
      where: {
        kind: "traversal_run",
        ...(repoIdFilter ? { repoId: repoIdFilter } : {})
      },
      orderBy: { createdAt: "desc" },
      take: limit
    });

    const runs: TraversalRunMetrics[] = [];
    for (const event of events) {
      const payload = event.payload as any;
      if (!payload || typeof payload !== "object") continue;
      if (typeof payload.repoId !== "number" || typeof payload.runId !== "number") continue;
      runs.push(payload as TraversalRunMetrics);
    }

    if (runs.length === 0) {
      const reviewRuns = await prisma.reviewRun.findMany({
        where: {
          status: "completed",
          ...(repoIdFilter ? { pullRequest: { repoId: repoIdFilter } } : {})
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          pullRequest: { select: { repoId: true } },
          findings: { select: { path: true, status: true } }
        }
      });
      const repoFileCountCache = new Map<number, number>();
      for (const run of reviewRuns) {
        if (!run.contextPackJson || typeof run.contextPackJson !== "object") continue;
        const repoId = run.pullRequest.repoId;
        if (!repoFileCountCache.has(repoId)) {
          const count = await prisma.fileIndex.count({ where: { repoId, isPattern: false } });
          repoFileCountCache.set(repoId, count);
        }
        const metric = computeTraversalRunMetrics({
          runId: run.id,
          repoId,
          contextPack: run.contextPackJson,
          findings: run.findings,
          repoFileCount: repoFileCountCache.get(repoId) || 0
        });
        if (metric) runs.push(metric);
      }
    }

    if (runs.length === 0) {
      reply.send({
        avgCrossFileRecall: null,
        avgSupportedPrecision: null,
        p95TraversalMs: null,
        p95VisitedNodes: null,
        recentRuns: []
      });
      return;
    }

    const summary = summarizeTraversalMetrics(runs, DEFAULT_TRAVERSAL_THRESHOLDS);
    reply.send({ ...summary, recentRuns: runs.slice(0, 30) });
    });

    /* --- Approve rule --- */
    dashboardApp.post("/api/rules/suggestions/:id/approve", async (request, reply) => {
    if (!canMutateRuleSuggestion(request)) {
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
    const repoConfig = await prisma.repoConfig.findFirst({
      where: { repoId: suggestion.repoId }
    });
    if (repoConfig) {
      const config = repoConfig.configJson as any;
      config.rules = [...(config.rules || []), suggestion.ruleJson];
      await prisma.repoConfig.update({
        where: { id: repoConfig.id },
        data: { configJson: config }
      });
    }
    reply.send({ ok: true });
    });

    /* --- Reject rule --- */
    dashboardApp.post("/api/rules/suggestions/:id/reject", async (request, reply) => {
    if (!canMutateRuleSuggestion(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const id = Number((request.params as any).id);
    await prisma.ruleSuggestion.update({ where: { id }, data: { status: "rejected" } });
    reply.send({ ok: true });
    });

    /* --- Export --- */
    dashboardApp.get("/api/analytics/export", async (request, reply) => {
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

    /* --- Insights --- */
    dashboardApp.get("/api/analytics/insights", async (_request, reply) => {
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
  });
}

export const __dashboardInternals = {
  authorize,
  isSameOriginRequest,
  parseBasicAuthToken
};
