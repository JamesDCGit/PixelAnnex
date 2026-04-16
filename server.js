/**
 * PixelWorld — Multiplayer WebSocket Server
 * ==========================================
 * Run:  npm install && node server.js
 * Env:  PORT=8080 (default)
 *       REDIS_URL=redis://localhost:6379 (optional, falls back to in-memory)
 *
 * Message protocol (all JSON over WebSocket):
 *
 * CLIENT → SERVER
 *   { type:'join',    countryId:string }              — pick a country to play as
 *   { type:'stroke',  pixels:[{x,y}], countryId }     — paint pixels
 *   { type:'fill',    pixels:[{x,y}], countryId }     — auto-fill result
 *   { type:'bomb',    cx,cy,radius,  countryId }      — bomb detonation
 *   { type:'ping' }                                   — keepalive
 *
 * SERVER → CLIENT
 *   { type:'welcome', playerId, state }               — full map state on connect
 *   { type:'delta',   pixels:[{x,y,owner}] }          — pixel changes from any player
 *   { type:'conquest',geoIdx,claimerCountryId }       — country conquered
 *   { type:'reversal',geoIdx,claimerCountryId }       — conquest reversed
 *   { type:'players', list:[{id,countryId,pixels}] }  — player list update
 *   { type:'pong' }
 *   { type:'error',  message }
 */

'use strict';

const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');

const PORT       = parseInt(process.env.PORT || '8080', 10);
const MAP_W      = 4096;
const MAP_H      = 2048;
const MAP_PX     = MAP_W * MAP_H;
const CONQUEST_THRESHOLD = 0.8;
const MAX_STROKE_PX      = 500;   // max pixels per stroke message
const MAX_FILL_PX        = 500000;
const BROADCAST_DEBOUNCE = 50;    // ms — batch broadcasts
const PLAYER_TIMEOUT     = 30000; // ms — drop idle clients

// ── In-memory state ────────────────────────────────────────────────
// claimByPixel: Int16Array — index into connected player's countryId
//   -1 = unclaimed, 0+ = country index
// We use countryId strings (ISO numeric) as the identity key.
const claimByPixel  = new Int16Array(MAP_PX).fill(-1);

// geoClaimCnt[geoIdx][countryId] = pixel count
const geoClaimCnt   = {};

// geoTotal[geoIdx] = total land pixels (loaded from map data)
// This gets populated when the first client sends their geoTotal snapshot.
// In production you'd pre-compute this server-side from the TopoJSON.
const geoTotal      = {};

// conqueredSet: Set of "geoIdx:countryId"
const conqueredSet  = new Set();

// countryPixelCount[countryId] = total pixels owned
const countryPixelCount = {};

// countryIdToIndex — maps ISO string to a stable short integer for the typed array
const countryIdToIndex = new Map();  // "840" → 0
const indexToCountryId = [];         // 0 → "840"

function getOrCreateIndex(countryId) {
  if (countryIdToIndex.has(countryId)) return countryIdToIndex.get(countryId);
  const idx = indexToCountryId.length;
  countryIdToIndex.set(countryId, idx);
  indexToCountryId.push(countryId);
  return idx;
}

// ── Player tracking ────────────────────────────────────────────────
let nextPlayerId = 1;
const players = new Map(); // playerId → { ws, countryId, countryIdx, lastSeen }

// ── Broadcast helpers ──────────────────────────────────────────────
let pendingDelta = [];   // pixels queued for broadcast
let broadcastTimer = null;

function queueDelta(pixels) {
  pendingDelta.push(...pixels);
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(flushDelta, BROADCAST_DEBOUNCE);
  }
}

function flushDelta() {
  broadcastTimer = null;
  if (pendingDelta.length === 0) return;
  const msg = JSON.stringify({ type: 'delta', pixels: pendingDelta });
  pendingDelta = [];
  broadcast(msg);
}

