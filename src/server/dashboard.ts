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
  return authorize(request) || isSameOriginRequest(request);
}

/* =====================================================================
   Dashboard HTML — "Obsidian & Ember" dark warm aesthetic
   ===================================================================== */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Grepiku</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
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
  --fd:"Instrument Serif",Georgia,serif;
  --fb:"Plus Jakarta Sans",system-ui,sans-serif;
  --fm:"JetBrains Mono",monospace;
  --sw:240px;--r:14px;--rs:10px
}
html{font-size:14px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--fb);background:var(--bg-deep);color:var(--text);display:flex;min-height:100vh;overflow-x:hidden}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:.025;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}

::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--text-3);border-radius:3px}

/* ---- Sidebar ---- */
.sb{position:fixed;top:0;left:0;bottom:0;width:var(--sw);background:var(--bg);
  border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:100}
.logo{padding:28px 22px 24px;display:flex;align-items:center;gap:12px}
.logo svg{width:34px;height:34px;color:var(--accent);flex-shrink:0}
.logo span{font-family:var(--fd);font-size:22px;color:var(--text);letter-spacing:-.3px}
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

/* ---- Main ---- */
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
.vt{font-family:var(--fd);font-size:32px;color:var(--text);margin-bottom:4px}
.vs{font-size:13px;color:var(--text-3);font-weight:400}

/* ---- Stats ---- */
.sts{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.st{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:22px 24px;position:relative;overflow:hidden;transition:all .25s;
  animation:cUp .5s cubic-bezier(.4,0,.2,1) both;animation-delay:calc(var(--i,0)*90ms)}
.st::before{content:"";position:absolute;top:0;left:24px;right:24px;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.5}
.st:hover{border-color:var(--border-hi);box-shadow:0 0 40px var(--accent-glow);transform:translateY(-2px)}
.sl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:12px}
.sv{font-family:var(--fm);font-size:32px;font-weight:600;color:var(--text);line-height:1}
.sn{font-size:11px;color:var(--text-3);margin-top:10px}
@keyframes cUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}

/* ---- Cards ---- */
.cd{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:24px 26px;transition:border-color .2s,box-shadow .2s}
.cd:hover{border-color:var(--border-hi)}
.ch{font-family:var(--fd);font-size:18px;color:var(--text);margin-bottom:18px;
  display:flex;align-items:center;justify-content:space-between}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.mt14{margin-top:14px}

/* ---- Badges ---- */
.bd{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
  font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase}
.bdt{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.bc{background:var(--green-d);color:var(--green)}.bc .bdt{background:var(--green)}
.br{background:var(--yellow-d);color:var(--yellow)}.br .bdt{background:var(--yellow);animation:pdot 1.5s ease infinite}
.bq{background:rgba(94,80,71,.2);color:var(--text-2)}.bq .bdt{background:var(--text-3)}
.bf{background:var(--red-d);color:var(--red)}.bf .bdt{background:var(--red)}
.bp{background:rgba(94,80,71,.2);color:var(--text-2)}.bp .bdt{background:var(--text-3)}
.ba{background:var(--green-d);color:var(--green)}.ba .bdt{background:var(--green)}
.bj{background:var(--red-d);color:var(--red)}.bj .bdt{background:var(--red)}
@keyframes pdot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}

/* ---- Reviews ---- */
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

