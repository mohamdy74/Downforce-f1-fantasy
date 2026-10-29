# 🏎️ DOWNFORCE — Fantasy F1 Racing League

> Predict the Top 10. Beat your friends. Miss the lock and eat a −25 penalty.

**Live app**: https://downforce.lovable.app

## The game

- 🏁 **Predictions** — lock in your Top 10, pole, fastest lap and DNF before the deadline
- 📊 **Live scoring** — points calculated from real F1 race results, sprint weekends included
- 🏆 **Leaderboard** — season standings and race-by-race history
- ⏰ **Smart reminders** — Web Push alerts 2h & 30m before picks lock
- 🛡️ **Stewards Room** — league admin tools: penalties, waivers, renames, nudges, manual results, league backup

## Tech stack

| Layer | Tech |
| --- | --- |
| Framework | TanStack Start (React, SSR) |
| Build | Vite |
| Backend & auth | Supabase (Postgres, RLS, Edge Functions) |
| Hosting & sync | Lovable |
| Notifications | Web Push (VAPID, aes128gcm) |
| Reminders cron | GitHub Actions — pings `/reminders` every 10 minutes |

## Local development

Requires Node.js 18+.

```sh
git clone https://github.com/mohamdy74/downforce-f1-fantasy.git
cd downforce-f1-fantasy
npm i
npm run dev        # http://localhost:5173
```

`.env` holds public, build-time values (Supabase publishable keys, VAPID public key). Real secrets (`VAPID_PRIVATE_KEY`) live in Lovable Secrets and are never committed. For a full Arabic setup guide see [START_HERE_AR.md](START_HERE_AR.md).

## Deployment

The repo is two-way synced with Lovable:

- Push to `main` → live app updates in ~2–5 minutes
- Lovable editor changes → committed back to `main`
- Don't force-push to `main` — it breaks the sync

Built with [Lovable](https://lovable.dev). Continue development in the [Lovable editor](https://lovable.dev/projects/9c6dad2a-7be0-40da-8f8a-fa19706463ee).