function broadcast(msg, excludeId = null) {
  for (const [id, p] of players) {
    if (id === excludeId) continue;
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

function broadcastPlayers() {
  const list = [];
  for (const [id, p] of players) {
    list.push({ id, countryId: p.countryId, pixels: countryPixelCount[p.countryId] || 0 });
  }
  broadcast(JSON.stringify({ type: 'players', list }));
}

// ── Full state snapshot (sent to new joiners) ──────────────────────
// Compresses claimByPixel to runs: [{start, len, owner}] (owner = countryId string)
function buildStateSnapshot() {
  const runs = [];
  let runStart = -1, runOwner = -1;
  for (let i = 0; i <= MAP_PX; i++) {
    const owner = i < MAP_PX ? claimByPixel[i] : -99;
    if (owner !== runOwner) {
      if (runOwner >= 0 && runStart >= 0) {
        runs.push({ s: runStart, l: i - runStart, o: indexToCountryId[runOwner] });
      }
      runStart = i;
      runOwner = owner;
    }
  }
  return {
    runs,           // RLE-compressed pixel ownership
    conquered: [...conqueredSet],
    players: [...players.values()].map(p => ({
      countryId: p.countryId,
      pixels: countryPixelCount[p.countryId] || 0,
    })),
  };
}

// ── Core game logic ────────────────────────────────────────────────
function applyPixels(pixels, countryId) {
  // Returns { changed: [{x,y,owner}], conquests: [], reversals: [] }
  const countryIdx = getOrCreateIndex(countryId);
  const changed    = [];
  const affectedGeos = new Set();

  for (const { x, y } of pixels) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) continue;
    const i = y * MAP_W + x;
    const prev = claimByPixel[i];
    if (prev === countryIdx) continue;  // already owned

    // Decrement previous owner
    if (prev >= 0) {
      const prevId = indexToCountryId[prev];
      countryPixelCount[prevId] = Math.max(0, (countryPixelCount[prevId] || 1) - 1);
      // Update geo counts
      const geo = getGeoAtPixel(i);
      if (geo >= 0 && geoClaimCnt[geo]) {
        geoClaimCnt[geo][prevId] = Math.max(0, (geoClaimCnt[geo][prevId] || 1) - 1);
      }
    }

    claimByPixel[i] = countryIdx;
    countryPixelCount[countryId] = (countryPixelCount[countryId] || 0) + 1;

    const geo = getGeoAtPixel(i);
    if (geo >= 0) {
      if (!geoClaimCnt[geo]) geoClaimCnt[geo] = {};
      geoClaimCnt[geo][countryId] = (geoClaimCnt[geo][countryId] || 0) + 1;
      affectedGeos.add(geo);
    }

    changed.push({ x, y, owner: countryId });
  }

  // Check conquests and reversals
  const conquests = [], reversals = [];
  for (const geo of affectedGeos) {
    const total = geoTotal[geo];
    if (!total) continue;

    // Check conquest
    const owned = (geoClaimCnt[geo] && geoClaimCnt[geo][countryId]) || 0;
    const key   = `${geo}:${countryId}`;
    if (!conqueredSet.has(key) && owned / total >= CONQUEST_THRESHOLD) {
      conqueredSet.add(key);
      conquests.push({ geoIdx: geo, countryId });

      // Finisher fill — claim remaining pixels of this geo for countryId
      const fillResult = finisherFill(geo, countryId);
      changed.push(...fillResult);
    }

    // Check conquest reversals for other countries
    for (const [cId, cnt] of Object.entries(geoClaimCnt[geo] || {})) {
      const rKey = `${geo}:${cId}`;
      if (cId !== countryId && conqueredSet.has(rKey)) {
        const rOwned = cnt || 0;
        if (total > 0 && rOwned / total < CONQUEST_THRESHOLD) {
          conqueredSet.delete(rKey);
          reversals.push({ geoIdx: geo, countryId: cId });
        }
      }
    }
  }

  return { changed, conquests, reversals };
}