/* ---- Repo cards ---- */
.rg{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.rc{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:22px 24px;transition:all .25s;animation:cUp .4s ease both}
.rc:hover{border-color:var(--border-hi);box-shadow:0 0 30px var(--accent-glow);transform:translateY(-2px)}
.rch{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.rcn{font-family:var(--fm);font-size:13px;font-weight:600;color:var(--text)}
.rcv{font-size:10px;color:var(--text-3);border:1px solid var(--border);border-radius:20px;padding:2px 8px;text-transform:uppercase;letter-spacing:.5px}
.rci{display:flex;gap:16px;font-size:12px;color:var(--text-2);margin-top:6px}

/* ---- Bar chart ---- */
.brow{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.blbl{width:100px;font-size:12px;color:var(--text-2);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.btrk{flex:1;height:20px;background:var(--bg-deep);border-radius:6px;overflow:hidden}
.bfil{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-soft));border-radius:6px;
  display:flex;align-items:center;padding-left:8px;transition:width .8s cubic-bezier(.25,.46,.45,.94)}
.bnum{font-size:10px;font-weight:600;color:var(--bg-deep);font-family:var(--fm)}

/* ---- Hot paths ---- */
.hp{display:flex;align-items:center;justify-content:space-between;padding:9px 0;
  border-bottom:1px solid rgba(232,115,74,.05)}.hp:last-child{border-bottom:none}
.hpp{font-family:var(--fm);font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:12px}
.hpc{font-family:var(--fm);font-size:11px;font-weight:600;color:var(--accent);
  background:var(--accent-dim);padding:2px 10px;border-radius:10px}

/* ---- Rules ---- */
.rl{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--r);
  padding:20px 24px;margin-bottom:12px;animation:cUp .4s ease both}
.rtx{font-size:13px;color:var(--text);line-height:1.6;margin-bottom:14px}
.rla{display:flex;gap:8px}
.rbt{padding:7px 16px;border-radius:var(--rs);font-size:12px;font-weight:600;cursor:pointer;
  border:1px solid var(--border);background:transparent;color:var(--text-2);transition:all .15s;font-family:var(--fb)}
.rbt:hover{border-color:var(--accent);color:var(--accent)}
.rby{border-color:var(--green);color:var(--green);background:var(--green-d)}
.rby:hover{background:var(--green);color:var(--bg-deep)}
.rbn{border-color:var(--red);color:var(--red);background:var(--red-d)}
.rbn:hover{background:var(--red);color:var(--bg-deep)}

/* ---- Metric progress ---- */
.mw{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.ml{width:150px;font-size:13px;color:var(--text-2);flex-shrink:0}
.mtr{flex:1;height:6px;background:var(--bg-deep);border-radius:3px;overflow:hidden}
.mfl{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.4,0,.2,1)}
.mfg{background:var(--green)}.mfy{background:var(--yellow)}.mfr{background:var(--red)}
.mfa{background:linear-gradient(90deg,var(--accent),var(--accent-soft))}
.mn2{font-family:var(--fm);font-size:13px;font-weight:500;color:var(--text);min-width:65px;text-align:right}

/* ---- Loading / Empty ---- */
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
function get(u){return fetch(u).then(function(r){return r.json()})}

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
function ldOv(){
  Promise.all([get('/api/analytics/summary'),get('/api/analytics/insights'),
    get('/api/analytics/traversal'),get('/api/reviews/recent?limit=8')])
  .then(function(r){
    var s=r[0],i=r[1],t=r[2],rv=r[3];
    $('s-runs').textContent=fn(s.runCount);
    $('s-lat').textContent=fms(s.avgLatencyMs);
    $('s-acc').textContent=s.acceptanceRate+'%';
    $('s-rec').textContent=(t.avgCrossFileRecall*100).toFixed(1)+'%';
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

function rvList(id,items,mx){
  var el=$(id);
  if(!items||!items.length){el.innerHTML='<div class="em">No reviews yet</div>';return}
  var o='';items.slice(0,mx).forEach(function(r){
    var c=r.status==='completed'?'bc':r.status==='running'?'br':r.status==='failed'?'bf':'bq';
    o+='<div class="ri"><span class="bd '+c+'"><span class="bdt"></span>'+h(r.status)+'</span>'
      +'<div class="rb"><div class="rt">'+h(r.prTitle||'PR #'+r.prNumber)+'</div>'
      +'<div class="rr">'+h(r.repoName||'')+(r.prNumber?' #'+r.prNumber:'')+'</div></div>'
      +'<div class="rx"><span>'+fms(r.latencyMs)+'</span>'
      +'<span>'+r.findingCount+' finding'+(r.findingCount!==1?'s':'')+'</span></div>'
      +'<div class="rtime">'+ago(r.createdAt)+'</div></div>';
  });el.innerHTML=o;
}
function rpCards(items){
  var el=$('rp-ls');
  if(!items||!items.length){el.innerHTML='<div class="em">No repositories connected</div>';return}
  var o='';items.forEach(function(r,i){
    o+='<div class="rc" style="animation-delay:'+i*60+'ms">'
      +'<div class="rch"><span class="rcn">'+h(r.fullName)+'</span>'
      +'<span class="rcv">'+(r.private?'private':'public')+'</span></div>'
      +'<div class="rci"><span>'+fn(r.fileCount)+' files</span>'
      +'<span>'+(r.lastIndexed?'Indexed '+ago(r.lastIndexed):'Not indexed')+'</span></div></div>';
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
  var rc=(t.avgCrossFileRecall*100).toFixed(1),pr=(t.avgSupportedPrecision*100).toFixed(1);
  var p95=t.p95TraversalMs||0,nd=t.p95VisitedNodes||0;
  function fc(v){return v>=80?'mfg':v>=50?'mfy':'mfr'}
  el.innerHTML=
    '<div class="mw"><span class="ml">Cross-file Recall</span><div class="mtr"><div class="mfl '+fc(rc)+'" style="width:'+rc+'%"></div></div><span class="mn2">'+rc+'%</span></div>'
   +'<div class="mw"><span class="ml">Supported Precision</span><div class="mtr"><div class="mfl '+fc(pr)+'" style="width:'+pr+'%"></div></div><span class="mn2">'+pr+'%</span></div>'
   +'<div class="mw"><span class="ml">p95 Latency</span><div class="mtr"><div class="mfl mfa" style="width:'+Math.min(p95/500*100,100)+'%"></div></div><span class="mn2">'+fms(p95)+'</span></div>'
   +'<div class="mw"><span class="ml">p95 Visited Nodes</span><div class="mtr"><div class="mfl mfa" style="width:'+Math.min(nd/200*100,100)+'%"></div></div><span class="mn2">'+nd+'</span></div>';
}
function ruList(items){
  var el=$('ru-ls');
  if(!items||!items.length){el.innerHTML='<div class="em">No rule suggestions yet. Grepiku will suggest rules as it learns from your reviews.</div>';return}
  var o='';items.forEach(function(r,i){
    var c=r.status==='accepted'?'ba':r.status==='rejected'?'bj':'bp';
    var acts=r.status==='pending'
      ?'<button class="rbt rby" onclick="rAct('+r.id+',\\'approve\\')">Approve</button>'
       +'<button class="rbt rbn" onclick="rAct('+r.id+',\\'reject\\')">Reject</button>':'';
    o+='<div class="rl" style="animation-delay:'+i*50+'ms">'
      +'<div style="margin-bottom:10px"><span class="bd '+c+'"><span class="bdt"></span>'+h(r.status)+'</span></div>'
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
   Route registration
   ===================================================================== */
export function registerDashboard(app: FastifyInstance) {
  app.get("/dashboard", async (_request, reply) => {
    reply.type("text/html").send(DASHBOARD_HTML);
  });

  /* --- Repos listing --- */
  app.get("/api/repos", async (_request, reply) => {
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
    reply.send({
      items: repos.map((r) => ({
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
        indexStatus: r.indexRuns[0]?.status ?? "none"
      }))
    });
  });

  /* --- Recent reviews --- */
  app.get("/api/reviews/recent", async (request, reply) => {
    const limit = Math.max(1, Math.min(100, Number((request.query as any)?.limit || 20)));
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

  /* --- Analytics summary --- */
  app.get("/api/analytics/summary", async (_request, reply) => {
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
      positive + negative > 0 ? Math.round((positive / (positive + negative)) * 100) : 0;
    const avgMergeTimeHours = 0;
    reply.send({ runCount: runs.length, avgLatencyMs, acceptanceRate, avgMergeTimeHours });
  });

  /* --- Rule suggestions --- */
  app.get("/api/rules/suggestions", async (_request, reply) => {
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

  /* --- Traversal analytics --- */
  app.get("/api/analytics/traversal", async (request, reply) => {
    const limit = Math.max(20, Math.min(5000, Number((request.query as any)?.limit || 500)));
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

    const summary = summarizeTraversalMetrics(runs, DEFAULT_TRAVERSAL_THRESHOLDS);
    reply.send({ ...summary, recentRuns: runs.slice(0, 30) });
  });

  /* --- Approve rule --- */
  app.post("/api/rules/suggestions/:id/approve", async (request, reply) => {
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
  app.post("/api/rules/suggestions/:id/reject", async (request, reply) => {
    if (!canMutateRuleSuggestion(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const id = Number((request.params as any).id);
    await prisma.ruleSuggestion.update({ where: { id }, data: { status: "rejected" } });
    reply.send({ ok: true });
  });

  /* --- Export --- */
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

  /* --- Insights --- */
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

export const __dashboardInternals = {
  isSameOriginRequest
};
