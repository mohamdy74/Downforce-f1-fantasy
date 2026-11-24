# Race Updates & News Feed

Steward-published news about events that affect the starting grid — penalties,
grid drops, investigations, and general announcements — surfaced to every
signed-in player through the Megaphone ("Race updates") button in the site
header.

## How it works

- **Data**: the `race_updates` table (`0018_race_updates.sql` +
  `0024_race_updates_optional_race.sql`, which makes `race_id` optional).
  RLS allows `SELECT` for signed-in players only; there are deliberately no
  write policies — inserts and deletes happen exclusively through
  `src/lib/updates.functions.ts` server functions gated by
  `requireSupabaseAuth` + `requireSteward` (service role).
- **Publishing**: Stewards Room (`/stewards`) → "Race Updates & News" card.
  Pick a target — a specific round, or "General — league news (no round)" for
  announcements that are not tied to any Grand Prix — the update type (Penalty /
  Grid Change / Investigation / General News), optionally the affected driver,
  a title (max 140 chars) and details (max 500 chars), then Publish to League.
  Every posted update is listed (with its target round) and can be edited or
  deleted for corrections.
- **Reading**: the header Megaphone button opens a drawer with the latest 50
  updates (query key `["race-updates"]`, 1-minute stale time). The button
  shows an unread badge; the per-device read position is stored in
  localStorage under `dfr-updates-seen`.

## Suggested steward workflow on a race weekend

When an official decision lands (FIA documents, live timing), open the
Stewards Room, select the current round, and publish a short factual note
(e.g. "VER — 3-place grid penalty for impeding in Q1"). Players see the
badge update within a minute and can adjust picks before the lock deadline.
