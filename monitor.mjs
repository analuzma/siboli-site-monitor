// Daily health check. Node 20+, no dependencies.
// Env: DISCORD_DIGEST_WEBHOOK, DISCORD_ALERTS_WEBHOOK, POSTHOG_API_KEY, POSTHOG_HOST (default https://us.posthog.com), WP_UMBRELLA_API_KEY, HEARTBEAT_URL
import tls from "node:tls";
import { readFileSync } from "node:fs";

try { process.loadEnvFile(); } catch {} // local runs: read .env if present (Actions uses secrets)

// Secrets pasted with stray whitespace/newlines break headers: keep only the first token.
const SECRET_VARS = ["DISCORD_DIGEST_WEBHOOK", "DISCORD_ALERTS_WEBHOOK", "POSTHOG_API_KEY", "WP_UMBRELLA_API_KEY", "UPTIMEROBOT_API_KEY", "HEARTBEAT_URL"];
for (const k of SECRET_VARS) if (process.env[k]) process.env[k] = process.env[k].trim().split(/\s+/)[0];
// Never let a secret appear in Discord or logs, even inside an error message.
const scrub = (text) => SECRET_VARS.reduce((t, k) => (process.env[k]?.length > 8 ? t.split(process.env[k]).join("***") : t), String(text));

const sites = JSON.parse(readFileSync(new URL("./sites.json", import.meta.url)));
const SLOW_MS = 3000;
const SSL_WARN_DAYS = 14;
const PH_HOST = process.env.POSTHOG_HOST || "https://us.posthog.com";

async function timedFetch(url, follow = true) {
  const start = Date.now();
  const res = await fetch(url, {
    redirect: follow ? "follow" : "manual",
    signal: AbortSignal.timeout(15000),
    headers: { "user-agent": "siboli-site-monitor/1.0" },
  });
  return { res, ms: Date.now() - start };
}

function sslDaysLeft(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert?.valid_to ? Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000) : null);
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

async function checkPage(label, url, problems, notes, follow = true) {
  try {
    const { res, ms } = await timedFetch(url, follow);
    if (res.status >= 400) problems.push(`${label} returned HTTP ${res.status}`);
    else if (ms > SLOW_MS) notes.push(`${label} slow (${ms}ms)`);
    return ms;
  } catch (e) {
    problems.push(`${label} unreachable (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    return null;
  }
}

// Returns events in the last 24h plus events in the alert window (default 3 days).
async function posthogEvents(projectId, apiKey, windowDays) {
  const res = await fetch(`${PH_HOST}/api/projects/${projectId}/query/`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: `select countIf(timestamp > now() - interval 1 day), count() from events where timestamp > now() - interval ${Number(windowDays)} day` } }),
  });
  if (!res.ok) throw new Error(`PostHog API ${res.status}`);
  const [last24h, inWindow] = (await res.json()).results?.[0] ?? [];
  return { last24h, inWindow };
}

// WP Umbrella public API: backups, pending updates, vulnerabilities for WordPress sites.
async function umbrellaProject(hostname, key) {
  for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }]) {
    const res = await fetch(`https://public-api.wp-umbrella.com/projects?search=${encodeURIComponent(hostname)}&per_page=5`, {
      signal: AbortSignal.timeout(20000),
      headers,
    });
    if (res.status === 401 || res.status === 403) continue;
    if (!res.ok) throw new Error(`API ${res.status}`);
    const body = await res.json();
    const projects = Array.isArray(body.data) ? body.data : body.projects ?? [];
    return projects.find((p) => p.source_domain === hostname) ?? null;
  }
  throw new Error("API rejected the key");
}

async function checkUmbrella(hostname, problems, notes, extra) {
  const key = process.env.WP_UMBRELLA_API_KEY;
  if (!key) return;
  try {
    const p = await umbrellaProject(hostname, key);
    if (!p) return void notes.push("WP Umbrella: site not found");
    if (p.is_disconnected) notes.push("WP Umbrella is disconnected from the site");
    const last4 = p.backups?.last_4_status ?? [];
    const bad = (s) => /fail|error/i.test(s ?? "");
    if (!p.backups?.active) notes.push("Backups are turned off");
    else if (last4.length && last4.every(bad)) problems.push(`Backups failing (last ${last4.length} all failed)`);
    else if (bad(last4[0])) notes.push("Latest backup failed");
    const updates = (p.plugins ?? []).filter((x) => x.need_update && x.is_active).length;
    if (updates) extra.push(`${updates} updates`);
    const v = p.vulnerabilities ?? {};
    const vulns = (v.plugins?.length ?? 0) + (v.themes?.length ?? 0) + (v.wordpress?.length ?? 0);
    if (vulns) notes.push(`${vulns} known vulnerabilities (see WP Umbrella)`);
  } catch (e) {
    notes.push(`WP Umbrella check failed (${e.message})`);
  }
}

