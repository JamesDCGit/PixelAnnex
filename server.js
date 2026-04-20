/**
 * PixelAnnex — Multiplayer WebSocket Server
 * ==========================================
 * Run:  npm install && node server.js
 * Env:  PORT=3000 (default)
 *
 * Protocol (JSON over WebSocket):
 *
 * CLIENT → SERVER
 *   { type:'join',       countryId, geoTotal?, geoPixelRuns? }
 *   { type:'stroke',     pixels:[{x,y}] }
 *   { type:'bomb',       cx, cy, radius }
 *   { type:'ping' }
 *
 * SERVER → CLIENT
 *   { type:'welcome',    playerId, botIds:[], state:{runs,conquered,players} }
 *   { type:'delta',      pixels:[{x,y,owner}] }
 *   { type:'conquest',   geoIdx, countryId }
 *   { type:'reversal',   geoIdx, countryId }
 *   { type:'players',    list:[{id,countryId,pixels,isBot}] }
 *   { type:'pong' }
 */

'use strict';

const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

// ── Config ────────────────────────────────────────────────────────
const PORT               = parseInt(process.env.PORT || '3000', 10);
const MAP_W              = 4096;
const MAP_H              = 2048;
const MAP_PX             = MAP_W * MAP_H;
const CONQUEST_THRESHOLD = 0.80;
const MAX_STROKE_PX      = 500;
const BROADCAST_MS       = 50;    // delta broadcast debounce
const PING_MS            = 10000;
const TIMEOUT_MS         = 30000;

// ── Bot config ────────────────────────────────────────────────────
const BOT_COUNT          = 8;     // number of bot players
const BOT_TICK_MS        = 800;   // ms between bot paint strokes
const BOT_PIXELS_PER_TICK = 3;    // pixels per stroke
const BOT_BUCKET_MAX     = 100;
const BOT_REGEN_MS       = 1000;  // bucket regen interval

// Bot country assignments — use major countries for visible AI presence
const BOT_COUNTRIES = ['840','156','643','356','76','826','276','250'];

// ── Map state ─────────────────────────────────────────────────────
const claimByPixel = new Int16Array(MAP_PX).fill(-1);
const geoAtPixel   = new Int16Array(MAP_PX).fill(-1);
const landMask     = new Uint8Array(MAP_PX).fill(0);
const geoClaimCnt  = {};   // geoIdx → { countryId → count }
const geoTotal     = {};   // geoIdx → total land pixels
const conqueredSet = new Set();
const countryPxCount = {}; // countryId → pixel count

// ── Country index mapping ─────────────────────────────────────────
const idToIdx = new Map();
const idxToId = [];
function getIdx(countryId) {
  if (idToIdx.has(countryId)) return idToIdx.get(countryId);
  const idx = idxToId.length;
  idToIdx.set(countryId, idx);
  idxToId.push(countryId);
  return idx;
}

// ── Players ───────────────────────────────────────────────────────
let nextPid = 1;
const players = new Map(); // pid → { ws, countryId, countryIdx, lastSeen, isBot }

// ── Broadcast ─────────────────────────────────────────────────────
let pendingDelta = [];
let deltaTimer   = null;

function queueDelta(pixels) {
  pendingDelta.push(...pixels);
  if (!deltaTimer) deltaTimer = setTimeout(flushDelta, BROADCAST_MS);
}

function flushDelta() {
  deltaTimer = null;
  if (!pendingDelta.length) return;
  const msg = JSON.stringify({ type: 'delta', pixels: pendingDelta });
  pendingDelta = [];
  broadcast(msg);
}

