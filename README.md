# siboli-site-monitor

Daily health check for all sites, posted to Discord. Runs on GitHub Actions at 8:00 AM Mexico City.

## Setup
1. Push this repo to a private GitHub repo.
2. Repo → Settings → Secrets and variables → Actions → add secrets:
   - `DISCORD_DIGEST_WEBHOOK` (daily summary channel)
   - `DISCORD_ALERTS_WEBHOOK` (only used when something fails)
   - `POSTHOG_API_KEY` (personal API key with the "Performing analytics queries" scope, covering both projects)
3. Optional variable `POSTHOG_HOST` (`https://eu.posthog.com` if your project is on EU cloud; default is US).
4. Fill `posthogProjectId` in `sites.json` for nosvemos.mx and pomoforte.com.
5. Actions tab → "Daily site check" → Run workflow to test.

## Local test
```
DISCORD_DIGEST_WEBHOOK= node monitor.mjs
```
(prints the digest to the console when no webhook is set)

## Icons
- 🔴 needs attention now (site down, backups all failing, SSL close to expiry, broken cart, tracking silent for days). Also posts to the alerts channel.
- 🟡 to-do, not breaking (vulnerabilities, latest backup failed, slow page, paused/missing UptimeRobot monitor).
- 🟢 fine. Informational lines (e.g. no PostHog events in 24h) can still appear under a green site.
- ⚪ maintenance mode (`"maintenance": true`): expected, shown last.

## Extra checks
- **Add-to-cart** (`"woocommerce": true`): adds a product to a fresh cart via the Store API. No order is created.
- **WP Umbrella** (`"wpUmbrella": true`, needs `WP_UMBRELLA_API_KEY`): red if backups keep failing, yellow for latest backup failure, vulnerabilities or a disconnected site; shows pending plugin updates.
- **Heartbeat** (`HEARTBEAT_URL`): pinged at the end of each run. Create a Heartbeat monitor in UptimeRobot (interval 24h + grace) and use its URL, so you get alerted if the daily run stops.

## PostHog alerts
The digest shows events from the last 24h. It only goes red when a site has zero events for `posthogAlertDays` days (default 3, set per site in `sites.json`). Zero in 24h alone is a yellow note.

## Add a site
Add an entry to `sites.json`. Use `"woocommerce": true` to also check cart, checkout and the shop API.