// UptimeRobot (read-only key): 24h / 7d uptime per site, plus paused or missing monitors.
let uptimeRobotCache;
function uptimeRobotMonitors() {
  uptimeRobotCache ??= fetch("https://api.uptimerobot.com/v2/getMonitors", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: process.env.UPTIMEROBOT_API_KEY, format: "json", custom_uptime_ratios: "1-7" }),
    signal: AbortSignal.timeout(20000),
  }).then(async (r) => {
    const j = await r.json();
    if (j.stat !== "ok") throw new Error(j.error?.message ?? `API ${r.status}`);
    return j.monitors;
  });
  return uptimeRobotCache;
}

async function checkUptimeRobot(site, hostname, problems, notes, extra) {
  if (!process.env.UPTIMEROBOT_API_KEY) return;
  const bare = (h) => h.replace(/^www\./, "");
  try {
    const monitors = await uptimeRobotMonitors();
    const m = monitors.find((m) => { try { return bare(new URL(m.url).hostname) === bare(hostname); } catch { return false; } });
    if (!m) return void notes.push("No UptimeRobot monitor for this site");
    if (m.status === 0) return void (site.maintenance || notes.push("UptimeRobot monitor is paused"));
    if (m.status >= 8) problems.push("UptimeRobot reports the site is down");
    const [d1, d7] = String(m.custom_uptime_ratio).split("-").map(Number);
    extra.push(`uptime ${d1}% (24h) · ${d7}% (7d)`);
    if (d1 < 99.5) notes.push(`UptimeRobot saw downtime in the last 24h (${d1}%)`);
  } catch (e) {
    notes.push(`UptimeRobot check failed (${e.message})`);
  }
}

// Adds one simple in-stock product to a fresh cart through the WooCommerce Store API (no order is created).
async function cartTest(base, problems, notes, info) {
  const api = `${base}/wp-json/wc/store/v1`;
  const h = { "user-agent": "siboli-site-monitor/1.0", accept: "application/json" };
  try {
    const listRes = await fetch(`${api}/products?per_page=20`, { headers: h, signal: AbortSignal.timeout(15000) });
    const products = listRes.ok ? await listRes.json() : null;
    if (!Array.isArray(products)) return void problems.push(`Add-to-cart test: product list failed (HTTP ${listRes.status})`);
    // Candidates: simple products first, then variations of variable products (clothing stores are mostly variable).
    const candidates = [];
    for (const p of products.filter((p) => p.type === "simple" && p.is_purchasable && p.is_in_stock && !p.has_options)) {
      candidates.push({ id: p.id });
    }
    for (const p of products.filter((p) => p.type === "variable" && p.is_purchasable && p.is_in_stock)) {
      for (const v of p.variations ?? []) {
        candidates.push({ id: v.id, variation: (v.attributes ?? []).map((a) => ({ attribute: a.name, value: a.value })) });
      }
    }
    if (!candidates.length) return void info.push("Add-to-cart test skipped (no purchasable product found)");

    const cartRes = await fetch(`${api}/cart`, { headers: h, signal: AbortSignal.timeout(15000) });
    const token = cartRes.headers.get("cart-token");
    if (!token) return void info.push("Add-to-cart test skipped (no Cart-Token)");

    let lastFailure = null;
    for (const item of candidates.slice(0, 6)) {
      const start = Date.now();
      const add = await fetch(`${api}/cart/add-item`, {
        method: "POST",
        headers: { ...h, "content-type": "application/json", "cart-token": token },
        body: JSON.stringify({ ...item, quantity: 1 }),
        signal: AbortSignal.timeout(15000),
      });
      const ms = Date.now() - start;
      const body = await add.json().catch(() => null);
      if (add.ok && body?.items_count) {
        if (ms > SLOW_MS) notes.push(`Add-to-cart slow (${ms}ms)`);
        return;
      }
      lastFailure = { status: add.status, code: body?.code ?? "" };
    }
    // Out-of-stock style rejections are not a broken cart; anything else is.
    if (/stock|purchasable|variation/i.test(lastFailure.code)) info.push(`Add-to-cart test inconclusive (${lastFailure.code})`);
    else problems.push(`Add-to-cart failed (HTTP ${lastFailure.status} ${lastFailure.code})`);
  } catch (e) {
    problems.push(`Add-to-cart test error (${e.message})`);
  }
}

