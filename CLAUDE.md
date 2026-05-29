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
- [ ] Per-region viewport delta filter — ~90% bandwidth cut for zoomed players
- [ ] Binary delta protocol (packed Uint16) — 4× smaller, no JSON.parse cost
- [ ] Server snapshot RLE → binary — faster initial connection
- [ ] **Alliance overhaul** (large, mostly Discord/bot.js) — underground-resistance progress bars, superpower event, faction threads, ping-the-general/strike, alliance vaults + daily surge, A/B/C reskin (Homeland/Coalition/Mercenary), 2-alliance onboarding. Design doc still owed.

## Screenshots for tweets (v88)

`mapshot.js` renders a 256×256 PNG of a country with a hand-rolled PNG
encoder (zlib only). `@napi-rs/canvas` was dropped — its 0.1.80 publish
declares `os:win32` and breaks `npm install` on the linux droplet, and a
native dep isn't worth it for a flat image with no text. Client sends
`geoColors` (id→hex) at join; server caches `geoColorsById`;
`makeCountryShot()` writes to `/shots/` (pruned to 60), served at
`/shots/{name}.png`. `makeNotableShot()` only renders when the event will
actually tweet (notable country). Conquest + multi-attack attach `imageUrl`.

## Droplet git hygiene

The droplet working tree accumulates runtime-written files (`tweet_queue.json`,
`countries-10m.json.gz`, `package-lock.json`, `ecosystem.config.js`). A stray
`git checkout -- package.json` may be needed before `git pull` if a deploy
ever modified a tracked file on the server. `deploy.ps1` does a plain `git
pull`; if it reports "Please commit your changes," SSH in and
`git checkout -- <file>` the offending tracked file, then re-deploy.

Path B (10k users) and Path C (millions) are documented in chat history but
not started.
