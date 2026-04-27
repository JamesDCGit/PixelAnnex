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
const BOT_TICK_MS         = 1200;  // ms between bot ticks (staggered)
const BOT_PIXELS_PER_TICK  = 2;    // pixels per stroke per bot
const BOT_BUCKET_MAX       = 100;
const BOT_REGEN_MS         = 1500; // bucket regen interval
// All countries get bots — populated dynamically from map data


// ── Discord OAuth ─────────────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const DISCORD_GUILD_ID      = process.env.DISCORD_GUILD_ID || '';
const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN || '';

// In-memory session store: token → { discordId, username, avatar, expires }
// In production, replace with Redis or persistent DB
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Player profiles by discord_id (persists across sessions)
const profiles = new Map();
// profile = { discordId, username, avatar, countryMain, countryB, countryC, rank, xp, joinedAt }

function generateToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

function getProfile(discordId) {
  if (!profiles.has(discordId)) {
    profiles.set(discordId, {
      discordId,
      username: null,
      avatar: null,
      countryMain: null,
      countryB: null,
      countryC: null,
      rank: 'Soldier',
      xp: 0,
      joinedAt: Date.now(),
    });
  }
  return profiles.get(discordId);
}

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

    updateOwnerIndex(i, prev, cidx);
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
// Uses pre-built pixel indices for O(1) target lookup instead of O(MAP_PX) scans.
// Supports one bot per country (~220 bots) efficiently on a single CPU.

const bots = new Map(); // countryId → { countryId, bucket, geoIdx, frontierIdx }

// Pre-built indices (populated once map data arrives):
// geoPixels[geoIdx]     = Int32Array of pixel offsets belonging to this geo country
// ownerFrontier[cidx]   = Set of pixel offsets on the frontier (neighbour ≠ owner)
// These are maintained incrementally as pixels change.

const geoPixels    = {};  // geoIdx → Int32Array (built once)
const ownerPixels  = {};  // countryIdx → Set<pixelOffset> (maintained live)

function getGeoForCountry(countryId) {
  return parseInt(countryId, 10);
}

// Build geoPixels index once after map data is received
function buildGeoIndex() {
  console.log('[Bot] Building geo pixel index...');
  const temp = {};
  for (let i = 0; i < MAP_PX; i++) {
    const g = geoAtPixel[i];
    if (g < 0 || !landMask[i]) continue;
    if (!temp[g]) temp[g] = [];
    temp[g].push(i);
  }
  for (const [g, arr] of Object.entries(temp)) {
    geoPixels[+g] = new Int32Array(arr);
  }
  console.log(`[Bot] Geo index built: ${Object.keys(geoPixels).length} countries`);
}