async function checkSite(site) {
  const problems = [];
  const notes = []; // to-dos: turn the site yellow
  const info = []; // informational: listed, but never change the icon
  const extra = [];
  const home = new URL(site.url);
  if (site.wpUmbrella) await checkUmbrella(home.hostname, problems, notes, extra);
  await checkUptimeRobot(site, home.hostname, problems, notes, extra);

  if (site.maintenance) {
    // Construction mode: 503 is expected. Only flag real outages (network errors, other 5xx) or a site that went live.
    let ms = null;
    try {
      const r = await timedFetch(site.url);
      ms = r.ms;
      if (r.res.status === 503) info.push("🚧 maintenance mode (expected)");
      else if (r.res.status < 400) notes.push("site is live — remove `maintenance` flag from sites.json");
      else problems.push(`Homepage returned HTTP ${r.res.status}`);
    } catch (e) {
      problems.push(`Homepage unreachable (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    }
    const days = await sslDaysLeft(home.hostname);
    if (days === null) problems.push("SSL check failed");
    else if (days < SSL_WARN_DAYS) problems.push(`SSL expires in ${days} days`);
    return { site, ms, days, events: null, extra, problems, notes, info };
  }

  const ms = await checkPage("Homepage", site.url, problems, notes);

  const days = await sslDaysLeft(home.hostname);
  if (days === null) problems.push("SSL check failed");
  else if (days < SSL_WARN_DAYS) problems.push(`SSL expires in ${days} days`);

  if (site.woocommerce) {
    await checkPage("Cart", `${site.url}/cart/`, problems, notes);
    // Empty cart redirects /checkout/ to the cart: time only the first response (cart is timed separately).
    await checkPage("Checkout", `${site.url}/checkout/`, problems, notes, false);
    await checkPage("Shop API", `${site.url}/wp-json/wc/store/v1/products?per_page=1`, problems, notes);
    await cartTest(site.url, problems, notes, info);
  }

  let events = null;
  const phKey = process.env.POSTHOG_API_KEY;
  if (site.posthogProjectId && phKey) {
    try {
      const windowDays = site.posthogAlertDays ?? 3;
      const ph = await posthogEvents(site.posthogProjectId, phKey, windowDays);
      events = ph.last24h;
      if (!ph.inWindow) problems.push(`PostHog: 0 events in last ${windowDays} days (tracking may be broken)`);
      else if (!ph.last24h) info.push("PostHog: no events in last 24h");
    } catch (e) {
      notes.push(`PostHog check failed (${e.message})`);
    }
  }
  return { site, ms, days, events, extra, problems, notes, info };
}

function line(r) {
  const icon = r.problems.length ? "🔴" : r.site.maintenance ? "⚪" : r.notes.length ? "🟡" : "🟢";
  const bits = [];
  if (r.ms !== null) bits.push(`${r.ms}ms`);
  if (r.days !== null) bits.push(`SSL ${r.days}d`);
  if (r.events !== null) bits.push(`${r.events} events`);
  bits.push(...r.extra);
  const issues = [...r.problems, ...r.notes, ...r.info].map((p) => `\n   ↳ ${scrub(p).slice(0, 200)}`).join("");
  return `${icon} **${r.site.name}** — ${bits.join(" · ")}${issues}`;
}

let discordFailed = false;
async function post(webhook, content, name) {
  if (!webhook) {
    // Local dry runs blank the webhooks on purpose; in CI a missing secret must not pass silently.
    if (process.env.CI) { console.error(`::error::${name} is not set — add it under repo Settings → Secrets → Actions`); discordFailed = true; }
    return;
  }
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`::error::Discord post to ${name} failed (${e.message}) — check the webhook secret`);
    discordFailed = true;
  }
}

const results = await Promise.all(sites.map(checkSite));
const failed = results.filter((r) => r.problems.length);
const todo = results.filter((r) => !r.problems.length && !r.site.maintenance && r.notes.length);
// Most urgent first: red, yellow, green, then gray (maintenance).
const rank = (r) => (r.problems.length ? 0 : r.site.maintenance ? 3 : r.notes.length ? 1 : 2);
results.sort((a, b) => rank(a) - rank(b));
const date = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" });
const summary = failed.length
  ? `⚠️ ${failed.length}/${results.length} sites need attention`
  : `✅ All sites are up${todo.length ? ` · 🟡 ${todo.length} with to-dos` : ""}`;
const digest = `**Daily check — ${date}**\n${summary}\n\n${results.map(line).join("\n")}`;

console.log(digest);
await post(process.env.DISCORD_DIGEST_WEBHOOK, digest, "DISCORD_DIGEST_WEBHOOK");
if (failed.length) await post(process.env.DISCORD_ALERTS_WEBHOOK, `🚨 **Problems found**\n${failed.map(line).join("\n")}`, "DISCORD_ALERTS_WEBHOOK");
// Heartbeat: tells UptimeRobot this run completed. If the pings stop, UptimeRobot alerts you.
if (process.env.HEARTBEAT_URL) {
  try { await fetch(process.env.HEARTBEAT_URL, { signal: AbortSignal.timeout(10000) }); } catch (e) { console.error(`Heartbeat failed: ${e.message}`); }
}
process.exit(failed.length || discordFailed ? 1 : 0);