function finisherFill(geoIdx, countryId) {
  const countryIdx = getOrCreateIndex(countryId);
  const filled = [];
  // We need a way to iterate pixels of a geo country.
  // For now we iterate all pixels (slow but correct for a first version).
  // In production, pre-build a geoPixels[geoIdx] index.
  for (let i = 0; i < MAP_PX; i++) {
    if (getGeoAtPixel(i) !== geoIdx) continue;
    if (claimByPixel[i] === countryIdx) continue;
    const prev = claimByPixel[i];
    if (prev >= 0) {
      const prevId = indexToCountryId[prev];
      countryPixelCount[prevId] = Math.max(0, (countryPixelCount[prevId] || 1) - 1);
      if (geoClaimCnt[geoIdx] && geoClaimCnt[geoIdx][prevId]) {
        geoClaimCnt[geoIdx][prevId] = Math.max(0, (geoClaimCnt[geoIdx][prevId] || 1) - 1);
      }
    }
    claimByPixel[i] = countryIdx;
    countryPixelCount[countryId] = (countryPixelCount[countryId] || 0) + 1;
    if (!geoClaimCnt[geoIdx]) geoClaimCnt[geoIdx] = {};
    geoClaimCnt[geoIdx][countryId] = (geoClaimCnt[geoIdx][countryId] || 0) + 1;
    const x = i % MAP_W, y = (i / MAP_W) | 0;
    filled.push({ x, y, owner: countryId });
  }
  return filled;
}

function applyBomb(cx, cy, radius, countryId) {
  // Clear all pixels within radius — no owner on cleared pixels
  const r2 = radius * radius;
  const cleared = [];
  const x0 = Math.max(0, cx - radius), x1 = Math.min(MAP_W - 1, cx + radius);
  const y0 = Math.max(0, cy - radius), y1 = Math.min(MAP_H - 1, cy + radius);
  const affectedGeos = new Set();

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      const i = y * MAP_W + x;
      const prev = claimByPixel[i];
      if (prev < 0) continue;
      const prevId = indexToCountryId[prev];
      countryPixelCount[prevId] = Math.max(0, (countryPixelCount[prevId] || 1) - 1);
      const geo = getGeoAtPixel(i);
      if (geo >= 0 && geoClaimCnt[geo] && geoClaimCnt[geo][prevId]) {
        geoClaimCnt[geo][prevId] = Math.max(0, (geoClaimCnt[geo][prevId] || 1) - 1);
        affectedGeos.add(geo);
      }
      claimByPixel[i] = -1;
      cleared.push({ x, y, owner: null });
    }
  }

  // Check reversals
  const reversals = [];
  for (const geo of affectedGeos) {
    for (const [cId] of Object.entries(geoClaimCnt[geo] || {})) {
      const rKey = `${geo}:${cId}`;
      if (conqueredSet.has(rKey)) {
        const owned = (geoClaimCnt[geo][cId] || 0);
        const total = geoTotal[geo] || 0;
        if (total > 0 && owned / total < CONQUEST_THRESHOLD) {
          conqueredSet.delete(rKey);
          reversals.push({ geoIdx: geo, countryId: cId });
        }
      }
    }
  }

  return { cleared, reversals };
}

// geoAtPixel — populated when clients send map data or pre-loaded
const geoAtPixel = new Int16Array(MAP_PX).fill(-1);
function getGeoAtPixel(i) { return geoAtPixel[i]; }

// ── HTTP + WebSocket server ────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Serve the game HTML at /
  if (req.url === '/' || req.url === '/index.html') {
    const clientPath = path.join(__dirname, 'pixelworld_mp.html');
    if (fs.existsSync(clientPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(clientPath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('pixelworld_mp.html not found — copy it to this directory');
    }
    return;
  }
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      players: players.size,
      conquered: conqueredSet.size,
      uptime: process.uptime(),
    }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024 }); // 1MB max message

