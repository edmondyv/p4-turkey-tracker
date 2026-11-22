# P4 Turkey tracker

Live dashboard for the P4 squad in Pet Simulator 99's Caramel Apple League.

- `scripts/collect.mjs` runs every 5 minutes in GitHub Actions. It reads BIG Games' public API, keeps one snapshot per Turkey cycle, computes the stats, and publishes `dashboard.json` and `history.json` to the `data` branch (one commit, force-pushed, so the repo stays small).
- When a squad member stops scoring, it rings a repeating phone alarm through ntfy (topic in the `NTFY_TOPIC` secret, with Stop and Snooze buttons) and, if the `DISCORD_WEBHOOK` secret is set, posts to Discord.
- `site/` is the dashboard, a static page deployed on Vercel. It reads `dashboard.json` straight from GitHub; the only function is `/api/status` (Roblox presence, cached 60 s).
- `test/mock-run.mjs` simulates the API over many cycles to test the collector offline.
