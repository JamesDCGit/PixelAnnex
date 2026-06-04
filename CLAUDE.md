# CLAUDE.md — PixelAnnex project guide

Project context for AI assistants. Read this BEFORE making changes.

## What this is

PixelAnnex is a real-time multiplayer browser game. Players claim world-map
pixels for their country; 191 ambient bots simulate continuous activity.
Single-file HTML/JS client + Node.js WebSocket server + separate bot
process, deployed on a DigitalOcean droplet behind PM2.

## File layout

| File | Role |
|------|------|
| `pixelworld_v5.html` | Client (≈10k lines: UI, canvas, WS, audio, all in one file) |
| `server.js` | Node WS server (≈4.5k lines: game logic, broadcasts, bot tick) |
| `bot.js` | Separate bot process — external SSE-driven bot client |
| `sw.js` | Service worker — caches static assets, must be cache-busted on deploy |
| `mapshot.js` | Server-side PNG screenshot renderer (uses `@napi-rs/canvas@1.0.0`) |
| `xposter.js` | Optional X (Twitter) poster for the tweet dashboard (`twitter-api-v2`) |
| `countries-10m.json` | TopoJSON world map data (3.6MB) |
| `deploy.ps1` | Deploy script — pulls + PM2 restart on the droplet |

## **The version triad — read this twice**

Three constants must ALWAYS move together when deploying:

```
pixelworld_v5.html:  const CODE_VERSION   = '2026-MM-DD-vNN';
server.js:           const SERVER_VERSION = '2026-MM-DD-vNN';
sw.js:               const CACHE_VERSION  = 'pixelannex-v2026-MM-DD-vNN';
```

**Why:** the client checks `msg.serverVersion !== CODE_VERSION` on `welcome`
and triggers a page reload after 4s if they differ. If you bump CODE_VERSION
without SERVER_VERSION, every client enters an infinite reload loop — this
broke production from v70 through v76. There's a sessionStorage guard now
(reload fires at most once per tab per server version), but the safer rule
is: **always bump all three together**.

`deploy.ps1` enforces this with a pre-flight check.

## Deploy flow

```pwsh
# 1. Bump all three version constants
# 2. Stage + commit + push
git add pixelworld_v5.html server.js sw.js
git commit -m "vNN: …"
git push origin main

# 3. Deploy (version-sync check runs first)
.\deploy.ps1
```

The deploy script SSHes to the droplet, `git pull`s, and `pm2 restart pixelannex --update-env`.

## Production environment

- **Host:** `root@134.209.74.81` (DigitalOcean droplet)
- **Path:** `/var/www/PixelAnnex`
- **Node:** v20.20.2 via nvm — must be on PATH for PM2 commands
- **Process manager:** PM2 — two processes:
  - `pixelannex` (id 1): main server
  - `pixelannex-bot` (id 0): external bot client
- **SSH key:** `~/.ssh/id_ed25519_pixelannex` (passphrase-free, automation only)
- **Domain:** TBD (currently raw IP / pixelannex.io)

### Common PM2 gotcha — `DISABLE_BOTS`

There's a kill-switch env var: `DISABLE_BOTS=1` makes `botTickSingle`
no-op. PM2 caches env vars across restarts via `--update-env`. If you
ever set this for debugging, **explicitly clear it** before re-enabling:

```bash
DISABLE_BOTS="" pm2 restart pixelannex --update-env
```