wss.on('connection', (ws, req) => {
  const playerId = nextPlayerId++;
  const ip = req.socket.remoteAddress;
  console.log(`[+] Player ${playerId} connected from ${ip}`);

  let player = { ws, countryId: null, countryIdx: -1, lastSeen: Date.now() };
  players.set(playerId, player);

  // Keepalive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    if (Date.now() - player.lastSeen > PLAYER_TIMEOUT) {
      console.log(`[-] Player ${playerId} timed out`);
      ws.terminate();
    }
  }, 10000);

  ws.on('pong', () => { player.lastSeen = Date.now(); });

  ws.on('message', (raw) => {
    player.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    switch (msg.type) {

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'join': {
        if (!msg.countryId) return;
        player.countryId  = String(msg.countryId);
        player.countryIdx = getOrCreateIndex(player.countryId);
        console.log(`  Player ${playerId} joined as country ${player.countryId}`);

        // Accept geoTotal snapshot from first client (bootstraps server)
        if (msg.geoTotal && Object.keys(geoTotal).length === 0) {
          Object.assign(geoTotal, msg.geoTotal);
          console.log(`  Received geoTotal from client: ${Object.keys(geoTotal).length} countries`);
        }
        // Accept geoAtPixel snapshot (compressed as RLE)
        if (msg.geoPixelRuns && geoAtPixel.every(v => v === -1)) {
          applyGeoPixelRuns(msg.geoPixelRuns);
          console.log('  Received geoAtPixel from client');
        }

        // Send full state to new player
        ws.send(JSON.stringify({
          type: 'welcome',
          playerId,
          state: buildStateSnapshot(),
        }));

        broadcastPlayers();
        break;
      }

      case 'stroke': {
        if (!player.countryId) return;
        if (!Array.isArray(msg.pixels) || msg.pixels.length > MAX_STROKE_PX) return;

        const { changed, conquests, reversals } = applyPixels(msg.pixels, player.countryId);

        if (changed.length > 0) queueDelta(changed);
        if (conquests.length > 0) {
          for (const c of conquests) {
            broadcast(JSON.stringify({ type: 'conquest', ...c }));
          }
        }
        if (reversals.length > 0) {
          for (const r of reversals) {
            broadcast(JSON.stringify({ type: 'reversal', ...r }));
          }
        }
        break;
      }

      case 'fill': {
        // Client sends the filled pixels after auto-fill completes
        if (!player.countryId) return;
        if (!Array.isArray(msg.pixels) || msg.pixels.length > MAX_FILL_PX) return;
        const { changed, conquests, reversals } = applyPixels(msg.pixels, player.countryId);
        if (changed.length > 0) queueDelta(changed);
        conquests.forEach(c => broadcast(JSON.stringify({ type: 'conquest', ...c })));
        reversals.forEach(r => broadcast(JSON.stringify({ type: 'reversal', ...r })));
        break;
      }

      case 'bomb': {
        if (!player.countryId) return;
        const { cx, cy, radius } = msg;
        if (typeof cx !== 'number' || typeof cy !== 'number' || typeof radius !== 'number') return;
        if (radius > 50) return; // sanity cap
        const { cleared, reversals } = applyBomb(cx, cy, radius, player.countryId);
        if (cleared.length > 0) queueDelta(cleared);
        reversals.forEach(r => broadcast(JSON.stringify({ type: 'reversal', ...r })));
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    players.delete(playerId);
    console.log(`[-] Player ${playerId} disconnected (${players.size} remaining)`);
    broadcastPlayers();
  });

  ws.on('error', (err) => {
    console.error(`  Player ${playerId} error:`, err.message);
  });
});

function applyGeoPixelRuns(runs) {
  for (const { s, l, g } of runs) {
    for (let i = s; i < s + l; i++) {
      if (i < MAP_PX) geoAtPixel[i] = g;
    }
  }
}

server.listen(PORT, () => {
  console.log(`\n🌍 PixelWorld server running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   Players:   ${players.size}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  wss.clients.forEach(c => c.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
});
