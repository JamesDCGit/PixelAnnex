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

**Current production triad: `2026-06-05-v95k`.** (v95d was a server-only conquest
owner-transfer change that deliberately did NOT bump the triad — it stayed at
v95c — so connected clients didn't reload; v95e is the next CLIENT change, hence
the jump v95c→v95e.) A server-only fix keeps all three at the same value so
connected clients don't reload. Only bump the triad when the CLIENT
(`pixelworld_v5.html`) actually changes. Comment tags (`// v95f:`) can run ahead
of the triad banner; that's fine.

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

**deploy.ps1 only restarts the SERVER (`pixelannex`), not the bot.** For `bot.js`
or `register-commands.js` changes, after `git pull` also:
`pm2 restart pixelannex-bot --update-env` (and `node register-commands.js` for new
slash commands). For new npm deps, `npm install` on the droplet (deploy.ps1 does
NOT). Server-only changes that don't touch the client: leave the triad unchanged
(no client reload), commit just `server.js`, and restart `pixelannex`.

**SSH quoting:** PowerShell→ssh mangles brackets/pipes/quotes. Run remote scripts
via a base64-encoded here-string piped to `base64 -d | bash` (pattern used
throughout this project's tooling). Node is not on PATH for non-login shells —
prefix with `export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH`.

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

### Changelog v93k–v94b (this session, condensed — details in sections below)
- **v93k:** fixed blank in-game country picker (`buildCselOptions` ran before
  `geoTotal` was populated → empty list); fallen grey-out uses id-based keys.
- **v93l:** X (Twitter) manual-approve posting (`xposter.js`); corrected
  `@napi-rs/canvas` `^0.1.65`→`^1.0.0`; tweet dashboard shows media preview.
- **v93m:** country names rendered as #hashtags in tweets (e.g. `#USA beats up #France`).
- **v93n:** FIX server crash — `set-country` used undefined `p` (was `player.`),
  crashing the whole server on every re-pick → in-memory map wiped (the recurring
  "game reset"); wrapped the WS message switch in try/catch.
- **v93o:** board persistence (`board_state.json`) — see section.
- **v93p–v93q:** empire balance (#1 defense, #3 continuity, #4 banked progression).
- **v93r/s/t:** inspector outpost labels, layout rework, conquered-count line.
- **v93u:** Fix A (per-country inspector %) + Fix B (clear stale permanent locks).
- **v93v/w:** stale-owner drift fix — windowed→full-stream switch now reconciles;
  client re-asserts viewport every 10s (region snapshot) so off-rect areas heal.
- **v93x:** rebuild `geoClaimCnt` on board restore (the real "Italy won't fall" fix).
- **v93y:** territory-panel popup→(then v93z highlight), bonus reset/ratchet,
  `/api/world-state` leaderboard filters unnamed/placeholder countries ("Country 168").
- **v93z/v94:** re-pick on load if your country fell (now AFTER Welcome Back popup);
  territory-panel click = map highlight (right-click inspect, shared helper); flag labels.
- **v94a:** war-room "major events only" (conquest dedup, multi-attack 6/30min,
  siege announce throttle, drop "Siege Lifted").
- **v94b:** nuke that wipes a conquered country reverses the conquest; 60s periodic
  ghost-flag sweep.

### Changelog v95–v95e (this session — FTUE + conquest-render fixes)
- **v95:** FTUE guided first-paint (client) — after the welcome modal closes, a
  brand-new player is dropped into a random FOREIGN country they hold no pixels in
  (camera tweens, glowing target zone + coach banner); 5 paints into it completes
  the step. One-time via `localStorage pa_ftue_guided_done`; `dbgResetFtue()` +
  `dbgResetTutorial()` replay it. See "FTUE guided first paint" section.
- **v95a:** fixed fallen-country re-pick never firing on an in-tab refresh —
  `sessionStorage(pa_daily_popup_shown)` survives reload, so the re-pick ran via
  the 1s fallback path BEFORE the snapshot populated `conqueredSet`, then never
  retried. Added `_snapshotApplied` flag; `_tryShowFallenRepick()` now waits for
  the snapshot (retries to 30s) before reading `conqueredSet`.
- **v95b:** fixed the "green triangle" draw bug — `applySnapshotRuns()` painted the
  server's true per-pixel ownership, then re-ran `finisherFill` for every conquest,
  re-flooding big contested countries (USA) with the conqueror's colour. For 34k-px
  USA that overflowed `PAINT_QUEUE_MAX`; the trim dropped the corrective invader
  paints, leaving a stale diagonal wedge (canvas = conqueror, `claimByPixel` =
  invaders). Fix: on snapshot replay, **only `placeFlag`** — the runs already hold
  the authoritative state. Live conquests still use the cinematic `finisherFill`.
- **v95c:** conquest flags now anchor to the GEO's largest landmass (via
  `geoPixelList`), not the conqueror's held pixels — after v95b the USA flag drifted
  to Hawaii (the holder's eroded footprint). `placeFlag` is holder-agnostic for
  position; conqueror still supplies the flag image/label.
- **v95d (server-only):** conquered land transfers to its dominant holder — see
  "Conquest fall mechanics" below. Supersedes the old "permanent lock, no transfer"
  model.
- **v95e:** a conquest flag PER landmass. `placeFlag` BFS-enumerates ALL connected
  landmasses (no early break) and flags the largest + others. Flag DOM reworked:
  `_flagDOMNodes[geoIdx]` is now an ARRAY of {img,label} nodes; `placedFlags` still
  keeps ONE primary entry/geo so the conquest count stays one-per-country.
- **v95g (server-only):** stop non-playable countries from PLAYING on the server.
  The client picker hid `NON_PLAYABLE_IDS` (Antarctica etc.) but the server had no
  such guard — a few stray pixels survive the client's lat<-60 / artifact cull
  (Antarctica keeps a 10px sliver), so the server spawned a bot for it and it
  painted + conquered (was holding Philippines + Libya). Mirrored
  `NON_PLAYABLE_IDS` into `server.js`: never spawn / always remove their bots, on
  map-ready reverse any conquest they hold (or of their geo), and the v95d transfer
  sweep won't hand ownership to one. Keep the two lists in sync. (Their residual
  ~10 own-pixels remain but are inert — no bot, can't be selected.)
- **v95f:** flag centring + caps. Position = the landmass pixel CENTROID snapped to
  the nearest land pixel (`_landmassCenter`), replacing v95e's density-grid
  densest-cell which drifted off-centre on wide countries (USA flag sat on the
  west side). Caps: max 3 flags/geo (largest first), extra landmasses must be
  ≥3px (ignore 1-2px specks). USA → continental + Alaska + Hawaii's Big Island.
- **v95h:** regen no longer STACKS bonuses. `getRegenMult()` takes the LARGEST
  single active bonus (David world-share, encirclement, rank, rally/highlight),
  rounds, and caps at **8×** — previously they all multiplied into runaway regen.
- **v95i:** conquered countries are re-conquerable like normal ones (transfer
  model). Replaces the v92q permanent lock + v95d plurality sweep. See "Conquest
  fall mechanics". Also: CONTEST_MAJORITY 0.70→0.85; empire-defense bonus dropped
  for already-conquered geos.
- **v95j:** territory panel (#legend) greys + strikes fallen countries (like the
  picker); inspector flashes the current owner's % red when ≤10% (danger of being
  taken over) — `.insp-danger` flash class, `_DANGER_PCT`.
- **v95k:** SURVIVORS aren't "fallen". `_isCountryFallenClient()` = homeland
  conquered AND holds no outposts (truly dead); used for grey-out, picker/repick
  strike, and on-load forced re-pick. A relocated survivor (e.g. Cuba conquered
  the USA, lost its island to Chad, lives on as "Cuba 1") is alive + selectable.
  `_isCountryConqueredClient` (any homeland conquest) still drives flag/holder lookups.

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
- **CRITICAL gotcha (v93x):** `geoClaimCnt` (the per-geo per-owner counts the
  CONQUEST CHECK reads) is NOT in the snapshot and MUST be rebuilt from
  `claimByPixel` + `geoAtPixel`. `geoAtPixel` only arrives at the first client
  join, so the rebuild is deferred (`_boardRestoredPendingRebuild` flag →
  `_rebuildGeoClaimCnt()` in the join handler). Forgetting this made restored
  boards invisible to fall logic — conquered countries sat un-fallen (the
  "Italy showed 98% foreign but the check saw 7%, never fell" bug). **Rule:
  any in-memory structure DERIVED from the board must be rebuilt on restore.**
- v93u also reconciles `permanentlyConquered` on load: a geo flagged permanent
  but no longer in `conqueredSet` (freed by a past reversal) is unlocked, so
  ghost-locked countries become playable/fall-able again.
- `board_state.json` is gitignored + runtime-written on the droplet (same
  hygiene caveat as the others below).
- Worst-case loss on a hard crash = one snapshot interval (~30s of paints).
  Graceful restarts (deploy.ps1 / pm2 restart) lose nothing.

## Conquest balance — empire model (v93p–v93q)

Goal: make territorial gains feel durable + defensible, not "one counterattack
wipes everything." Three levers (the 1+3+4 set):

- **#1 Empire-backed homeland defense (v93p):** each outpost a country holds
  raises the EFFECTIVE threshold to take its homeland — `empireDefenseBonus()`
  = `min(0.20, outposts*0.02)`, ceil 0.95. Layered ON TOP of the byte-identical
  `conquestThreshold()`; mirrored in client for prediction. Applied at both the
  champion + contested conquest paths on the DEFENDER. Debug endpoint shows
  `empireOutposts / empireBonusPct / effectiveConquestPct`.
- **#3 Empire continuity (v93q):** a country whose homeland is conquered does
  NOT die if it still holds ≥1 outpost — it RELOCATES (server sends
  `capital_relocated`; players keep playing, empire + bot kept; `_onCountryConquered`
  skips the giveaway/migration for survivors). Survivors are NOT added to
  `permanentlyConquered`, so they can fight to reclaim their homeland (rare).
  Only a country with ZERO territory dies → `your_country_lost` → re-pick.
  `_countryOutposts()` / `_largestOutpost()` drive survival + relocation target.
- **#4 Progression banked (v93q):** `your_country_lost` carries `keep:{conquests,
  rank, points}` (from the persisted Discord profile) and the re-pick modal shows
  "You keep…" so a true wipe never feels like total loss. (Profile stats already
  persisted in profiles.json; this just surfaces them.)

Re-pick / relocation is now driven STRICTLY by the server's targeted message —
the client conquest-event handler no longer guesses (it only draws the attack
arrow). `_countDistinctConquered()` (world-conquest trigger) counts
`conqueredSet` homelands, so survivors don't break the world-conquest check.

### Outpost naming + coordination (Stage 3 — DONE v93r/v93s/v94)
- Outposts are numbered per-holder by **geo-id ascending** (stable + identical
  on every client): `_outpostInfo(holderId, geoId)` → `{num, total}`,
  `_holderOfGeo(geoId)`. So "USA 2" means the same place for everyone.
- Pixel inspector header = current holder + number ("USA 2") for conquered
  territory, else the native name; body shows "Formerly {native}", "🗡️ Conquered
  N countries", and "{native} N% (Original)" + invaders.
- On-map flags (DOM overlay) show a text label underneath = holder + outpost
  number (v94), in `#flag-overlay` so it shares the flags' zoom/fade. v95e: a
  conquered country gets one flag PER significant landmass (see "FTUE / flag
  placement" — `placeFlag`/`_densestCenter`); the same holder+number label is
  repeated on each landmass.
- Inspector % AGGREGATES across all polygons of a country (v93u Fix A) — hovering
  one island of a multi-polygon country no longer misreports the whole country.

### Conquest fall mechanics — the bug-prone core (rewritten v95i)
**Model (v95i): a conquered country behaves like a normal one for TERRITORY
ownership.** Invaders chip away and it TRANSFERS to a new dominant holder; the
dead native never reclaims it. This replaced the v92q "permanent lock" (frozen
forever) + the v95d periodic plurality sweep.

`_evaluateConqueror(geo, total, dropEmpireBonus, excludeId)` is the single shared
"who should own this now?" function (used for virgin falls AND re-conquest):
- **(a) Champion:** strongest single country (ally-combined) ≥ `effThresh`
  (= `conquestThreshold(total)` + empire bonus unless dropped). `excludeId` (the
  current holder) is skipped so an alliance already holding the geo doesn't
  perpetually "win" the eval and block a new raw-pixel leader.
- **(b) Contested:** foreigners hold ≥ `CONTEST_MAJORITY` (**0.85**, v95i) of the
  PAINTED area (or ≥ `CONTEST_TOTAL_FRAC` of all land) → the single LARGEST RAW
  holder (`topCnt > nativeOwned`) takes it, even below the champion bar. Measured
  vs PAINTED land so big countries with unpainted interiors stay conquerable.

`applyPixels` per-geo loop:
- `_foreignHolderOf(geo)` → if currently conquered: run `_evaluateConqueror(…,
  dropEmpireBonus=true, curHolder)`; if a *different* country wins → `_conquerGeo`
  (transfer). Empire bonus DROPPED for conquered geos (operator decision). `continue`
  (skips the virgin paths + native reversal — conquered geos never revert to native).
- Virgin geo: champion (with empire bonus) then contested, exactly as before.
- The old reversal-to-native block still exists but is now effectively dead for
  conquered geos (they `continue` first) — virgin-just-conquered holders are at
  ~100% so it no-ops.

`_conquerGeo` (handles BOTH fresh falls and transfers):
- **Transfer detection:** geo already held by a different foreign country →
  `_isTransfer`. Drops the old holder + broadcasts its `reversal` (clients erase
  old flag), floods to the new owner, and **skips** native-death/relocation
  (`_onCountryConquered`), siege-clear, player notifications, and Discord/tweet
  reporting (anti-spam — only the first virgin→conquered fall reports).
- `_survives` is function-scoped (the relocation-notify block reads it).

Periodic 60s sweep (`_lastTransferAt`, `MAX_TRANSFERS_PER_TICK` 3): now a
BACKSTOP using the same `_evaluateConqueror` (the live loop only re-evals painted
geos). Transfers via `_conquerGeo`; still ghost-clears a holder wiped to 0 px.
- **Nuke reversal (v94b):** `_reverseConquestsForGeo` after a nuke (the nuke path
  bypasses applyPixels).
- **CAVEAT:** survivor natives can no longer reclaim their own homeland via this
  path (only foreign↔foreign transfer); they keep their relocated capital/outposts.
- Debug `/api/debug/country` still SHOWS `empireBonusPct` in `effectiveConquestPct`
  even for conquered geos (display only — the live eval drops it).

### Discord war-room event tuning (v94a — "major events only")
- Conquest: once per fall (the dedup guards above).
- Multi-attack: `MULTI_ATTACK_THRESHOLD=6`, per-defender `COOLDOWN_MS=30min`.
- Siege start: per-geo Discord announce cooldown 15min (`_siegeAnnouncedAt`) —
  anti-flap; the in-game `siege` broadcast to clients still fires every time.
- `war_siege_end` ("🛡️ Siege Lifted") is NOT posted to #war-room (bot drops it).

### Bonus model (encircle + rally regen)
- **v95h: regen does NOT stack bonuses.** `getRegenMult()` = `min(8, max(David
  world-share mult, encircle, rank, rally/highlight))` — the LARGEST single active
  bonus, rounded, capped at 8×. (Previously regen = `david × rank ×
  _highlightRegenMult` and `getMyMultiplier()` = `david × encircle`, which all
  multiplied into runaway regen.) `getMyMultiplier()` still multiplies david×enc
  but is now only vestigial; regen + the david-badge HUD use `getRegenMult()`.
  David mult auto-updates per country; rank persists (it's the player's).
- v93y: bonuses **reset on country change** (`_resetBonusesForCountryChange()`
  on `selectCountry`/re-pick: clears encircle + `clearHighlight`).
- v93y: encircle bonus **only ratchets UP** — a smaller new encirclement keeps
  the active higher multiplier and extends the timer (no downgrade).

### Remaining backlog
- [ ] **(2b) Cascade death:** force re-pick when a country loses its LAST outpost
  while its homeland is already gone (currently a landless "rebel" that fights on).
- [x] **FTUE — guided first paint (v95):** done. See section below. Further FTUE
  ideas not built: HUD coach marks, first-session objectives, contextual nudges.
- [ ] **Ads (next):** network, banner-only placement, consent banner, real domain.
- [ ] **Map-data arc spikes (known, low sev):** a few tiny countries (Hong Kong,
  Brunei, Curaçao, Bahamas, Gibraltar) have bad polygon arcs giving them
  near-full-map bounding boxes → faint thin diagonal stripes. `isBoundingArc`
  (only catches near-HORIZONTAL arcs: `ΔLat<0.5 && ΔLon>2`) lets diagonal ones
  through. Fix would extend the degenerate-arc filter in `drawRing`/`isBoundingArc`.
- [ ] **Live-conquest queue hardening:** a single live conquest of a huge country
  still floods 34k paints into `_paintQ` (self-corrects in-viewport). Same root
  mechanism as the v95b snapshot bug; not yet hardened.

## FTUE — guided first paint (v95)

First-time onboarding has two layers (both client, `pixelworld_v5.html`):
1. **Welcome modal** (pre-existing): 3 steps — how-to-play tiles → country picker
   → Discord sign-in. Shown once, gated on `localStorage pa_tutorial_seen`.
2. **Guided first paint (v95):** kicks off from `closeTutorial()` ~600ms after the
   welcome modal closes. `startGuidedPaint()` → `_pickGuidedTarget()` picks a random
   FOREIGN country the player holds NO pixels in (excludes own country id + conquered
   ids + where `geoClaimCnt[i][currentIdx]>0`; prefers medium-sized for visibility),
   tweens the camera (`_focusGuidedTarget`), and shows a pulsing target zone
   (`#ftue-highlight`) + coach banner (`#ftue-coach`). The highlight is a DOM div
   re-projected in `applyT()` (NOT drawn on `c-highlight` — the siege flash owns +
   clears that canvas). `paintBrush()` calls `_ftueOnPaint(px,py)`; `FTUE_GOAL` (5)
   paints into the target geo completes it (`completeGuidedPaint`). One-time via
   `localStorage pa_ftue_guided_done`. Debug: `dbgResetFtue()` (just the guided step)
   or `dbgResetTutorial()` (both, + reload).

**Design choice (operator):** the first action teaches EXPANSION/attack into a
foreign country, not painting your homeland.

## Droplet git hygiene

The droplet working tree accumulates runtime-written files (`tweet_queue.json`,
`countries-10m.json.gz`, `package-lock.json`, `ecosystem.config.js`). A stray
`git checkout -- package.json` may be needed before `git pull` if a deploy
ever modified a tracked file on the server. `deploy.ps1` does a plain `git
pull`; if it reports "Please commit your changes," SSH in and
`git checkout -- <file>` the offending tracked file, then re-deploy.

Path B (10k users) and Path C (millions) are documented in chat history but
not started.