(`unset DISABLE_BOTS` in the shell isn't enough — PM2 keeps its own copy.)

Server logs `[Bot] *** BOTS DISABLED via DISABLE_BOTS env var ***` at
startup when the switch is on. Always grep for that after a deploy.

### Discord channels (canonical — operator-confirmed 2026-06-04)

The bot reads/writes these by NAME. The defaults in `bot.js` MUST match the real
channel names exactly, or the bot silently posts nowhere ("channel not found").
No channel env vars are set in `.env`, so the code defaults below are what's live.

| Channel | Purpose | bot.js env / default |
|---------|---------|----------------------|
| `#general` | general chat | — |
| `#war-room` (singular) | war reporter feed (conquest/siege) **and** alliance war-room private threads | `WAR_CHANNEL` / `'war-room'`; `ALLIANCE_WARROOMS_CHANNEL` / `'war-room'` |
| `#alliance-updates` (PLURAL) | alliance formation/grow/dissolve announcements | `ALLIANCE_CHANNEL` / `'alliance-updates'` |
| `#alliance-radar` (singular) | nascent-coalition progress cards + Join/Leave buttons | `ALLIANCE_RADAR_CHANNEL` / `'alliance-radar'` |

Note the (deliberate) inconsistency: `war-room`/`alliance-radar` are singular but
`alliance-updates` is plural. Don't "normalize" them — match the guild exactly.

## Architecture (post v77 Path A scaling)

### Server delta broadcast
- `queueDelta(pixels)` accumulates; `flushDelta()` fires every `BROADCAST_MS` (1000ms = 1Hz)
- Each broadcast = `{type:'delta', pixels:[{x,y,owner}, …]}`
- Server logs `[Delta]` summary every 10s — use to verify bots are painting

### Client paint pipeline
1. `mpHandleMessage('delta')` — updates `claimByPixel[]` immediately (state correctness)
2. Pixels go into `_paintQ` flat array `[pi, fi, scheduledTime]` triples
3. `flushPaintQueue()` RAF loop drains items whose time has come, batches by owner, `fillRect`s on `claimCtx` + `flashCtx`
4. **Stale guard:** queued paint skipped if `claimByPixel[pi] !== fi` (pixel re-owned between enqueue and paint)
5. **Own paints bypass the queue** — `claimPixel()` paints instantly for responsive feedback

### Three canvases that matter
- `claimCtx` — pixel ownership (the actual game state visualization)
- `flashCtx` — white pulse on new paints; decays via 15fps throttled `destination-out` composite
- `outlineCtx` — 1px white border around player's own pixels; redraws bbox at 1fps

## Performance landmines (avoided, but document so we don't re-add)

- **`flashPixel` decay RAF at 60fps** — full-canvas (2M-pixel) destination-out composite. Throttle to 15fps (`FLASH_DECAY_INTERVAL_MS=66`). Was the original "stuck in loop" cost.
- **`featList.findIndex` per pixel** — O(N) string compare across 200 countries. Use `idToFeatIdx.get()` (O(1) Map).
- **`hexRgb(featList[fi].color)` per delta owner** — string parse + allocation. Use `colorCache[fi]` (pre-built `[r,g,b]`).
- **`finisherFill` 2M-pixel scan** — use `geoPixelList[geoIdx]` (per-geo Int32Array, ~10k pixels).
- **`isUnderSiege` allocations** — `Object.entries` + `.filter`. Replace with for-in + in-place log prune.
- **`tickSiegeFlash` at 30fps** — 191-country scan. Throttle to 5fps.
- **Conquered-set startup replay** — chain finisherFills synchronously freezes browser. Chunk via RAF (3 per frame).

## Pre-change checklist

Before editing any function:

1. **Read the actual function** (don't trust memory; v75-v77 had subtle bugs from skipping this)
2. **Grep for callers** — what else depends on this behavior?
3. **Check for invariants** — does it run on every delta? per pixel? at 60fps?

## Post-change checklist

1. **Did I bump all 3 versions?** (the v76 trap)
2. **Did I keep existing user-visible behavior?** (v75 silently removed the white flash)
3. **Did I add a comment explaining *why*?** Future-you / next-assistant needs the context
4. **Are staged files only the ones I meant?** (`git status` before commit — `.claude/`, IDE configs, etc. should NOT be in production commits)

## Post-deploy checklist

1. `[Bot] *** BOTS DISABLED ***` is NOT in the startup logs
2. `PixelAnnex server 2026-MM-DD-vNN` matches the version you just shipped
3. Within 10–30 seconds: `[Delta]` log line appears (proves broadcasts are flowing)
4. User hard-refreshes (Ctrl+Shift+R) to bust SW cache
5. User confirms expected new behavior + no regressions

## Conventions

- **Comments use `v##:` prefix** to mark when a change was introduced (e.g. `// v77: 1Hz tick`)
- **No emojis in source code** unless the user explicitly asks
- **Never amend commits** — always make a new one
- **JSDoc-style block comments** for major systems (e.g. paint queue, version triad)
- **Pixel coordinates:** `pi = y * MAP_W + x` everywhere

## Backlog (Path A scaling)

- [x] v77: 1Hz delta tick + client paint queue staggering
- [x] v79: white flash restored with 15fps throttled decay
- [x] v80: Cloudflare CDN + deploy.ps1 version guard + CLAUDE.md
- [x] v81: dynamic bot rush-hours + aggressive personality
- [x] v82–v83b: UI cleanup, welcome rework, daily popup, leader-name scrub
- [x] v84: notification rate-limits + notable-country tweet filter + sass pool
- [x] v85: progressive fight-back, touchpad gestures, rank perks shown
- [x] v86–v86b: monster outlines, right-click OWNER-footprint inspect, About page, alliance/rivalry overhaul
- [x] v87: progressive Lieutenant+ rally system, bucket max 100, encircle halved, 1px monster shape outline
- [x] v88: localized tweet tagging (flags + #hashtags) + server-side 256×256 PNG screenshots (pure-JS encoder, NO native dep)
- [x] v92: binary delta protocol (packed u16) + v92p per-region viewport delta filter + v92s snapshot RLE→binary
- [x] v89: cleanups — pixel-inspector popup layout fixed (bodyBlock + swatch legend), duplicate escapeHtml removed, English i18n thresholds corrected (60% conquest / 50% fightback / Nuke)
- [x] **Alliance overhaul COMPLETE** (v92u–v93g): 3C reskin, 3D onboarding, Phase 1 radar (Join/Leave), Phase 2 superpower announcement + war-room private threads, 3A `/strike` rally points, 3B vaults + Allied Surge (`/surge`), plus resync-on-connect reliability + channel-name fixes. Coalition membership = B/C slots only; alliance state persisted in `alliance_state.json`.
- [ ] Translate non-English i18n strings to current thresholds (9 locales still cite 70%/80% conquest, "Bombs"). English fixed in v89.
- [ ] Remove dead `toggleOwnStroke` / `_ownStrokeVisible` / own-stroke layer (button gone since v82, layer always off)

### Operator backlog (2026-06-04) — after resync-fix + 3B — ALL DONE (v93h–v93j)
- [x] **Conquer bug (recurring):** v93h replaced the plurality path with a contested-territory majority metric. Root cause: conquest was measured vs TOTAL land, diluted by huge unpainted interiors (China ~91% unpainted). New path: falls to the largest foreign holder when `topCnt > nativeOwned` AND (painted/total ≥ `CONTEST_FLOOR` 0.40 AND foreignSum/painted ≥ `CONTEST_MAJORITY` 0.70) OR (foreignSum/total ≥ `CONTEST_TOTAL_FRAC` 0.60). Debug: `/api/debug/country?...` `contested` block.
- [x] **Fallen-country selection:** v93j — repick modal shows conquered countries greyed + struck-through + disabled (no longer hidden).
- [x] **Slow monster spawns:** v93j — `MONSTER_DEBUG=false`; UFO 50-80m / KRAKEN 25-45m / GODZILLA 30-50m (~1/15min combined).
- [x] **/worldstate command:** v93j — `/worldstate` slash cmd + `/api/bot/worldstate` → embed in `#general` (conquests, alliances, top conquerors).
- [x] **/rally tuning:** v93i — `RALLY_COOLDOWN_MS=60000` client cooldown gating `enterHighlightMode`+`setHighlight`; button countdown.
- [x] **Country-number bug:** v93j — ids 65/171 are unnamed Natural Earth features (disputed/buffer zones). featList name now falls back to "Disputed Territory", which flows to server/bot via the join `geoNames` map. (Takes effect once a v93j client connects and re-sends geoNames.)
- [x] **Pixel inspector:** v93j — shows owner flag + name + "X% (owner)" then an "Invaders — Y%" list (top 3 + "+N more").
- [x] **Daily status + GIF:** v93j — fires every 12h (00:00 + 12:00 UTC) to `#general` via a dedicated `daily_report` event; timelapse now 15-min frames over a rolling 12h window.

## Screenshots for tweets (v88)

`mapshot.js` renders a 256×256 PNG of a country. Client sends `geoColors`
(id→hex) at join; server caches `geoColorsById`; `makeCountryShot()` writes
to `/shots/` (pruned to 60), served at `/shots/{name}.png`.
`makeNotableShot()` only renders when the event will actually tweet (notable
country). Conquest + multi-attack attach `imageUrl`.

**`@napi-rs/canvas` IS used and required** (v92m added real flag rendering via
`loadImage`). The droplet runs **`@napi-rs/canvas@1.0.0`** (works on linux);
`package.json` was corrected from the old broken `^0.1.65` to `^1.0.0` in
v93l. The earlier "dropped, native dep breaks install" note was stale — do
NOT remove it or the `[Mapshot] preloaded N flag images` path breaks. The 0.x
line (esp. 0.1.80, `os:win32`) is what broke linux installs; 1.x is fine.

## X (Twitter) posting (v93l) — manual-approve only

`xposter.js` posts tweet drafts to X via `twitter-api-v2` (pure JS, no native
dep). **The game server never auto-posts** — the operator clicks "🚀 Post to
X" per draft in the admin dashboard (`/admin/tweets?key=$TWEETS_ADMIN_SECRET`).

- Flow: dashboard `postx` button → `POST /api/tweets/:id/postx` → `postToX()`
  uploads media (`/shots` or `/timelapse` file) via `client.v1.uploadMedia`,
  then `client.v2.tweet(text, {media})`; draft marked `posted` + `postedUrl`.
- Auth: OAuth 1.0a user context. **Operator-supplied `.env` vars** (never
  commit): `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.
  The access token MUST be generated with **Read+Write** app permission.
- `isXEnabled()` (all 4 vars present) gates the button; `/api/tweets` returns
  `xEnabled` so the dashboard shows/hides it. Missing dep/creds degrade
  gracefully (button hidden / error surfaced, server never crashes).
- Media upload needs a tier that includes `media/upload` (Free may not; Basic
  does). Text-only posting works on Free.
- **Deploy note:** adding `twitter-api-v2` needs `npm install` on the droplet
  (deploy.ps1 does NOT run it). `package-lock.json` is NOT git-tracked, so
  `git pull` won't conflict on it.

## Board persistence (v93o)

The painted board lives in `claimByPixel` (in-memory). Before v93o, **any
restart/deploy wiped the world** (state was never persisted — only profiles,
tweets, alliances were). v93o snapshots the board to `board_state.json`:

- `saveBoardSnapshot()` every `BOARD_SNAPSHOT_MS` (default 30s) + on SIGINT/
  SIGTERM (sync, so PM2 restarts/deploys save first). Atomic write via `.tmp`
  + rename. Gated on `mapReady` so it won't clobber the restored file before a
  client has loaded the geography.
- `loadBoardSnapshot()` on boot restores `claimByPixel`, `conqueredSet`,
  `permanentlyConquered`; derives `ownerPixels` + `countryPxCount`.
- **Stored as ID-based RLE runs `[start, len, countryId]`**, NOT raw indices:
  `getIdx()` assigns indices in order-of-first-appearance, so indices are NOT
  stable across runs. Restore remaps IDs → fresh indices via `getIdx()`.
- `board_state.json` is gitignored + runtime-written on the droplet (same
  hygiene caveat as the others below).
- Worst-case loss on a hard crash = one snapshot interval (~30s of paints).
  Graceful restarts (deploy.ps1 / pm2 restart) lose nothing.

## Droplet git hygiene

The droplet working tree accumulates runtime-written files (`tweet_queue.json`,
`countries-10m.json.gz`, `package-lock.json`, `ecosystem.config.js`). A stray
`git checkout -- package.json` may be needed before `git pull` if a deploy
ever modified a tracked file on the server. `deploy.ps1` does a plain `git
pull`; if it reports "Please commit your changes," SSH in and
`git checkout -- <file>` the offending tracked file, then re-deploy.

Path B (10k users) and Path C (millions) are documented in chat history but
not started.