function broadcast(msg, excludePid = -1) {
  for (const [pid, p] of players) {
    if (pid === excludePid || p.isBot) continue;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function broadcastPlayers() {
  const list = [];
  for (const [pid, p] of players) {
    list.push({ id: pid, countryId: p.countryId, pixels: countryPxCount[p.countryId] || 0, isBot: !!p.isBot });
  }
  broadcast(JSON.stringify({ type: 'players', list }));
}

// ── State snapshot (RLE compressed) ──────────────────────────────
function buildSnapshot() {
  const runs = [];
  let rs = -1, ro = -99;
  for (let i = 0; i <= MAP_PX; i++) {
    const o = i < MAP_PX ? claimByPixel[i] : -999;
    if (o !== ro) {
      if (ro >= 0 && rs >= 0) runs.push({ s: rs, l: i - rs, o: idxToId[ro] });
      rs = i; ro = o;
    }
  }
  return {
    runs,
    conquered: [...conqueredSet],
    players: [...players.values()].map(p => ({
      countryId: p.countryId,
      pixels: countryPxCount[p.countryId] || 0,
      isBot: !!p.isBot,
    })),
  };
}

// ── Core pixel logic ──────────────────────────────────────────────
function applyPixels(pixels, countryId) {
  const cidx     = getIdx(countryId);
  const changed  = [];
  const affected = new Set();

  for (const { x, y } of pixels) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) continue;
    const i = y * MAP_W + x;
    if (!landMask[i]) continue;
    const prev = claimByPixel[i];
    if (prev === cidx) continue;

    if (prev >= 0) {
      const prevId = idxToId[prev];
      countryPxCount[prevId] = Math.max(0, (countryPxCount[prevId] || 1) - 1);
      const geo = geoAtPixel[i];
      if (geo >= 0 && geoClaimCnt[geo]?.[prevId]) {
        geoClaimCnt[geo][prevId] = Math.max(0, geoClaimCnt[geo][prevId] - 1);
        affected.add(geo);
      }
    }

    claimByPixel[i] = cidx;
    countryPxCount[countryId] = (countryPxCount[countryId] || 0) + 1;
    const geo = geoAtPixel[i];
    if (geo >= 0) {
      geoClaimCnt[geo] ??= {};
      geoClaimCnt[geo][countryId] = (geoClaimCnt[geo][countryId] || 0) + 1;
      affected.add(geo);
    }
    changed.push({ x, y, owner: countryId });
  }

  const conquests = [], reversals = [];
  for (const geo of affected) {
    const total = geoTotal[geo] || 0;
    if (!total) continue;
    const owned = geoClaimCnt[geo]?.[countryId] || 0;
    const key   = geo + ':' + countryId;
    if (!conqueredSet.has(key) && owned / total >= CONQUEST_THRESHOLD) {
      conqueredSet.add(key);
      conquests.push({ geoIdx: geo, countryId });
      changed.push(...finisherFill(geo, countryId));
    }
    for (const [cId, cnt] of Object.entries(geoClaimCnt[geo] || {})) {
      const rk = geo + ':' + cId;
      if (cId !== countryId && conqueredSet.has(rk) && (cnt || 0) / total < CONQUEST_THRESHOLD) {
        conqueredSet.delete(rk);
        reversals.push({ geoIdx: geo, countryId: cId });
      }
    }
  }
  return { changed, conquests, reversals };
}

function finisherFill(geoIdx, countryId) {
  const cidx = getIdx(countryId);
  const filled = [];
  for (let i = 0; i < MAP_PX; i++) {
    if (geoAtPixel[i] !== geoIdx) continue;
    if (claimByPixel[i] === cidx) continue;
    const prev = claimByPixel[i];
    if (prev >= 0) {
      const pid = idxToId[prev];
      countryPxCount[pid] = Math.max(0, (countryPxCount[pid] || 1) - 1);
      if (geoClaimCnt[geoIdx]?.[pid]) geoClaimCnt[geoIdx][pid] = Math.max(0, geoClaimCnt[geoIdx][pid] - 1);
    }
    claimByPixel[i] = cidx;
    countryPxCount[countryId] = (countryPxCount[countryId] || 0) + 1;
    geoClaimCnt[geoIdx] ??= {};
    geoClaimCnt[geoIdx][countryId] = (geoClaimCnt[geoIdx][countryId] || 0) + 1;
    filled.push({ x: i % MAP_W, y: (i / MAP_W) | 0, owner: countryId });
  }
  return filled;
}