// Get random frontier pixels for a bot (pixels adjacent to non-owned land)
const DX4 = [-1,1,0,0], DY4 = [0,0,-1,1];
function getBotTargets(countryId, limit) {
  const cidx   = getIdx(countryId);
  const geoIdx = getGeoForCountry(countryId);
  const pixels = geoPixels[geoIdx];
  if (!pixels || pixels.length === 0) return [];

  // Separate into: enemy-held (defend first) and unclaimed/expandable
  const defend = [], expand = [];
  // Sample up to 200 random pixels from the geo to find targets quickly
  const sampleSize = Math.min(200, pixels.length);
  const step = Math.max(1, Math.floor(pixels.length / sampleSize));

  for (let s = 0; s < pixels.length && defend.length + expand.length < limit * 8; s += step) {
    const i = pixels[s];
    const owner = claimByPixel[i];
    if (owner === cidx) continue; // already ours

    // Check if this pixel is reachable (adjacent to own pixel)
    const x = i % MAP_W, y = (i / MAP_W) | 0;
    let adjacent = false;
    for (let d = 0; d < 4; d++) {
      const nx = x+DX4[d], ny = y+DY4[d];
      if (nx<0||nx>=MAP_W||ny<0||ny>=MAP_H) continue;
      if (claimByPixel[ny*MAP_W+nx] === cidx) { adjacent = true; break; }
    }
    if (!adjacent && owner !== cidx) {
      // Also include pixels anywhere in geo if we have no territory yet
      if ((ownerPixels[cidx]?.size || 0) > 0) continue;
    }

    if (owner > 0 && owner !== cidx) defend.push({x,y});
    else expand.push({x,y});
  }

  // Prioritise defending, then expanding
  const pool = defend.length > 0 ? defend : expand;
  // Shuffle
  for (let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  return pool.slice(0, limit);
}

function botInit(countryId) {
  const bot = { countryId, bucket: BOT_BUCKET_MAX, geoIdx: getGeoForCountry(countryId) };
  bots.set(countryId, bot);
  players.set(nextPid++, { ws: null, countryId, countryIdx: getIdx(countryId), lastSeen: Date.now(), isBot: true });
  ownerPixels[getIdx(countryId)] = new Set();
  countryPxCount[countryId] = countryPxCount[countryId] || 0;
}

// Stagger bot ticks so they don't all fire simultaneously
function startBotTickers() {
  let i = 0;
  for (const [countryId] of bots) {
    const delay = (i % 20) * (BOT_TICK_MS / 20); // spread across tick window
    setTimeout(function tick() {
      botTickSingle(countryId);
      setTimeout(tick, BOT_TICK_MS);
    }, delay);
    i++;
  }
  console.log(`[Bot] ${bots.size} bot tickers started (staggered)`);
}

function botTickSingle(countryId) {
  if (!mapReady) return;
  const bot = bots.get(countryId);
  if (!bot || bot.bucket < BOT_PIXELS_PER_TICK) return;

  const targets = getBotTargets(countryId, BOT_PIXELS_PER_TICK);
  if (targets.length === 0) return;

  bot.bucket -= Math.min(BOT_PIXELS_PER_TICK, targets.length);
  const { changed, conquests, reversals } = applyPixels(targets, countryId);
  if (changed.length) queueDelta(changed);
  conquests.forEach(c => broadcast(JSON.stringify({ type:'conquest', ...c })));
  reversals.forEach(r => broadcast(JSON.stringify({ type:'reversal', ...r })));
}

// Keep ownerPixels in sync with claimByPixel changes
function updateOwnerIndex(pixelOffset, oldCidx, newCidx) {
  if (oldCidx >= 0 && ownerPixels[oldCidx]) ownerPixels[oldCidx].delete(pixelOffset);
  if (newCidx >= 0) {
    if (!ownerPixels[newCidx]) ownerPixels[newCidx] = new Set();
    ownerPixels[newCidx].add(pixelOffset);
  }
}

// Regen bot buckets — staggered to avoid GC spikes
setInterval(() => {
  for (const bot of bots.values()) {
    if (bot.bucket < BOT_BUCKET_MAX) bot.bucket++;
  }
}, BOT_REGEN_MS);

// ── Map readiness ─────────────────────────────────────────────────
let mapReady = false;
let geoPixelReady = false;

function checkMapReady() {
  if (geoPixelReady && Object.keys(geoTotal).length > 0) {
    mapReady = true;
    console.log('[Map] Ready — building index and initialising bots');
    buildGeoIndex();
    // Spawn a bot for every country that has land pixels
    for (const geoIdx of Object.keys(geoPixels)) {
      const countryId = String(geoIdx);
      if (!bots.has(countryId)) botInit(countryId);
    }
    console.log(`[Bot] Spawned ${bots.size} bots (one per country)`);
    broadcastPlayers();
    startBotTickers();
  }
}

// ── WebSocket server ──────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── Static game file ────────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const f = path.join(__dirname, 'pixelworld_v5.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(f).pipe(res);
    } else {
      res.writeHead(404); res.end('pixelworld_v5.html not found');
    }
    return;
  }

  // ── Health endpoint ─────────────────────────────────────────────
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      players:  players.size,
      bots:     bots.size,
      profiles: profiles.size,
      sessions: sessions.size,
      mapReady,
      uptime:   process.uptime(),
    }));
    return;
  }

  // ── /auth/login → redirect to Discord OAuth ─────────────────────
  if (url.pathname === '/auth/login') {
    if (!DISCORD_CLIENT_ID) {
      res.writeHead(500); res.end('Discord OAuth not configured (set DISCORD_CLIENT_ID env var)');
      return;
    }
    const state = generateToken().slice(0, 16);
    const params = new URLSearchParams({
      client_id:     DISCORD_CLIENT_ID,
      redirect_uri:  DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope:         'identify guilds guilds.members.read',
      state,
    });
    res.writeHead(302, { Location: 'https://discord.com/api/oauth2/authorize?' + params });
    res.end();
    return;
  }

  // ── /auth/callback → exchange code for token, fetch user, create session ──
  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400); res.end('Missing code'); return; }

    try {
      // Exchange code for access token
      const tokRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type:    'authorization_code',
          code,
          redirect_uri:  DISCORD_REDIRECT_URI,
        }),
      });
      const tokData = await tokRes.json();
      if (!tokData.access_token) {
        console.error('[OAuth] Token exchange failed:', tokData);
        res.writeHead(400); res.end('OAuth token exchange failed');
        return;
      }

      // Fetch user profile
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + tokData.access_token },
      });
      const user = await userRes.json();
      if (!user.id) {
        console.error('[OAuth] User fetch failed:', user);
        res.writeHead(400); res.end('Failed to fetch user');
        return;
      }

      // Optional: verify user is in the PixelAnnex guild
      let inGuild = true;
      if (DISCORD_GUILD_ID) {
        const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
          headers: { Authorization: 'Bearer ' + tokData.access_token },
        });
        const guilds = await guildsRes.json();
        inGuild = Array.isArray(guilds) && guilds.some(g => g.id === DISCORD_GUILD_ID);
      }

      // Create profile + session
      const profile = getProfile(user.id);
      profile.username = user.username + (user.discriminator && user.discriminator !== '0' ? '#' + user.discriminator : '');
      profile.avatar   = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
        : null;
      profile.inGuild  = inGuild;

      const token = generateToken();
      sessions.set(token, {
        discordId: user.id,
        username:  profile.username,
        avatar:    profile.avatar,
        expires:   Date.now() + SESSION_TTL_MS,
      });

      console.log(`[OAuth] ${profile.username} (${user.id}) logged in. In guild: ${inGuild}`);

      // Redirect back to game with session token in cookie + URL param
      res.writeHead(302, {
        'Set-Cookie': `pa_session=${token}; Path=/; Max-Age=${SESSION_TTL_MS/1000}; SameSite=Lax`,
        Location: '/?login=success',
      });
      res.end();
      return;

    } catch (err) {
      console.error('[OAuth] Callback error:', err);
      res.writeHead(500); res.end('OAuth error');
      return;
    }
  }

  // ── /auth/me → return current user profile (used by client) ────
  if (url.pathname === '/auth/me') {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/pa_session=([a-f0-9]+)/);
    const token = m ? m[1] : null;
    const session = token ? getSession(token) : null;
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ loggedIn: false }));
      return;
    }
    const profile = getProfile(session.discordId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      loggedIn:   true,
      discordId:  profile.discordId,
      username:   profile.username,
      avatar:     profile.avatar,
      countryMain:profile.countryMain,
      countryB:   profile.countryB,
      countryC:   profile.countryC,
      rank:       profile.rank,
      xp:         profile.xp,
      inGuild:    profile.inGuild,
    }));
    return;
  }

  // ── /auth/logout → clear session ───────────────────────────────
  if (url.pathname === '/auth/logout') {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/pa_session=([a-f0-9]+)/);
    if (m) sessions.delete(m[1]);
    res.writeHead(302, {
      'Set-Cookie': 'pa_session=; Path=/; Max-Age=0',
      Location: '/',
    });
    res.end();
    return;
  }

  res.writeHead(404); res.end('Not found');
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
  console.log(`   Bots:      one per country (start after first client connects)\n`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down…');
  wss.clients.forEach(c => c.close(1001, 'Server shutting down'));
  httpServer.close(() => process.exit(0));
});
