# Alliance System Design Doc

Status: **decisions resolved (2026-05-30) — ready to build, lowest-risk-first**.
Author: drafted by AI assistant from the operator's spec (2026-05-29).
All 5 open questions answered — see "Decisions — RESOLVED" near the bottom.
Discord-required (no in-game alliance UI). Build order unchanged below.
Scope: this is the single largest feature on the backlog and is **mostly
Discord / `bot.js`-side**, with a handful of game-server hooks. Read the
"Concerns & open questions" section before approving any phase.

---

## 0. Where alliances stand today (v86+)

- `recomputeAlliances()` runs server-side every 30s. Union-find clusters
  countries that share a player preference (`countryMain` / `countryB` /
  `countryC` on a profile).
- `ALLIANCE_MIN_MEMBERS = 10` (raised from 3 in v86).
- Bots: only 5–15% are alliance-eligible per UTC day (v86), so alliances
  are now overwhelmingly human-driven.
- On formation/dissolution/membership-change the server emits
  `alliance_formed` / `alliance_changed` / `alliance_dissolved` bot events
  (consumed by the Discord `bot.js` SSE listener).
- Allied pixels already count together toward the 60% conquest threshold
  (`getAllyOwnedCount`).
- The A/B/C country slots exist on the profile and in the onboarding flow.

So the *mechanical core* (clustering, combined conquest credit) is built.
Everything below is **engagement scaffolding + retention loops** layered on top.

---

## 1. The journey to 10 players — "Underground Resistance" phase

**Goal:** make the climb to the 10-member threshold visible and
participatory instead of silent.

### 1A. Nascent-alliance tracking (server)
- Today `recomputeAlliances()` discards clusters with `< 10` members.
  Change: also track **nascent** clusters with `2 ≤ members < 10` in a
  separate `nascentAlliances` map.
- Emit a new `alliance_progress` bot event when a nascent cluster gains or
  loses a member, throttled to ~1 update / 30s per cluster.
- Payload: `{ key, countries:[ids], memberCount, needed: 10 - memberCount }`.

### 1B. `#alliance-radar` channel (bot.js)
- A single read-only channel. The bot maintains **one pinned message per
  active nascent cluster**, edited in place (not re-posted) as progress
  changes — avoids channel spam.
- Message: a progress bar + a **Join button** (Discord button component):

  > ⚔️ **UK + Australia + Canada** Coalition forming — 7/10
  > ▓▓▓▓▓▓▓░░░ Need 3 more to lock in allied pixel bonuses.
  > `[ Join Coalition ]`

- Clicking **Join** runs the existing country-preference backend: it adds
  the cluster's countries to the clicking user's profile slots (respecting
  the A/B/C cap) and the next `recomputeAlliances()` picks it up.

### Concerns — phase 1
- **Pinned-message churn:** editing many messages frequently can hit
  Discord rate limits (5 edits/5s per channel is the practical ceiling).
  Mitigation: batch edits, cap to the top ~5 nascent clusters by member
  count, update at most every 30s.
- **Join idempotency:** double-clicks, or a user already in the cluster.
  Backend must no-op gracefully and the button must re-render the new count.
- **Leaving:** there must be a way to *leave* a coalition (a `/leave` slash
  command or a Leave button once joined). Without it the A/B/C slots clog.
- **Stale clusters:** if members drift away, the pinned message must be
  deleted, not left showing "3/10" forever.

---

## 2. "Birth of a Superpower" — the 10th-member event

When a nascent cluster crosses 10 members it becomes a real alliance.

### 2A. Announcement (bot.js)
- A rich embed (not plain text) in a main announcements channel:

  > 🚨 **NEW WORLD ALLIANCE FORMED** 🚨
  > **The Axis of South America** (🇧🇷 Brazil + 🇦🇷 Argentina + 🇨🇱 Chile)
  > has unified! Their pixels now count together for world conquest.
  > Combined strength: **12,240 px/hr**

- Alliance display name: auto-generate from a template pool
  ("The {Adjective} {Region} {Pact-noun}") seeded by the country set so it's
  stable. Operator can override via an admin command.
- Attach a **map screenshot** of the combined territory — we already have
  `mapshot.js` (v88); extend it to render a multi-country footprint.

### 2B. Auto faction channel — **use THREADS, not channels** ⚠️
The spec says "create a private hidden category." **Strong recommendation:
use a private thread instead.** Rationale in concerns below.

- On formation, the bot creates **one private thread** under a dedicated
  `#war-rooms` channel, named e.g. `axis-of-sa-strat`.
- Invite the 10 founding members (by Discord user ID).
- New joiners are auto-added; leavers auto-removed.
- On dissolution (or world reset) the thread is **archived**, not deleted —
  archived threads are free and don't count against limits.

### Concerns — phase 2
- **Channel limits are the dealbreaker for the original design.** A Discord
  guild caps at **500 channels** total. Rotating alliances + a map reset on
  every world conquest would orphan categories constantly and hit the cap
  within days. **Threads have no practical cap** and auto-archive — this is
  why I'm recommending threads over categories. This needs your sign-off
  because it changes the spec's "private category" vision.
- **Permission management:** private threads still require the bot to have
  `Manage Threads` + `Create Private Threads` and to add each member
  explicitly. Members who haven't linked Discord can't be added.
- **Naming collisions / moderation:** auto-generated names could be
  unfortunate. Keep a profanity filter on the adjective/noun pools.