// ── Bot AI ────────────────────────────────────────────────────────
// Each bot: paints pixels near its existing territory, defends when attacked.
// Strategy: expand outward from owned pixels into unclaimed or enemy territory.

const bots = new Map(); // countryId → { countryId, bucket, geoIdx, pixels:Set }

function getGeoForCountry(countryId) {
  // Find the geoIdx that matches countryId (they're the same in our DB)
  return parseInt(countryId, 10);
}

function botInit(countryId) {
  const bot = {
    countryId,
    bucket: BOT_BUCKET_MAX,
    geoIdx: getGeoForCountry(countryId),
    pid: nextPid++,
  };
  bots.set(countryId, bot);
  players.set(bot.pid, { ws: null, countryId, countryIdx: getIdx(countryId), lastSeen: Date.now(), isBot: true });
  countryPxCount[countryId] = countryPxCount[countryId] || 0;
  console.log(`[Bot] Spawned ${countryId} as pid ${bot.pid}`);
}

// Find pixels on the frontier: own pixels adjacent to non-own
function getBotFrontier(countryId, limit) {
  const cidx  = getIdx(countryId);
  const front = [];
  const DX = [-1,1,0,0], DY = [0,0,-1,1];
  for (let i = 0; i < MAP_PX; i++) {
    if (claimByPixel[i] !== cidx) continue;
    const x = i % MAP_W, y = (i / MAP_W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x+DX[d], ny = y+DY[d];
      if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
      const ni = ny*MAP_W+nx;
      if (!landMask[ni]) continue;
      if (claimByPixel[ni] !== cidx) { front.push({x:nx,y:ny}); break; }
    }
    if (front.length >= limit*4) break;
  }
  // Shuffle and return limit
  for (let i=front.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[front[i],front[j]]=[front[j],front[i]];}
  return front.slice(0, limit);
}

// Find pixels inside own geo country held by enemies (defend/reclaim)
function getBotDefendTargets(countryId, limit) {
  const cidx = getIdx(countryId);
  const geoIdx = getGeoForCountry(countryId);
  const targets = [];
  for (let i = 0; i < MAP_PX; i++) {
    if (geoAtPixel[i] !== geoIdx) continue;
    if (claimByPixel[i] === cidx || claimByPixel[i] < 0) continue;
    targets.push({ x: i % MAP_W, y: (i / MAP_W) | 0 });
    if (targets.length >= limit*4) break;
  }
  for (let i=targets.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[targets[i],targets[j]]=[targets[j],targets[i]];}
  return targets.slice(0, limit);
}

function botTick() {
  if (!mapReady) return;
  for (const [countryId, bot] of bots) {
    if (bot.bucket < BOT_PIXELS_PER_TICK) continue;

    // Priority: defend own territory if under attack, else expand
    let targets = getBotDefendTargets(countryId, BOT_PIXELS_PER_TICK);
    if (targets.length < BOT_PIXELS_PER_TICK) {
      targets = targets.concat(getBotFrontier(countryId, BOT_PIXELS_PER_TICK - targets.length));
    }
    if (targets.length === 0) continue;

    bot.bucket -= Math.min(BOT_PIXELS_PER_TICK, targets.length);
    const { changed, conquests, reversals } = applyPixels(targets, countryId);
    if (changed.length) queueDelta(changed);
    conquests.forEach(c => broadcast(JSON.stringify({ type:'conquest', ...c })));
    reversals.forEach(r => broadcast(JSON.stringify({ type:'reversal', ...r })));
  }
}

// Regen bot buckets
setInterval(() => {
  for (const bot of bots.values()) {
    if (bot.bucket < BOT_BUCKET_MAX) bot.bucket++;
  }
}, BOT_REGEN_MS);

// Bot tick loop
setInterval(botTick, BOT_TICK_MS);

// ── Map readiness ─────────────────────────────────────────────────
let mapReady = false;
let geoPixelReady = false;

function checkMapReady() {
  if (geoPixelReady && Object.keys(geoTotal).length > 0) {
    mapReady = true;
    console.log('[Map] Ready — initialising bots');
    BOT_COUNTRIES.forEach(c => botInit(c));
    broadcastPlayers();
  }
}

