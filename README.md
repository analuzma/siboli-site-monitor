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

## Add a site
Add an entry to `sites.json`. Use `"woocommerce": true` to also check cart, checkout and the shop API.