---

## 3. Retention mechanics

### 3A. `/strike [country]` rally points (bot.js + game server)
- An alliance member runs `/strike Germany` in their war-room thread.
- Bot pings the alliance role: *"General @X called a strike on Germany —
  deploy now: {map deep-link}"*.
- Game server broadcasts a **rally point**: a temporary pulsing icon on the
  map **visible only to that alliance's members**.

  **This is the first per-recipient filtered broadcast in the codebase.**
  Today every client gets every message. We'd need to tag the rally
  broadcast with an alliance id and have clients check membership before
  rendering. Moderate effort; reuses the v87 rally-overlay rendering.
- Deep-link: `pixelannex.com/?goto=GERMANY` → client pans/zooms on load.
  (We already have `jumpToCountry`; just need a URL param hook.)

### 3B. Alliance Vaults + daily "Allied Surge"
- A slice (say 5%) of each allied player's passive regen accrues into a
  shared **Alliance Vault** (server-side counter per alliance).
- Once/day an alliance **leader** (General/Admiral rank within the alliance)
  can trigger **Allied Surge**: all *online* alliance members get +50% regen
  for 5 minutes.

### Concerns — phase 3 (highest risk)
- **Exploit surface.** The vault + surge is a real economy. All enforcement
  MUST be server-side: one surge/day enforced by server timestamp (never
  trust the client), vault balance authoritative on the server, surge
  eligibility checked server-side.
- **Persistence:** vault balances must survive server restarts (the world
  state is currently in-memory). Needs a small persisted store
  (`alliance_state.json` alongside `profiles`/`tweet_queue`).
- **Who is a "leader"?** Define precisely: highest-rank linked member?
  First founder? Operator-assigned? Ambiguity here is an abuse vector.
- **Bots in alliances:** exclude bots from vault accrual and surge
  eligibility, or bot-heavy alliances trivially farm the vault.
- **Coordination spike = the point, but also load:** "everyone logs on at
  once for the surge" is great for retention and the exact scenario our
  1Hz-tick + paint-queue scaling was built for. Worth load-testing before
  promoting it.

### 3C. A/B/C reskin (trivial, low-risk — do this first)
Pure relabeling, no mechanical change:

| Slot | Old label | New concept | Function (unchanged) |
|------|-----------|-------------|----------------------|
| A | Main Country | 🎖️ **Homeland / Allegiance** | Default nation you fight for; rank progression applies here |
| B | Alliance 1 | 🤝 **Strategic Coalition** | Primary defense pact; pixels count toward 60% conquest |
| C | Alliance 2 | 💰 **Mercenary Pact / Buffer State** | Fluid tactical alignment; help hold pixels vs a mutual rival |

Touch points: the Discord onboarding/country command copy, the daily-popup
country switcher labels, and any in-game profile UI. No server logic change.

### 3D. Two-alliance onboarding selection
- Extend the new-user country-selection flow (Discord command) so picking B
  and C (Coalition + Mercenary) is an **optional** step after the mandatory
  Homeland pick. Defaults to none; users can set later via `/country`.

---

## Recommended build order

1. **3C — A/B/C reskin** (hours, zero risk) — ship immediately, it's just copy.
2. **3D — optional 2-alliance onboarding** (small, bot.js) — pairs with 3C.
3. **1 — Underground Resistance** (progress bars + Join/Leave buttons) — the
   biggest engagement win, medium effort, contained risk.
4. **2 — Superpower event + war-room threads** — depends on 1; needs the
   thread-vs-channel decision approved.
5. **3A — `/strike` rally points** — introduces per-recipient broadcast;
   build only once 1+2 prove the social loop works.
6. **3B — Vaults + Allied Surge** — highest risk/effort; do last, with
   persistence + server-side enforcement designed up front.

## Decisions — RESOLVED (operator, 2026-05-30)

1. **War rooms: THREADS** (private threads under a `#war-rooms` channel,
   auto-archive on dissolution/reset). Categories rejected (500-channel cap).
2. **Alliance leader = highest-rank linked member.** Ties broken by earliest
   join / lowest pid (deterministic). Only this member can trigger Allied Surge.
3. **Vault/surge tuning = proposed values:** 5% of allied passive regen into
   the vault; Allied Surge = +50% regen for 5 min, once per day per alliance.
4. **Bots NEVER appear** in the radar, member counts, vault accrual, or surge
   eligibility. Alliance membership counts linked humans only.
5. **Discord-required (no graceful degrade).** Alliances are a Discord-layer
   social feature. Anonymous/browser-only players still get the PASSIVE
   benefits (allied pixels count toward conquest; allied territory shows on
   the map highlight), but all ACTIVE features — joining, war rooms,
   `/strike` rally points, vault/surge — require a linked Discord account.
   In-game, non-linked players see a "Sign in with Discord to join alliances"
   prompt rather than a parallel in-game alliance UI. This reinforces the
   existing Discord-link incentive (rank persistence, daily bonuses) and
   avoids maintaining two front-ends.

### Implications of "Discord-required" for the build
- No in-game alliance panel / join UI is needed — saves significant work.
- `/strike` rally points are broadcast only to clients whose linked Discord
  user is in the alliance. Clients that never linked simply never receive
  them (server already knows `player.discordId`).
- Membership = set of linked Discord IDs whose profile has the alliance's
  countries in a slot. The existing `recomputeAlliances()` already keys off
  profiles, so this is consistent.