// ── WebSocket server ──────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const f = path.join(__dirname, 'pixelworld_v5.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(f).pipe(res);
    } else {
      res.writeHead(404); res.end('pixelworld_v5.html not found');
    }
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ players: players.size, bots: bots.size, mapReady, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ server: httpServer, maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const pid = nextPid++;
  const ip  = req.socket.remoteAddress;
  console.log(`[+] Player ${pid} connected from ${ip}`);

  const player = { ws, countryId: null, countryIdx: -1, lastSeen: Date.now(), isBot: false };
  players.set(pid, player);

  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    if (Date.now() - player.lastSeen > TIMEOUT_MS) { console.log(`[-] Player ${pid} timed out`); ws.terminate(); }
  }, PING_MS);

  ws.on('pong', () => { player.lastSeen = Date.now(); });

  ws.on('message', raw => {
    player.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'join': {
        if (!msg.countryId) return;
        player.countryId  = String(msg.countryId);
        player.countryIdx = getIdx(player.countryId);
        console.log(`  Player ${pid} → country ${player.countryId}`);

        // Bootstrap map data from first client
        if (msg.geoTotal && !Object.keys(geoTotal).length) {
          Object.assign(geoTotal, msg.geoTotal);
          console.log(`  geoTotal: ${Object.keys(geoTotal).length} countries`);
        }
        if (msg.geoPixelRuns && !geoPixelReady) {
          for (const { s, l, g } of msg.geoPixelRuns) {
            for (let i = s; i < s + l && i < MAP_PX; i++) geoAtPixel[i] = g;
          }
          geoPixelReady = true;
          console.log('  geoAtPixel received');
        }
        if (msg.landRuns && !landMask.some(v => v)) {
          for (const { s, l } of msg.landRuns) {
            for (let i = s; i < s + l && i < MAP_PX; i++) landMask[i] = 1;
          }
          console.log('  landMask received');
        }
        checkMapReady();

        ws.send(JSON.stringify({
          type: 'welcome',
          playerId: pid,
          botIds: [...bots.keys()],
          state: buildSnapshot(),
        }));
        broadcastPlayers();
        break;
      }

      case 'stroke': {
        if (!player.countryId || !Array.isArray(msg.pixels)) return;
        if (msg.pixels.length > MAX_STROKE_PX) return;
        const { changed, conquests, reversals } = applyPixels(msg.pixels, player.countryId);
        if (changed.length) queueDelta(changed);
        conquests.forEach(c => broadcast(JSON.stringify({ type:'conquest',...c })));
        reversals.forEach(r => broadcast(JSON.stringify({ type:'reversal',...r })));
        break;
      }

      case 'bomb': {
        if (!player.countryId) return;
        const { cx, cy, radius } = msg;
        if (typeof cx!=='number'||typeof cy!=='number'||typeof radius!=='number') return;
        if (radius > 30) return;
        const r2 = radius*radius;
        const bombed = [];
        for (let dy=-radius;dy<=radius;dy++) for (let dx=-radius;dx<=radius;dx++) {
          if (dx*dx+dy*dy>r2) continue;
          bombed.push({ x: cx+dx, y: cy+dy });
        }
        const { changed, conquests, reversals } = applyPixels(bombed, player.countryId);
        if (changed.length) queueDelta(changed);
        conquests.forEach(c => broadcast(JSON.stringify({ type:'conquest',...c })));
        reversals.forEach(r => broadcast(JSON.stringify({ type:'reversal',...r })));
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(keepalive);
    players.delete(pid);
    console.log(`[-] Player ${pid} disconnected (${players.size - bots.size} real players)`);
    broadcastPlayers();
  });

  ws.on('error', err => console.error(`  Player ${pid} error:`, err.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n🌍 PixelAnnex server running`);
  console.log(`   HTTP:      http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   Bots:      ${BOT_COUNT} (start after first client connects)\n`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down…');
  wss.clients.forEach(c => c.close(1001, 'Server shutting down'));
  httpServer.close(() => process.exit(0));
});
