# PixelAnnex

A single-player browser-based territory claiming game. Paint pixels across a world map, conquer countries, defend your territory, and deploy bombs. No server required — runs entirely in one self-contained HTML file.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/yourname/pixelannex.git
cd pixelannex

# Open directly in browser (no build step)
open pixelworld_v5.html
```

Or serve locally for best performance:

```bash
npx serve .
# then open http://localhost:3000/pixelworld_v5.html
```

---

## Files

| File | Description |
|------|-------------|
| `pixelworld_v5.html` | Main game — single self-contained file (~205KB) |
| `server.js` | Multiplayer WebSocket server (Node.js, work in progress) |
| `package.json` | Server dependencies (ws, express) |

---

## Features

### Map & Rendering
- 4096×2048 equirectangular world map, 11 stacked canvases
- 220 countries and territories from Natural Earth / world-atlas TopoJSON
- Procedural biome colouring — gradient-blended zone system (~58 zones)
- Procedural ocean colouring — 26 named ocean zones
- Country borders with light/dark toggle
- Countries prepopulated with native colours on load

### Gameplay
- Pixel bucket inventory (100px max, +1/60s regen)
- Brush size 1–24px
- Country conquest at 80% ownership threshold — auto-fill BFS
- Conquest reversal when drops below threshold
- Rank system — Soldier → Lieutenant → Captain → General → Admiral (based on XP)

### Bombs (rank-gated)
| Bomb | Rank | Cost | Radius |
|------|------|------|--------|
| Mortar | Captain | 10px | 5px |
| MOAB | General | 50px | 12px |
| Nuke | Admiral | 100px | 25px |

- Bomb craters with pixel-art icons (mushroom cloud / missile / bomb), 10s fade
- No ocean bombing

### Combat Systems
- **Highlight / Attack mode** — General+: designate a country for 30s gold pulse
- **Fight-back power-up** — if >70% of your country is taken, painting inside it refunds +4px/stroke to bucket (5× net)
- **Siege flash** — countries >50% enemy-occupied pulse red while under active attack
- **Activity notifications** — "Under Attack" / "Fighting Back" toast with alert sound

### Audio (Web Audio API — no external files)
| Track | Style | BPM |
|-------|-------|-----|
| ♪1 | Chiptune (square/sawtooth/triangle arp) | 136 |
| ♪2 | Epic / Classical (strings with vibrato, brass, choir pad) | 72 |
| ♪3 | Military / Epic (war drums, deep brass ostinato, sub-bass) | 92 |

- Audio-clock-anchored looping (no drift under CPU load)
- Independent Music / SFX mute controls
- Under-attack siren alert sound
- Starts after map is fully rendered

### Flags
- 220 pixel-art flags (11×7px encoded, rendered via SVG DOM API)
- Shown in country picker dropdown and territory legend

### UI
- Country picker dropdown with search, flag, colour dot
- Territory legend — top 20 countries by pixel count
- Pixel bucket HUD with regen timer
- Rank display with XP progress
- Zoom + pan (mouse wheel / middle-click drag / right-click drag)
- Font scale — Normal (110%) / Mid (120%) / Large (130%)
- Scrollbars 6–8px width

---

## Architecture

```
pixelworld_v5.html
├── CSS                    (~400 lines)
├── HTML                   (~80 lines, 11 canvas layers)
└── JS                     (~3,600 lines)
    ├── Data: DB, FLAG_DATA            country + flag definitions
    ├── Map: topoFeatures()            TopoJSON decoder (no library)
    ├── Render: buildBaseCanvas()      biome/ocean paint
    ├── Render: reborderCanvas()       country borders
    ├── State: claimByPixel            Int16Array pixel ownership
    ├── State: featByPixel             Int16Array geographic country
    ├── State: landMask                Uint8Array ocean/land
    ├── Game: claimPixel()             pixel ownership transfer
    ├── Game: paintBrush()             brush stroke + bonuses
    ├── Game: detonateBomb()           bomb detonation + crater
    ├── Combat: checkConquest()        conquest detection + fill
    ├── Combat: isUnderSiege()         50% threshold check
    ├── Combat: getFightBackBonus()    fight-back 5x bucket bonus
    ├── Audio: scheduleMusicTrack()    chiptune track 1
    ├── Audio: scheduleMusicTrack2()   classical track 2
    ├── Audio: scheduleMusicTrack3()   military track 3
    └── UI: renderCselList()           country picker render
```

### Canvas Layer Stack (bottom to top)
```
c-base      biome/ocean background
c-waves     animated ocean waves
c-sprites   (reserved)
c-claim     painted pixel ownership colours
c-outline   1px white outline around player's own pixels
c-border    country borders
c-flags     conquest flags
c-highlight gold highlight pulse (attack mode)
c-siege     red pulse (under-attack flash)
c-overlay   bomb preview circle
c-crater    bomb crater gradient + pixel-art icon
```

---

## Roadmap

- [ ] Multiplayer — WebSocket server (server.js scaffolded)
- [ ] Bot players — server-side AI clients per country
- [ ] Discord OAuth — login with Discord identity
- [ ] Discord webhooks — conquest/leaderboard notifications to channel
- [ ] Persistent state — server-side pixel map storage
- [ ] Deploy — static frontend (Cloudflare Pages) + Node backend (Fly.io / Hetzner)

---

## Development Notes

**No build step.** All JS/CSS is inline in the HTML file. Edit `pixelworld_v5.html` directly.

**TopoJSON source:** `https://cdn.jsdelivr.net/npm/world-atlas@2/countries-10m.json` — fetched at runtime, no bundling needed.

**Audio:** All three music tracks and all SFX are generated procedurally via Web Audio API. No audio files.

**Flag data:** Each flag is a 77-character string of palette indices (11x7px grid) plus a colour palette array. Rendered via createElementNS SVG DOM API to avoid innerHTML parsing issues.

**Pixel IDs:** TopoJSON uses zero-padded 3-digit ISO numeric IDs (e.g. "050" for Bangladesh). The game normalises these with parseInt(id, 10) before lookup.

---

## License

Private / unreleased. Working title: **PixelAnnex**.
