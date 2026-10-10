// Daily health check. Node 20+, no dependencies.
// Env: DISCORD_DIGEST_WEBHOOK, DISCORD_ALERTS_WEBHOOK, POSTHOG_API_KEY,POSTHOG_HOST (default https://us.posthog.com)
import tls from "node:tls";
import { readFileSync } from "node:fs";

try { process.loadEnvFile(); } catch {} // local runs: read .env if present (Actions uses secrets)

const sites = JSON.parse(readFileSync(new URL("./sites.json", import.meta.url)));
const SLOW_MS = 3000;
const SSL_WARN_DAYS = 14;
const PH_HOST = process.env.POSTHOG_HOST || "https://us.posthog.com";

async function timedFetch(url) {
  const start = Date.now();
  const res = await fetch(url, {
    redirect: "follow",
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

async function checkPage(label, url, problems, notes) {
  try {
    const { res, ms } = await timedFetch(url);
    if (res.status >= 400) problems.push(`${label} returned HTTP ${res.status}`);
    else if (ms > SLOW_MS) notes.push(`${label} slow (${ms}ms)`);
    return ms;
  } catch (e) {
    problems.push(`${label} unreachable (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    return null;
  }
}

async function posthogEvents24h(projectId, apiKey) {
  const res = await fetch(`${PH_HOST}/api/projects/${projectId}/query/`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: "select count() from events where timestamp > now() - interval 1 day" } }),
  });
  if (!res.ok) throw new Error(`PostHog API ${res.status}`);
  return (await res.json()).results?.[0]?.[0];
}

async function checkSite(site) {
  const problems = [];
  const notes = [];
  const home = new URL(site.url);

  if (site.maintenance) {
    // Construction mode: 503 is expected. Only flag real outages (network errors, other 5xx) or a site that went live.
    let ms = null;
    try {
      const r = await timedFetch(site.url);
      ms = r.ms;
      if (r.res.status === 503) notes.push("🚧 maintenance mode (expected)");
      else if (r.res.status < 400) notes.push("site is live — remove `maintenance` flag from sites.json");
      else problems.push(`Homepage returned HTTP ${r.res.status}`);
    } catch (e) {
      problems.push(`Homepage unreachable (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    }
    const days = await sslDaysLeft(home.hostname);
    if (days === null) problems.push("SSL check failed");
    else if (days < SSL_WARN_DAYS) problems.push(`SSL expires in ${days} days`);
    return { site, ms, days, events: null, problems, notes };
  }

  const ms = await checkPage("Homepage", site.url, problems, notes);

  const days = await sslDaysLeft(home.hostname);
  if (days === null) problems.push("SSL check failed");
  else if (days < SSL_WARN_DAYS) problems.push(`SSL expires in ${days} days`);

  if (site.woocommerce) {
    await checkPage("Cart", `${site.url}/cart/`, problems, notes);
    await checkPage("Checkout", `${site.url}/checkout/`, problems, notes);
    await checkPage("Shop API", `${site.url}/wp-json/wc/store/v1/products?per_page=1`, problems, notes);
  }

  let events = null;
  const phKey = process.env.POSTHOG_API_KEY;
  if (site.posthogProjectId && phKey) {
    try {
      events = await posthogEvents24h(site.posthogProjectId, phKey);
      if (!events) problems.push("PostHog: 0 events in last 24h");
    } catch (e) {
      notes.push(`PostHog check failed (${e.message})`);
    }
  }
  return { site, ms, days, events, problems, notes };
}

function line(r) {
  const icon = r.problems.length ? "🔴" : r.notes.length ? "🟡" : "🟢";
  const bits = [];
  if (r.ms !== null) bits.push(`${r.ms}ms`);
  if (r.days !== null) bits.push(`SSL ${r.days}d`);
  if (r.events !== null) bits.push(`${r.events} events`);
  const issues = [...r.problems, ...r.notes].map((p) => `\n   ↳ ${p}`).join("");
  return `${icon} **${r.site.name}** — ${bits.join(" · ")}${issues}`;
}

async function post(webhook, content) {
  if (!webhook) return;
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
  if (!res.ok) console.error(`Discord post failed: ${res.status}`);
}

const results = await Promise.all(sites.map(checkSite));
const failed = results.filter((r) => r.problems.length);
const date = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" });
const summary = failed.length ? `⚠️ ${failed.length}/${results.length} sites need attention` : `✅ ${results.length}/${results.length} sites healthy`;
const digest = `**Daily check — ${date}**\n${summary}\n\n${results.map(line).join("\n")}`;

console.log(digest);
await post(process.env.DISCORD_DIGEST_WEBHOOK, digest);
if (failed.length) await post(process.env.DISCORD_ALERTS_WEBHOOK, `🚨 **Problems found**\n${failed.map(line).join("\n")}`);
process.exit(failed.length ? 1 : 0);
