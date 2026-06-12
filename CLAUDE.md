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

**Current production triad: `2026-06-12-v99i`.** (v99h was server-only at v99g
— per-country draft cooldown + autopost; v99i = Discord invite update to
discord.gg/gM7t7Vm86 across client links, tweet copy, and the bot embed
footer.) (v98/v98a client+server, v98b
server-only at v98a, v99 client map cleanup, v99a UI polish, v99b exile regen +
tweet cadence, v99c panel alignment/zoom, v99d occupation tracker + map tint,
v99e polish pack, v99f flags/borders/rim, v99g ocean-halo borders — see
changelog below.)
(Previously `2026-06-07-v97`.) (CLIENT changes since v95w: v96
encircle-additive regen, v96a dead-land clear-on-reversal, v97 leaderboard tabs +
win contributors + nuke + ranks. Server-only runs v95x/v95y/v95z stayed at v95w.)
(v95d was a server-only conquest owner-transfer change that
deliberately did NOT bump the triad — it stayed at v95c — so connected clients
didn't reload; v95e is the next CLIENT change, hence the jump v95c→v95e.) A
server-only fix keeps all three at the same value so
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
- [x] i18n conquest threshold updated 60%→70% across all locales (v95t).
- [x] Dead own-stroke layer removed (v95t).

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
- **v95l:** (1) Fightback is HOMELAND-ONLY — `_fightbackEligible(idx)` gates the
  banner, `getFightBackBonus`, and `getExplosiveBrushPixels`; once your homeland is
  conquered it can't reactivate (fixes survivors like Cuba showing "100% lost").
  (2) Reverted v95e/f per-landmass multi-flag back to ONE flag per country on the
  largest landmass — and `placeFlag` now aggregates ALL polygons sharing the
  country id (geoIdx is only one polygon; for a country whose last-registered
  polygon is a tiny/culled island it found no pixels → the "no flag on Australia"
  bug). (3) Right-click inspect pulse decoupled from duration → ~2 pulses/sec.
- **v95m:** ROLLED BACK the survivor/relocation mechanic (v93q empire continuity).
  Homeland fall = death always (forced re-pick), cutting slow churn. `_conquerGeo`
  runs the death sequence only on a FRESH kill (a living country's first homeland
  fall — not a transfer / self / re-take of a Fallen zone); mercenary/revenge bonus
  20→50. `_onCountryConquered` LIQUIDATES the dead country's empire OUTSIDE its
  homeland: hand to a living alliance partner (pixels + outpost flags), else CLEAR
  the pixels + drop its outpost conquests → those become neutral "Fallen" land
  (dead native, no holder, reconquerable). `permanentlyConquered` is now "dead for
  the round": `_clearPermanentIfFree` is a NO-OP and board-restore no longer
  un-sticks unheld locks. Client: `permanentlyConqueredSet` (welcome state + `perm`
  flag on conquest); `_isCountryFallenClient` uses it; inspector shows
  "{native} — Fallen" for an unheld dead native.
- **v95n:** stop cheap conquests of sparsely-painted countries. The painted-relative
  contested path discounted unpainted native land, so a fresh/passive small country
  fell at ~45% (Denmark 103px, NZ both fell to Belize). Fix: `CONTEST_TOTAL_FRAC`
  0.60→**0.85** (group needs ≥85% of the WHOLE country), and the painted-relative
  leniency (`CONTEST_FLOOR`/`CONTEST_MAJORITY`) now applies ONLY to large countries
  (`CONTEST_LARGE_MIN` 8000px). Small/medium → 75% single (champion) or 85% of
  total (group). Applied in `_evaluateConqueror`, the virgin contested path, and the
  debug `wouldFall`. Server-only.
- **v95o:** fixed conquered countries still being selectable + the FTUE coach
  obscured. The `welcome` message cherry-picked `{conquered,players,sieged}` and
  OMITTED `permanentlyConquered` — so the client's `permanentlyConqueredSet` was
  always empty and NOTHING greyed (any country, incl. conquered USA, was pickable).
  Welcome now includes it. The welcome/tutorial picker also never checked fallen:
  `_applyTutFallenRows()` greys+disables them (re-run from the welcome handler for
  the seed-timing race) and `selectTutCountry` rejects them; in-game csel re-renders
  on welcome. FTUE coach moved top:16px→64px (was under the top-centre `#login-hud`).
- **v95p:** (1) inspector danger flash is now PROGRESSIVE — the current owner's %
  flashes red with variable speed set inline (`animation-duration`), slow at the
  bottom of the danger window (~25 pts below the conquest threshold) ramping to fast
  at the threshold; window scales with size + empire bonus. Replaces the fixed ≤10%
  flash. (2) multi-attack notifications: `MULTI_ATTACK_THRESHOLD` 6→10 and
  `MULTI_ATTACK_COOLDOWN_MS` 30→60 min (was still firing several/hour).
- **v95q:** inspector — "Formerly {country}" moved to the 2nd line (directly under
  the new owner name), country name bolded.
- **v95r:** inspector — "Formerly {country}" now bold at title size (12px); removed
  the "Conquered N countries" line to streamline the menu.
- **v95s (server-only):** stop duplicate tweet drafts. `_tweetLastByKey` dedupe is
  in-memory (5-min window) and wiped on restart, while the news scrape runs 90s
  after every boot — so many restarts re-queued the same headline. pushTweetDraft
  now also dedupes against the PERSISTED queue (skip identical PENDING draft by
  dedupeKey or text; dedupeKey stored on the draft), and loadTweetQueue drops
  identical pending drafts on boot.
- **v95t:** backlog cleanup — i18n conquest threshold 60%→70% (all locales); removed
  the long-dead own-stroke overlay layer (canvas + stubs + refs).
- **v95u:** backlog cleanup — isBoundingArc also rejects diagonal degenerate arcs
  (verified no real country lost); enqueuePaintsSweep paints a >8000px flood
  instantly instead of staggering it through _paintQ (live-conquest hardening).
- **v95v:** operator admin dashboard. Secret-gated `/admin?key=$TWEETS_ADMIN_SECRET`
  (`_adminOK` reuses the tweet secret): live KPIs (5s poll) via `/api/admin/metrics`
  + safe world controls via `/api/admin/control` (toggle bots — `_BOTS_DISABLED` now
  `let`; spawn UFO/Kraken/Godzilla; broadcast `admin_announce`; reset world). Client
  handles `admin_announce`→activity card (world_reset/monster_spawn already handled).
- **v95w:** Umami Cloud traffic analytics — cookieless `<script>` in `<head>` (no
  consent banner). `paTrack()` safe wrapper + funnel events `signed_in`,
  `country_selected`, `ftue_complete`. Website-id 22da671f-…
- **v95x (server-only):** twice-daily world summary fixes. (1) dedupeKey was built
  from SCHEDULE-time sliced to 13 chars ("Sat, 07 Jun 2" = day, mangled year) so the
  00:00 and 12:00 fires collided and the 2nd was deduped → "no morning post". Now
  FIRE-time + per-12h slot (`YYYY-MM-DD`+AM/PM). (2) `_timelapseRoundStart` was
  `_serverStartMs`, so every deploy excluded on-disk frames older than boot → GIF fell
  back to the static PNG. Now starts at 0 (pure trailing 12h window); only
  `_resetWorld()` bumps it.
- **v95y (server-only, mapshot.js):** UTC timestamp burned into each timelapse frame
  (`renderWorldPNG` optional `label`, bottom-left pill) so the GIF ticks through 12h.
  Only new frames are stamped; fully stamped after ~12h.
- **v95z (server-only) — DEAD-COUNTRY EMPIRE LEAK (the "Guinea-Bissau 1 (formerly
  China)" bug):** a conquered country's outpost stayed alive after the holder itself
  died. FOUR compounding root causes, all fixed:
  1. `finisherFill` (the conquest flood) wrote claimByPixel/geoClaimCnt/countryPxCount
     but NEVER `ownerPixels`. So conquered land was invisible to `_onCountryConquered`
     (which liquidates by iterating ownerPixels). → finisherFill now calls
     `updateOwnerIndex`.
  2. `_evaluateConqueror` + the `applyPixels` virgin champion/contested loops did not
     exclude DEAD countries, so a dead holder at ~100% kept being re-selected as
     conqueror → infinite re-conquest. → all FOUR candidate loops now
     `continue` on `permanentlyConquered.has(cId)`.
  3. liquidation iterated `ownerPixels[dead]` which can DRIFT from claimByPixel (it
     once left a dead country "holding" 98% of China). → `_onCountryConquered` now
     scans `claimByPixel` DIRECTLY (full 2M scan; death is rare) for the dead
     country's pixels.
  4. the backstop only re-fired off a conqueredSet entry, missing remnants with NO
     entry (China showed `conquered:false` but 98% Guinea-Bissau). → the 60s sweep
     also re-liquidates any `permanentlyConquered` country with `countryPxCount>0`,
     and `_onCountryConquered` zeroes `countryPxCount[dead]` at the end so the pass
     terminates. Verified: GB's 50,528px cleared → China/Australia became neutral
     Fallen land; sweep self-healed other accumulated dead-country remnants.
- **v96a (client):** dead country's conquered land sometimes stayed PAINTED on a
  client even though the server cleared it. The server's per-pixel clears go through
  the viewport-filtered delta path, so a client looking elsewhere (or a freshly-
  conquering player zoomed in) never received the off-screen clears — only the flag
  vanished (the `reversal` is a full broadcast; the pixel clears are not). Fix: the
  client `reversal` handler now also runs `_clearHolderInGeo(geo, holder)` on
  `reason:'fallen'`/`'empty'` — clears that holder's pixels across all polygons of
  the geo locally, so conquered land disappears for everyone on the full broadcast.
  Skipped for `transfer`/`inherited` (paired `conquest` re-floods) + liberation
  reversals (no reason: invader keeps its pixels).
- **v97 (client + server):** leaderboard + win-screen + nuke + ranks.
  - **Leaderboard** (`#leaderboard-panel`) now shows PIXELS + CONQUESTS per player
    (was points) with **All Time** (persisted profiles) / **Session** (current
    round) tabs (`switchLbTab`, `_lbScope`). `/api/stats/leaderboard?scope=session|
    alltime`; rows carry pixels+conquests (+points kept for the Stats modal).
    All-time sorts by pixels; filter includes pixels|conquests|points>0.
  - **Session stats** = in-memory `_sessionStats` (discordId → pixels/conquests),
    `_recordSession()` at the 3 stat-increment sites, reset on boot + `_resetWorld`.
    `_sessionLeaderboard(n)`.
  - **Win screen** (`_showWorldConquestOverlay`) adds "🔥 TOP CONTRIBUTORS — THIS
    SESSION" from `topContributors` (session pixels+conquests) in the world_conquest
    payload (natural `_checkWorldConquest` + admin force-win).
  - **Nuke:** radius 15→**30**, lockout 30s(debug)→**2min** (`NUKE_LOCKOUT_MS`).
    Contained to the SINGLE nation it lands on: `clearPixelsInRadius(cx,cy,r,
    restrictGeo)` skips pixels whose `geoAtPixel!==restrictGeo`; handler passes the
    impact nation's geo (stored on the zone for the expiry re-clear). Client mirrors
    it in `detonateBomb` (`_nukeCenterCid`) + `getBombTypes` radius 30.
  - **Ranks ×2:** client `RANKS` (pixel-based) 100/300/1000/3000; server
    `RANK_THRESHOLDS` (XP) 100/300/600/1000.
- **v97b (server-only) — LANDLESS PHANTOM HOLDERS:** a Natural Earth artifact with
  no homeland (`geoTotal===0`, e.g. "Country 167") had conquered New Zealand and
  stayed its ~80% majority holder, so the real attacker could never take it (client
  showed 92%, server saw the phantom). `_isLandlessCountry(id)` = `geoTotal[id] not
  > 0`; all four `_evaluateConqueror`/`applyPixels` candidate loops skip landless
  ids (can't be a conqueror), and the 60s sweep liquidates any landless holder of a
  real geo via `_onCountryConquered` (clears pixels → Fallen) just like a dead
  country. Generalises the v95g/v95z machinery. Verified: 167/169/171 liquidated,
  NZ freed (now Congo top holder).
- **v97c (client + server):** world-state bar "countries remain" was misleading —
  `totalCountries` (238: ALL geos incl. ~50 unnamed artifacts + landless features)
  minus only currently-HELD conquests (50), ignoring the ~98 fallen natives, so it
  read ~179 while the picker showed ~83. `/api/world-state` now also returns
  `originalTotal`/`originalStanding`/`originalConquered` via `_playableCountryStats()`
  (named, land-having, playable nations; standing = homeland not
  permanentlyConquered). The single cell split into "countries left"
  (=originalStanding, matches picker) + "of original" (=originalTotal).
  `refreshConqueredCountLocal` no longer overwrites it with the raw-geo calc.
  Verified live: total 182 = standing 84 + fallen 98.
- **v97d (server + bot.js):** war notifications named a fallen country by its dead
  native ("#USA defending…" after USA fell). Now named by the CURRENT holder with
  the fallen native noted — "Brazil (formerly USA)". `_geoDefenderName` /
  `_geoDefenderTag` (holder-aware via `_foreignHolderOf`). Multi-attack sassyText +
  tweet hashtag + screenshot flag use the holder (Discord multi-attack already
  renders the server sassyText). `checkSiegeState` excludes the current owner from
  the besieger calc (no more "Brazil has 100% of USA") and sends
  `defenderName="Holder (formerly Native)"` ONLY when conquered; bot.js uses it
  (normal sieges keep the native role-mention). NOTE: bot.js change → needs
  `pm2 restart pixelannex-bot` (done).
- **v97e (client + server) — REGEN OVERHAUL + OUTPOST MODE.** Regen cap 10→**12**.
  - **David curve:** `getRegenMultiplier`/`_davidMult` now CONTINUOUS (was 5 tiers):
    `1 + 6·(1 − share/0.05)³`, clamped — tiny homelands ~7×, →1× at ≥5% world share
    (`DAVID_FLAT_SHARE`). share is STATIC (homeland size).
  - **Alliance bonus** (`_allianceRegenAdd`): underdog-scaled + ADDITIVE — small
    allied member +2 → large allied member +0.5 (`0.5+1.5·(1−share/0.05)`).
  - **Leader tax** (`_leaderTaxSet`, `_recomputeLeaderTax` each david snapshot): the
    top-3 CURRENT land-holders (≥4% of painted) get ×0.8 regen — the dynamic
    rubber-band (chosen over a full ELO system; David is static so it can't balance).
  - **Unified formula:** server `_serverRegen(id)` (bots) + client `getRegenMult()`
    mirror: `exile? 0.5 : clamp(0.5,12, max(david,rank,highlight,1) + encircleAdd +
    allyAdd) × (leaderTax?0.8:1)`. The david snapshot carries `allyAdd`/`leaderTax`/
    `exiled` per country so the client mirrors exactly.
  - **Outpost mode (reinstated, v95m partially reverted):** a homeland fall is now
    **EXILE** (not death) IF the country still holds a conquered outpost — it survives
    at a flat **0.5× regen** until it reclaims its homeland. `exiledSet` (SEPARATE
    from `permanentlyConquered`, so exiles can still conquer + aren't liquidated; not
    "Fallen", `perm=false`). No outposts → true death as before. 60s sweep resolves
    exiles: homeland reclaimed (`_foreignHolderOf(home)===null`) → lift debuff
    (`homeland_reclaimed`); lost all outposts → final death (`your_country_lost`).
    New client msgs `homeland_exiled`/`homeland_reclaimed` (banner, NO re-pick).
    Cleared on world reset.
- **v97f:** pixel bucket rounded to 1dp (was drifting to 99.9999999 from fractional
  regen) — at the regen tick + HUD/title display.
- **v97g (client):** "invert my pixels" toggle (toolbar 🔄 My Pixels, persisted,
  default OFF). `_renderRgb(fi)` renders the CURRENT player's own pixels in the
  inverse of their country colour (client-side only) so they're visible when
  painting onto a same-coloured country. Routed through all paint paths; toggle/
  country-change repaints via `mpRebuildClaimCanvas`, which now also preserves the
  faint native base (alpha 26) vs painted (215).
- **v97h (client + server):** leaderboard scoping + war counter + Terms tab.
  - **Session = the current GAME** (until world conquered), now PERSISTED to
    `session_state.json` (`_saveSessionState`/`_loadSessionState`, 30s + shutdown +
    on reset) so a restart mid-game keeps the tally; cleared only on `_resetWorld`.
    **All-time** = cumulative across games (persisted profiles, unchanged).
  - **War counter:** `_warNumber` (persisted, +1 each `_resetWorld`); `/api/world-state`
    `warNumber`; status bar shows "PixelAnnex War #N" (`ws-war-num`). Starts at #1.
  - **Terms & Disclaimer tab** in the Stats & Leaderboard modal (`stats-panel-terms`).
- **v97i:** removed `backdrop-filter:blur` from `#stats-overlay` — it left a ghost/
  afterimage rectangle when a tab repainted under the blur (Chrome compositing bug);
  the 0.78 dark overlay dims fine without it.
- **v97j:** encircle `ENCIRCLE_MIN_PX` 50→15 + tiers shifted (15/50/150/300 →
  3/4/5/6×); tiered celebration text Nice!/Amazing!/Outstanding!/Legendary!
  (`_encircleLabel`). Pixel bucket displays whole pixels (`Math.floor`, no decimal).
  Picker drops countries below `MIN_PLAYABLE_PX` (5px) — Vatican/San Marino/Brunei
  etc. no longer selectable.
- **v98 (client + server) — encircle rewrite + regen overhaul + reconquest rules:**
  (1) ENCIRCLE: `detectEncirclement` + client `runAutoFill` now run a TWO-PASS BFS
  (with vs without the stroke's actually-flipped pixels — server tracks a
  per-stroke `changedSet`, client uses `_strokeChangedSet`) so only regions THIS
  stroke closed are awarded — kills the retrigger/60s-reset loop (old pockets
  chipped by bots re-detected on every stroke-end). Server bbox now from the
  STROKE (+160px pad), not cumulative own pixels (scattered own pixels used to
  blow the 200k-cell cap → silent no-trigger). Enclosed collection spans ALL geos
  (border circles) and the cap is 10000 = client `MAX_FILL_PX`, skip-whole not
  truncate (the old 500 row-major cap filled the TOP SLICE of big circles — the
  "half fill" bug). `FILL_MIN_PX` 10→15 = `ENCIRCLE_MIN_PX`. Server bonus ratchets
  (no mult downgrade while active). (2) REGEN: timestamp-based 1s accrual at the
  SAME rate (`mult/REGEN_INTERVAL` per second), works in background tabs
  (`document.hidden` early-return removed; visibilitychange calls `_regenTick`),
  multiplier rounds to a whole number, bucket clamped [0,MAX], `paintBrush`
  requires a full pixel (fractional bucket could go negative before).
  `regenSecsLeft` removed; timer text is now "+N/min". (3) RECONQUEST: taking an
  already-held geo needs the FULL champion threshold (`_evaluateConqueror`
  championOnly — the contested path was trivially satisfied on conquered geos, so
  any >50% raw holder flipped them). `CONQUEST_IMMUNITY_MS` 20s→60s, broadcast as
  `immunityMs` on the conquest msg; client draws a gold "🛡️ Ns" countdown under
  the flag (`_geoImmuneUntil` + `pa-flag-shield` node). (4) NUKE: lockout 2→5min
  (server + client `lockoutMs`), m:ss countdown drawn above the zone on `c-nuke`.
  (5) DAVID: `getWorldShare` = max(homeland geoTotal, CURRENT `countryPxCount`) /
  total land — a small country's underdog buff fades as its empire grows, a wiped
  Goliath stays Goliath; the v97e leader tax is REMOVED (client + server).
  (6) PERF: `_alliedCnt` uses `idToFeatIdx` (the documented findIndex landmine had
  been re-added), `runAutoFill` reuses a scratch queue, siege pixel cache survives
  zero-siege frames.
- **v98a (client):** territory panel — fallen countries REMOVED from the list
  (was greyed); hovering a row shows the countries it currently OCCUPIES
  (`_occupationsOf` from conqueredSet → `#leg-occ-tip`); `#legend` z-index 12 so
  flags (z7) no longer render over it. Siege flash aggregates ALL polygons of a
  country id (`buildSiegeCache` + per-frame id dedupe) — Finland flashed half.
- **v98b (server-only + bot.js, triad stayed v98a):** (1) country names load from
  `countries-10m.json` at boot (`loadCountryNamesFromDisk`, mirrors client v97k
  parse incl. synthetic 9000+ids); client `geoNames` IGNORED — fixes
  "#Country710" (=South Africa; names were empty between restart and first join)
  and closes the any-client-renames-every-country injection into tweets/Discord.
  (2) `_isPlayableCountry` (NON_PLAYABLE + real name + ≥5px `MIN_PLAYABLE_PX_SRV`)
  enforced at set-country, join (graceful: strips country + forces re-pick via
  `your_country_lost`, never hangs the join), bot roster (191→183 bots), and the
  conquest-clear sweep — Vatican/Gibraltar/"Country 133"/171 fully blocked.
  (3) sass: +4 conquest revenge-bait lines, +2 multi-attack defend-or-overthrow
  lines, nuke copy 2→5min, NEW 12h fallen-country spotlight draft
  (`_queueFallenSpotlight`, notable only). (4) football matchups: BBC/ESPN
  football RSS → "X v Y" fixtures where both sides are game countries →
  tweet draft + `football_matchup` bot event → #general embed
  (`handleFootballMatchup` in bot.js — needs `pm2 restart pixelannex-bot`).
  Copy deliberately avoids FIFA/World Cup wording (trademarks). (5) security:
  timing-safe admin compare; /admin + /admin/tweets set an HttpOnly SameSite
  cookie from ?key= and 302 to a clean URL; `/api/tweets` + force-win unified on
  `_adminOK` (any of query/header/cookie); per-IP WS cap (`MAX_WS_PER_IP` 10).
- **v99 (client):** map cleanup — new per-COUNTRY connected-component pass at map
  build (after micro-island removal, before `buildCselOptions`): same-geo
  components <5px are reassigned to the dominant neighbouring country (keeps
  coastlines solid) or removed to ocean when isolated. Kills stray single-pixel
  exclaves; countries shrunk below 5px become unpickable (client picker + v98b
  server floor) and lose bots. Server inherits the cleaned geo data from the next
  v99 client join.
- **v99a (client + server) — UI polish + notification tuning:** popup fonts
  normalised to game-default body size (13px body / 11px meta across welcome,
  FTUE, daily popup); country pickers (welcome, csel, re-pick modal) list ACTIVE
  countries first with fallen sunk to the bottom; territory-panel fallen filter
  moved BEFORE the top-20 slice; ONE global scrollbar style (8px #1e293b)
  replaces per-panel variants; CTA pulse (`ctaPulse`) on enabled primary
  tutorial buttons + welcome-back close; music+SFX OFF by default
  (`_audioPrefsDefault`), audio buttons icon-only (no MUTE text, 13px glyphs);
  conquest tile copy corrected (70–75%, smaller countries need a HIGHER share);
  #legend/#leaderboard/#zoom-hud unified at 14px edge gap; encircle + fightback
  banners top 60→100px (cleared the #social-links row); rally cooldown 60s→10min
  (client + server) with visible m:ss countdown on the button. Server:
  multi-attack now SUSTAINED-only (≥3min per-attacker firstTs, 12 attackers,
  50px/attacker, 400px window floor); "swept clean" conquest sass reworded
  (politically risky phrasing); news scrape stays daily, football 6h. NOTE: the
  bot roster dropped 183→166 once a v99 client sent cleaned geo data — the
  remaining micro-feature cull, intended.
- **v99b (client + server):** (1) EXILE REGEN: no longer flat 0.5× — the passive
  base (David/rank/rally) is replaced by 0.5, but earned bonuses (encircle,
  alliance) still ADD on top; sub-1 totals stay at exactly 0.5 (no round-up).
  Mirrored in client `getRegenMult` + server `_serverRegen`. Client shows a
  pulsing red `#exile-badge` ("REGEN LIMITED — RECLAIM YOUR HOMELAND") in the
  toolbar while exiled (2s sync off the david snapshot's `exiled` flag).
  (2) TWEET CADENCE: news scrape 24h→12h (football stays 6h); community tweet
  pinned to literal 24h; NEW hourly draft-freshness watchdog
  (`_draftFreshnessTick`) — if the newest draft is >3h old, runs the next
  generator in rotation (status → activity → fallen spotlight → football),
  fixing multi-hour draft gaps. Posting stays manual-approve.
- **v99c (client):** leaderboard panel was the ONLY panel missing from the
  font-scale zoom targets (`_applyFontScale` + the boot-time default-zoom copy)
  — un-zoomed font, Aa button had no effect, and its 14px offsets didn't scale
  like the zoomed panels'. Added to both lists. Leaderboard bottom 50→14px (the
  50px cleared the old floating `#zoom-hud`, which no longer exists — zoom
  buttons live in the toolbar as `#zoom-hud-tb`; the dead `#zoom-hud` CSS rule
  + zoom-target entries remain harmlessly). Rank panel top 54→14px (stale
  double offset — it's positioned inside the viewport, which already starts
  below the toolbar). All corner panels now share the same zoomed 14px edge gap.
- **v99d (client):** (1) OCCUPATION TRACKER: `inspectCountryHighlight`
  (right-click + territory-panel click) also collects the geos the inspected
  country currently occupies (`_inspectOccSet` from conqueredSet, all polygons
  per id); `tickInspectHighlight` adds a pulsing RED wash over those FULL
  territories (pass 1.5, between the gold home wash and cyan footprint), and
  the holder's conquest flags glow (`.occ-pulse`, filter-based — transform is
  owned by `_updateFlagDOMPosition`). Inspect card shows "occupies N countries".
  (2) MAP TINT: land biome output saturated around the per-pixel grey axis
  (S=2.2, +5 lift) and ocean remapped teal→blue (`oceanColour` returns
  r*0.3+34 / b*1.25) to sit closer to a topographic reference; the waves layer
  shares `oceanColour` so it follows automatically.
- **v99e (client) — polish pack:** (1) coastline shelf — 2px lighter shallow-
  water rim along every coast, pre-baked in `buildWaveBase` (waves restore from
  the same image); (2) terrain grain — deterministic ±3 value noise per land
  pixel baked into the biome pass; (3) eased zoom — `doZoom` sets a target,
  rAF loop converges scale ~35%/frame cursor-anchored (`_zoomApply`); (4)
  conquest shockwave — `.conquest-ring` red ring spawned at the flag on every
  conquest broadcast (`_spawnConquestRing`, positioned once, 1.1s); (5) flag
  drop-in bounce on placement (margin-top keyframe `flagDrop` — transform is
  owned by `_updateFlagDOMPosition`; class removed on animationend).
- **v99f (client):** flags no longer fade out at high zoom (`_updateFlagOpacity`
  faded to 0 at scale≥10 — max zoom is the typical gameplay view and the fade
  hid flags + the v99e bounce + v99d occupation pulse). Borders are 1px and
  ALWAYS land-side (the scan used to mark the left/top pixel — ocean on west/
  north coasts) and the v33 2-pass ocean dilation is REMOVED (it padded every
  coast with 2px of border over the water; trade-off: strait-crossing border
  bridges are gone — the rim is the separation cue now). Coast rim 2px→3px
  (third ring, soft falloff).
- **v99g (client):** visual borders moved entirely OFF the land — a 1px OCEAN
  HALO (`bordVisPixel`: ocean pixels 8-adjacent to land, drawn on the border
  canvas). No land pixel is ever covered, and the 1px rasterization ocean
  seams between adjacent countries are halo-filled (ocean-touching-land on
  both sides). Halo pixels are ocean → inherently unpaintable. `bordPixel` is
  now GAMEPLAY-ONLY (encirclement BFS seeds, symmetric 4-neighbor land-edge
  marking, NOT drawn) — keep the two arrays distinct; `reborderCanvas` (the
  dark/light toggle) repaints from `bordVisPixel`. Internal land-land borders
  (no ocean gap) have no drawn line — native tints mark the boundary.
- **v99h (server-only):** (1) per-country 12h draft cooldown in `pushTweetDraft`
  (drafts persist `countries[]`; fixes two #Iran drafts from one football
  scrape). (2) AUTOPOST: `_autoPostTick` every 2.5h posts the oldest eligible
  pending draft (no country posted <12h ago, draft <24h old); `autoPosted:true`
  flag for auditing; `X_AUTOPOST=0` disables. See the X posting section.
- **v97k:** no-id Natural Earth features (Kosovo, disputed zones) parsed to id='' and
  MERGED into one degenerate geo (Kosovo stuck >80% "can't conquer"; the blob's
  scattered pixels showed as stray dots). Each now gets a UNIQUE synthetic numeric id
  (`9000+index` — clear of real ISO ≤894, fits Int16 `geoAtPixel`). Picker hides
  "Disputed Territory" artifacts; Kosovo (real name) is selectable + conquerable.
  NOTE: not-reproducible "country resets to Afghanistan after conquering" — no
  definitive cause found; left for a repro rather than a blind fix.

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

## X (Twitter) posting (v93l manual + v99h autopost)

`xposter.js` posts tweet drafts to X via `twitter-api-v2` (pure JS, no native
dep). The operator can post per-draft via "🚀 Post to X" in the admin dashboard
(`/admin/tweets?key=$TWEETS_ADMIN_SECRET`). **v99h added AUTOPOST** (operator
request): every 2.5h the oldest eligible PENDING draft is posted automatically
— skipped if any of its countries appeared in a tweet posted <12h ago, or if
the draft is >24h old (stale → manual only). One post per tick spreads posts
across the day. Dismissing a draft in the dashboard before its slot prevents
it posting. Kill switch: `X_AUTOPOST=0` in `.env`. Drafts also enforce a
12h per-country cooldown at CREATION time (`pushTweetDraft`, persisted
`countries[]` on each draft).

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
- **#3 Empire continuity (v93q) — ROLLED BACK in v95m.** Survivor/relocation is
  GONE: a homeland fall now ALWAYS kills the country (`your_country_lost` → re-pick),
  and its empire outside the homeland is liquidated (alliance heir, else cleared to
  "Fallen"). See the v95m entry in the changelog + "Conquest fall mechanics". The
  text below describes the old behaviour and no longer applies. (`capital_relocated`
  is no longer sent; `_largestOutpost` is now unused.)
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
  number (v94), in `#flag-overlay` so it shares the flags' zoom/fade. v95l: ONE
  flag per conquered country, on its LARGEST landmass (`placeFlag` aggregates ALL
  polygons of the country by id, BFS for the biggest connected landmass, centred
  via `_landmassCenter` = centroid snapped to nearest land pixel). The v95e/f
  per-landmass multi-flag was reverted (mis-flagged small disconnected lands; and
  using a single polygon index missed multi-polygon countries → no flag on
  Australia). `_flagDOMNodes[geoIdx]` is still an array but holds one node now.
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

`_conquerGeo` (handles fresh falls AND transfers):
- **Fresh kill** (`_freshKill` = not a transfer, not a re-take of an already-dead
  geo, not self): adds `permanentlyConquered`, clears siege, runs
  `_onCountryConquered` (liquidates the dead empire), and sends `your_country_lost`
  (mercenary 50) + Discord report. v95m: there is no "survives" path anymore.
- **Transfer / re-take of a Fallen zone / self:** drops any prior holder +
  broadcasts its `reversal`, floods to the new owner, but SKIPS the death sequence
  + notifications + Discord (anti-spam). The `perm` flag on the broadcast conquest
  = `permanentlyConquered.has(geo)` so the client tracks dead natives.
- `_onCountryConquered(geoId)` (v95m, no `survives` arg): hands the dead country's
  non-homeland pixels + outpost flags to a living alliance partner, else CLEARS
  them → those outposts become neutral "Fallen" zones.

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
- **v96: encircle is ADDITIVE on top; cap 10×.** `getRegenMult()` =
  `min(10, max(David world-share, rank, rally/highlight, 1) + encircleAdd)` where
  `encircleAdd` = the encircle multiplier (3–6, see below) when active, else 0. So
  the largest PASSIVE bonus and the encircle bonus combine: e.g. country bonus 1.5×
  + 3× encircle = 4.5×. Encircle tiers raised to **3/4/5/6×** (`getEncircleBonus`:
  50/150/300/500 px). Bot regen mirrors this: `min(10, david + encircleAdd)`.
- **v95h (still holds for the PASSIVE sources):** David/rank/highlight do NOT stack
  with each other — the largest single one applies (they used to multiply into
  runaway regen). v96 only changed how ENCIRCLE combines (max→additive) + the cap
  (8→10). `getMyMultiplier()` (david×enc) remains vestigial; regen + the david-badge
  HUD use `getRegenMult()`. David mult auto-updates per country; rank persists.
- v93y: bonuses **reset on country change** (`_resetBonusesForCountryChange()`
  on `selectCountry`/re-pick: clears encircle + `clearHighlight`).
- v93y: encircle bonus **only ratchets UP** — a smaller new encirclement keeps
  the active higher multiplier and extends the timer (no downgrade).

### Remaining backlog
- [ ] **Ads (NEXT — only open item):** network, banner-only placement, consent
  banner, real domain.
- [x] **FTUE — guided first paint (v95):** done. See section below. Further FTUE
  ideas not built: HUD coach marks, first-session objectives, contextual nudges.
- [x] **(2b) Cascade death — OBSOLETE (v95m):** moot now that a homeland fall is
  always death + empire liquidation (no landless rebel can exist).
- [x] **Map-data arc spikes — RESOLVED:** the visible stripes were the v95b
  finisherFill overlay bug (fixed); the mask itself is clean (a degenerate arc
  fills 0px under evenodd). v95u also hardened `isBoundingArc` to reject diagonal
  degenerate arcs (verified: no real country loses pixels).
- [x] **Live-conquest queue hardening (v95u):** `enqueuePaintsSweep` paints a
  large flood (>8000px) instantly instead of staggering it through `_paintQ`.
- [x] **i18n conquest threshold (v95t):** all locales updated 60%→70%.
- [x] **Dead own-stroke layer removed (v95t).**

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
