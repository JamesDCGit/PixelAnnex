require('dotenv').config();
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
const SERVER_VERSION       = '2026-05-18-ios-crash-fix-v31';
console.log('PixelAnnex server', SERVER_VERSION);
const MAP_W              = 2048;
const MAP_H              = 1024;
const MAP_PX             = MAP_W * MAP_H;
const CONQUEST_THRESHOLD = 0.80;
const MAX_STROKE_PX      = 500;
const BROADCAST_MS       = 50;    // delta broadcast debounce
const PING_MS            = 10000;
const TIMEOUT_MS         = 30000;

// ── Bot config ────────────────────────────────────────────────────
const BOT_TICK_MS         = 2000;  // ms between bot ticks (staggered) — slowed for smaller map
const BOT_PIXELS_PER_TICK  = 1;    // pixels per stroke per bot — halved
const BOT_BUCKET_MAX       = 60;   // smaller cap to prevent burst spikes
const BOT_REGEN_MS         = 3000; // bucket regen interval — doubled
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

// SSE event streams subscribed by the Discord bot
const botEventStreams = new Set();

// ── Tweet drafts queue ───────────────────────────────────────────
// Captures notable in-game events as drafted tweets. Surfaced via /admin/tweets
// for an operator to review, edit, and post manually. Manual posting only —
// keeps tweet quality curated and avoids X API costs.

const TWEET_QUEUE_FILE = path.join(__dirname, 'tweet_queue.json');
const TWEETS_MAX_KEEP   = 500;      // total drafts retained
const TWEETS_DEDUPE_MS  = 5 * 60_000;       // 5 min dedupe window per event signature
const TWEETS_RATE_LIMIT = 60 * 60_000;      // 1hr min between conquest tweets from same attacker
const tweetQueue = [];                       // newest first; each: { id, ts, type, text, status }
const _tweetLastByKey = new Map();           // key → ts (dedupe / throttle)
let _tweetSaveTimer = null;

function loadTweetQueue() {
  try {
    if (fs.existsSync(TWEET_QUEUE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TWEET_QUEUE_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        for (const t of raw) tweetQueue.push(t);
        console.log('[Tweets] Loaded', tweetQueue.length, 'drafts from disk');
      }
    }
  } catch (e) { console.error('[Tweets] Failed to load queue:', e.message); }
}

function saveTweetQueue() {
  if (_tweetSaveTimer) return;
  _tweetSaveTimer = setTimeout(() => {
    _tweetSaveTimer = null;
    try {
      const tmp = TWEET_QUEUE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(tweetQueue.slice(0, TWEETS_MAX_KEEP)));
      fs.renameSync(tmp, TWEET_QUEUE_FILE);
    } catch (e) { console.error('[Tweets] Failed to save:', e.message); }
  }, 2000);
}

function pushTweetDraft({ type, text, dedupeKey, throttleKey }) {
  const now = Date.now();
  // Dedupe: same event recently? skip.
  if (dedupeKey) {
    const last = _tweetLastByKey.get(dedupeKey);
    if (last && now - last < TWEETS_DEDUPE_MS) return null;
  }
  // Throttle: same attacker / event-class recently? skip.
  if (throttleKey) {
    const last = _tweetLastByKey.get('throttle:' + throttleKey);
    if (last && now - last < TWEETS_RATE_LIMIT) return null;
  }
  const draft = {
    id:     Math.random().toString(36).slice(2, 10),
    ts:     now,
    type,
    text:   String(text || '').slice(0, 280),
    status: 'pending',  // 'pending' | 'posted' | 'dismissed'
  };
  tweetQueue.unshift(draft);
  if (dedupeKey)   _tweetLastByKey.set(dedupeKey, now);
  if (throttleKey) _tweetLastByKey.set('throttle:' + throttleKey, now);
  // Prune
  if (tweetQueue.length > TWEETS_MAX_KEEP) tweetQueue.length = TWEETS_MAX_KEEP;
  saveTweetQueue();
  return draft;
}

// Helpers to format country names with hashtags
function _countryName(id) { return countryNames[id] || ('Country ' + id); }
function _countryTag(id) {
  // ISO 3166-1 numeric → hashtag-safe name (alphanumeric only)
  const n = _countryName(id).replace(/[^A-Za-z0-9]/g, '');
  return n ? '#' + n : '';
}

// ── Tweet template generators ────────────────────────────────────
function tweetForConquest(attackerId, defenderGeoId) {
  const a = _countryName(attackerId);
  const d = _countryName(defenderGeoId);
  // Count attacker's total conquests
  let conquestsHeld = 0;
  for (const key of conqueredSet) {
    const parts = String(key).split(':');
    if (parts[1] === String(attackerId)) conquestsHeld++;
  }
  const text = `🗡️ ${a} has conquered ${d}! ${a} now controls ${conquestsHeld} ${conquestsHeld === 1 ? 'country' : 'countries'}. Play at pixelannex.com ${_countryTag(attackerId)} ${_countryTag(defenderGeoId)} #PixelAnnex`;
  return text;
}

function tweetForReversal(victimId, oppressorId) {
  const v = _countryName(victimId);
  const o = _countryName(oppressorId);
  return `🛡️ ${v} has liberated itself from ${o}! The resistance prevails. ${_countryTag(victimId)} #PixelAnnex pixelannex.com`;
}

function tweetForNuke(attackerId, cx, cy) {
  const a = _countryName(attackerId);
  // Find which geographic country was nuked (look up geoAtPixel)
  const i = cy * MAP_W + cx;
  const geoId = (i >= 0 && i < geoAtPixel.length) ? geoAtPixel[i] : -1;
  const targetName = geoId >= 0 ? _countryName(String(geoId)) : 'open territory';
  return `☢️ ${a} has launched a nuclear strike on ${targetName}! No-paint zone active for 2 minutes. ${_countryTag(attackerId)} #PixelAnnex pixelannex.com`;
}

function tweetForDailySummary() {
  // Top 3 countries by pixels
  const top = Object.entries(countryPxCount)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  if (!top.length) return null;
  const distinctConquered = new Set();
  for (const key of conqueredSet) distinctConquered.add(String(key).split(':')[0]);
  const lines = top.map(([id, c], i) => `${i + 1}. ${_countryName(id)} (${c.toLocaleString()} px)`).join(' · ');
  return `🌍 World Snapshot · ${lines} · ${distinctConquered.size} countries conquered · Play at pixelannex.com #PixelAnnex`;
}

function tweetForAdmiralPromotion(username, countryId) {
  return `🎖️ ${username} has reached ADMIRAL rank in PixelAnnex ${countryId ? '(' + _countryName(countryId) + ')' : ''}! Nukes unlocked. ☢️ Play at pixelannex.com #PixelAnnex`;
}

// Daily summary scheduler — fires once per UTC day at 12:00 UTC
function scheduleDailySummary() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(12, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(() => {
    const text = tweetForDailySummary();
    if (text) {
      pushTweetDraft({
        type:       'daily_summary',
        text,
        dedupeKey: 'daily_summary:' + now.toUTCString().slice(0, 16),
      });
      console.log('[Tweets] Daily summary queued at', new Date().toISOString());
    }
    scheduleDailySummary(); // schedule next day
  }, msUntil);
  console.log('[Tweets] Next daily summary at', next.toISOString());
}

loadTweetQueue();
scheduleDailySummary();


// Broadcast a game event to all connected bots
function emitBotEvent(event) {
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const stream of botEventStreams) {
    try { stream.write(data); } catch (e) { botEventStreams.delete(stream); }
  }
}
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Player profiles by discord_id (persists across sessions)
const profiles = new Map();
const PROFILES_FILE = path.join(__dirname, 'profiles.json');

const TWEET_ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PixelAnnex Tweet Drafts</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: ui-monospace, monospace; background:#0f172a; color:#e2e8f0; margin:0; padding:24px; max-width:920px; margin:auto; }
  h1 { color:#fbbf24; margin:0 0 6px 0; font-size:22px; letter-spacing:.06em; }
  .sub { color:#94a3b8; font-size:12px; margin-bottom:22px; }
  .filters { margin-bottom:18px; display:flex; gap:8px; flex-wrap:wrap; }
  .filters button {
    background:#1e293b; border:1px solid #334155; color:#cbd5e1;
    padding:6px 12px; cursor:pointer; border-radius:4px; font-family:inherit; font-size:12px;
  }
  .filters button.active { background:#3b82f6; border-color:#60a5fa; color:#fff; }
  .compose {
    background:#1e293b; border:1px solid #334155; padding:14px; border-radius:8px;
    margin-bottom:24px;
  }
  .compose textarea { width:100%; height:80px; box-sizing:border-box; background:#0f172a; border:1px solid #334155; color:#e2e8f0; font-family:inherit; padding:10px; border-radius:4px; font-size:13px; resize:vertical; }
  .compose .row { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
  .compose .count { color:#94a3b8; font-size:11px; }
  .compose button { background:#22c55e; border:none; color:#fff; padding:8px 16px; cursor:pointer; border-radius:4px; font-family:inherit; font-size:13px; }
  .compose button:disabled { background:#475569; cursor:not-allowed; }
  .tweet {
    background:#1e293b; border:1px solid #334155; padding:14px;
    margin-bottom:12px; border-radius:8px;
  }
  .tweet.status-posted    { opacity:.45; border-left:3px solid #22c55e; }
  .tweet.status-dismissed { opacity:.30; border-left:3px solid #64748b; }
  .tweet.status-pending   { border-left:3px solid #3b82f6; }
  .meta { color:#94a3b8; font-size:11px; margin-bottom:8px; display:flex; gap:12px; align-items:center; }
  .meta .type { background:#0f172a; color:#fbbf24; padding:1px 6px; border-radius:3px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
  .meta .age { font-style:italic; }
  .text {
    background:#0f172a; padding:10px; border-radius:4px; border:1px solid #1e293b;
    font-size:13px; line-height:1.5; white-space:pre-wrap; word-break:break-word;
    min-height:24px;
  }
  .text[contenteditable] { outline:1px solid #3b82f6; }
  .actions { display:flex; gap:8px; margin-top:10px; align-items:center; }
  .actions .count { color:#94a3b8; font-size:11px; margin-right:auto; }
  .actions .count.over { color:#ef4444; font-weight:700; }
  .actions button { background:#334155; border:none; color:#e2e8f0; padding:6px 12px; cursor:pointer; border-radius:4px; font-family:inherit; font-size:12px; }
  .actions button:hover { background:#475569; }
  .actions .btn-post   { background:#1d4ed8; }
  .actions .btn-post:hover { background:#3b82f6; }
  .actions .btn-edit   { background:#334155; }
  .actions .btn-copy   { background:#0891b2; }
  .actions .btn-copy:hover { background:#06b6d4; }
  .empty { text-align:center; color:#64748b; padding:50px 20px; font-size:13px; }
</style>
</head>
<body>
<h1>📰 PixelAnnex Tweet Drafts</h1>
<div class="sub">Operator queue · Click "Post on X" to open with prefilled text · Then mark as posted</div>

<div class="compose">
  <textarea id="compose-text" placeholder="Write a custom tweet…" maxlength="280"></textarea>
  <div class="row">
    <span class="count" id="compose-count">0 / 280</span>
    <button id="compose-btn">Add to queue</button>
  </div>
</div>

<div class="filters">
  <button class="filter active" data-filter="pending">Pending</button>
  <button class="filter" data-filter="posted">Posted</button>
  <button class="filter" data-filter="dismissed">Dismissed</button>
  <button class="filter" data-filter="">All</button>
</div>

<div id="tweets"></div>

<script>
const KEY = new URLSearchParams(location.search).get('key');
const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': KEY };
let activeFilter = 'pending';

function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

async function load() {
  const url = activeFilter ? '/api/tweets?key=' + KEY + '&status=' + activeFilter : '/api/tweets?key=' + KEY;
  const r = await fetch(url);
  const d = await r.json();
  render(d.tweets || []);
}

function render(tweets) {
  const root = document.getElementById('tweets');
  if (!tweets.length) {
    root.innerHTML = '<div class="empty">No tweets in this category.</div>';
    return;
  }
  root.innerHTML = tweets.map(t => \`
    <div class="tweet status-\${t.status}" data-id="\${t.id}">
      <div class="meta">
        <span class="type">\${t.type}</span>
        <span class="age">\${ago(t.ts)}</span>
        <span style="margin-left:auto">\${t.status.toUpperCase()}</span>
      </div>
      <div class="text" data-id="\${t.id}">\${escapeHtml(t.text)}</div>
      <div class="actions">
        <span class="count \${t.text.length > 280 ? 'over' : ''}">\${t.text.length}/280</span>
        \${t.status === 'pending' ? \`
          <button class="btn-edit"   data-act="edit">Edit</button>
          <button class="btn-copy"   data-act="copy">Copy</button>
          <button class="btn-post"   data-act="post-on-x">Post on X</button>
          <button class="btn-post"   data-act="posted">Mark posted</button>
          <button                    data-act="dismiss">Dismiss</button>
        \` : ''}
      </div>
    </div>
  \`).join('');
}

document.addEventListener('click', async (e) => {
  const filterBtn = e.target.closest('.filter');
  if (filterBtn) {
    document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
    filterBtn.classList.add('active');
    activeFilter = filterBtn.dataset.filter;
    load();
    return;
  }
  if (e.target.id === 'compose-btn') {
    const text = document.getElementById('compose-text').value.trim();
    if (!text) return;
    await fetch('/api/tweets?key=' + KEY, {
      method: 'POST', headers, body: JSON.stringify({ text }),
    });
    document.getElementById('compose-text').value = '';
    document.getElementById('compose-count').textContent = '0 / 280';
    load();
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tweetEl = btn.closest('.tweet');
  const id = tweetEl.dataset.id;
  const act = btn.dataset.act;
  const textEl = tweetEl.querySelector('.text');
  if (act === 'edit') {
    textEl.contentEditable = 'true';
    textEl.focus();
    btn.textContent = 'Save';
    btn.dataset.act = 'save-edit';
    return;
  }
  if (act === 'save-edit') {
    textEl.contentEditable = 'false';
    await fetch('/api/tweets/' + id + '/edit?key=' + KEY, {
      method: 'POST', headers,
      body: JSON.stringify({ text: textEl.textContent }),
    });
    load();
    return;
  }
  if (act === 'copy') {
    await navigator.clipboard.writeText(textEl.textContent);
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 1500);
    return;
  }
  if (act === 'post-on-x') {
    const url = 'https://x.com/intent/post?text=' + encodeURIComponent(textEl.textContent);
    window.open(url, '_blank');
    return;
  }
  if (act === 'posted') {
    await fetch('/api/tweets/' + id + '/posted?key=' + KEY, { method: 'POST', headers });
    load();
    return;
  }
  if (act === 'dismiss') {
    await fetch('/api/tweets/' + id + '/dismissed?key=' + KEY, { method: 'POST', headers });
    load();
    return;
  }
});

document.getElementById('compose-text').addEventListener('input', (e) => {
  const len = e.target.value.length;
  const el = document.getElementById('compose-count');
  el.textContent = len + ' / 280';
  el.style.color = len > 280 ? '#ef4444' : '#94a3b8';
  document.getElementById('compose-btn').disabled = len === 0 || len > 280;
});

load();
setInterval(load, 30_000); // refresh every 30s
</script>
</body>
</html>`;


// Load existing profiles on startup
try {
  if (fs.existsSync(PROFILES_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    for (const p of raw) {
      if (p.discordId) profiles.set(p.discordId, p);
    }
    console.log(`[Profiles] Loaded ${profiles.size} profiles from disk`);
  }
} catch (e) {
  console.error('[Profiles] Failed to load:', e.message);
}

// Save profiles periodically (every 60s) and on shutdown
let _profilesDirty = false;
function markProfilesDirty() { _profilesDirty = true; }
function saveProfiles() {
  if (!_profilesDirty) return;
  _profilesDirty = false;
  try {
    const arr = [...profiles.values()];
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(arr), 'utf8');
  } catch (e) {
    console.error('[Profiles] Failed to save:', e.message);
    _profilesDirty = true; // retry on next tick
  }
}
setInterval(saveProfiles, 60 * 1000);
process.on('SIGTERM', () => { saveProfiles(); });
process.on('SIGINT',  () => { saveProfiles(); process.exit(0); });
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
      // Stats
      points:            0,    // total points (currently = total pixels placed)
      pixelsPlaced:      0,    // total pixels painted (lifetime)
      conquestsMade:     0,    // countries conquered by this player
      countriesLost:     0,    // times someone conquered a country you held
      bombsDeployed:     0,    // bombs detonated
      topCountries:      {},   // countryId → pixel count painted there
      lastSeen:          Date.now(),
      joinedAt:          Date.now(),
      // Daily login tracking
      lastLoginDay:      null,  // YYYY-MM-DD string of last login
      streakDays:        0,     // consecutive days logged in
    });
  }
  const p = profiles.get(discordId);
  // Backfill any missing fields (for profiles from before stats existed)
  if (typeof p.points         !== 'number') p.points         = p.xp || 0;
  if (typeof p.pixelsPlaced   !== 'number') p.pixelsPlaced   = 0;
  if (typeof p.conquestsMade  !== 'number') p.conquestsMade  = 0;
  if (typeof p.countriesLost  !== 'number') p.countriesLost  = 0;
  if (typeof p.bombsDeployed  !== 'number') p.bombsDeployed  = 0;
  if (!p.topCountries) p.topCountries = {};
  if (typeof p.streakDays !== 'number') p.streakDays = 0;
  if (typeof p.lastLoginDay === 'undefined') p.lastLoginDay = null;
  return p;
}

// ── Daily login bonus ─────────────────────────────────────────────
// On first visit each calendar day, grant pixels. Weekly streak gives more.
const DAILY_BASE_BONUS = 10;      // daily login bonus
const WEEKLY_STREAK_BONUS = 140;  // every 7th consecutive day (10 daily + 140 streak = 150 total)
const DISCORD_WELCOME_BONUS = 200; // once-off for first Discord login

function todayString() {
  const d = new Date();
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth()+1).padStart(2,'0') + '-' +
    String(d.getUTCDate()).padStart(2,'0');
}

function processDailyLogin(discordId) {
  const profile = getProfile(discordId);
  const today = todayString();
  // One-off Discord welcome bonus — granted the first time the user ever logs in.
  let discordBonus = 0;
  if (!profile.discordWelcomeClaimed) {
    discordBonus = DISCORD_WELCOME_BONUS;
    profile.discordWelcomeClaimed = true;
  }
  if (profile.lastLoginDay === today) {
    // Already claimed today's daily, but might still have the one-off Discord bonus
    if (discordBonus > 0) markProfilesDirty();
    return {
      granted: discordBonus,
      dailyBonus: 0,
      streakBonus: 0,
      discordBonus,
      streakDays: profile.streakDays,
      alreadyClaimed: discordBonus === 0,
    };
  }
  // Streak update
  let yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yStr = yesterday.getUTCFullYear() + '-' +
    String(yesterday.getUTCMonth()+1).padStart(2,'0') + '-' +
    String(yesterday.getUTCDate()).padStart(2,'0');
  if (profile.lastLoginDay === yStr) {
    profile.streakDays = (profile.streakDays || 0) + 1;
  } else {
    profile.streakDays = 1;
  }
  profile.lastLoginDay = today;
  let dailyBonus = DAILY_BASE_BONUS;
  let streakBonus = 0;
  if (profile.streakDays > 0 && profile.streakDays % 7 === 0) {
    streakBonus = WEEKLY_STREAK_BONUS;
  }
  const granted = dailyBonus + streakBonus + discordBonus;
  markProfilesDirty();
  return {
    granted,
    dailyBonus,
    streakBonus,
    discordBonus,
    streakDays: profile.streakDays,
    alreadyClaimed: false,
  };
}


// ── Rank system (mirrors client RANKS array) ─────────────────────
const RANK_THRESHOLDS = [
  { name: 'Soldier',    min: 0   },
  { name: 'Lieutenant', min: 50  },
  { name: 'Captain',    min: 150 },
  { name: 'General',    min: 300 },
  { name: 'Admiral',    min: 500 },
];

function rankFromXP(xp) {
  let rank = RANK_THRESHOLDS[0].name;
  for (const r of RANK_THRESHOLDS) {
    if (xp >= r.min) rank = r.name;
  }
  return rank;
}

// Update a player's XP and emit rank_change event if rank crosses a threshold
function updateProfileXP(discordId, xpDelta) {
  if (!discordId) return;
  const profile = getProfile(discordId);
  const oldRank = profile.rank || 'Soldier';
  profile.xp = (profile.xp || 0) + xpDelta;
  const newRank = rankFromXP(profile.xp);
  if (newRank !== oldRank) {
    profile.rank = newRank;
    console.log(`[Rank] ${profile.username || discordId}: ${oldRank} → ${newRank} (xp=${profile.xp})`);
    emitBotEvent({
      type: 'rank_change',
      discordId,
      username: profile.username,
      oldRank,
      newRank,
      xp: profile.xp,
    });
  }
}


// ── Siege tracking ───────────────────────────────────────────────
// A country enters "siege" when an enemy holds >50% of its territory.
// Used to push siege_start / siege_end events to the war reporter bot.
const SIEGE_THRESHOLD = 0.50;
const siegedSet = new Set(); // geoIdx values currently in siege state

function checkSiegeState(geoIdx) {
  const total = geoTotal[geoIdx] || 0;
  if (!total) return;
  let dominantEnemy = null;
  let maxEnemy = 0;
  if (geoClaimCnt[geoIdx]) {
    for (const [cId, cnt] of Object.entries(geoClaimCnt[geoIdx])) {
      if (cId === geoToId(geoIdx)) continue;
      if (cnt > maxEnemy) { maxEnemy = cnt; dominantEnemy = cId; }
    }
  }
  const ratio = maxEnemy / total;
  const wasSieged = siegedSet.has(geoIdx);

  if (ratio >= SIEGE_THRESHOLD && !wasSieged) {
    siegedSet.add(geoIdx);
    emitBotEvent({
      type:        'war_siege_start',
      tier:        2,
      attackerId:  dominantEnemy,
      defenderId:  geoToId(geoIdx),
      ratio:       Math.round(ratio * 100),
      timestamp:   Date.now(),
    });
  } else if (ratio < SIEGE_THRESHOLD && wasSieged) {
    siegedSet.delete(geoIdx);
    emitBotEvent({
      type:        'war_siege_end',
      tier:        1,
      defenderId:  geoToId(geoIdx),
      timestamp:   Date.now(),
    });
  }
}

// ── Alliance detection ───────────────────────────────────────────
// An alliance forms when 3+ players share at least one country in their
// preferences (countryMain, countryB, countryC).
// Recomputed every 30 seconds from current profiles.

const ALLIANCE_MIN_MEMBERS = 3;
const ALLIANCE_RECOMPUTE_MS = 30000;

// Active alliances: alliance_key (sorted country IDs joined by '-') → { countries:[], members:[discordIds] }
const alliances = new Map();

function recomputeAlliances() {
  if (profiles.size < ALLIANCE_MIN_MEMBERS) return;

  // Build: country_id → Set<discordId> who have this country in any of their slots
  const countryMembership = new Map();
  for (const [discordId, profile] of profiles) {
    const countries = [profile.countryMain, profile.countryB, profile.countryC].filter(Boolean);
    for (const c of countries) {
      if (!countryMembership.has(c)) countryMembership.set(c, new Set());
      countryMembership.get(c).add(discordId);
    }
  }

  // Group countries that share members — countries are in same alliance if they
  // share a member. Use union-find to cluster countries.
  const parent = {};
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { parent[find(a)] = find(b); }

  for (const c of countryMembership.keys()) parent[c] = c;

  // For each player, union all their selected countries together
  for (const profile of profiles.values()) {
    const cs = [profile.countryMain, profile.countryB, profile.countryC].filter(Boolean);
    for (let i = 1; i < cs.length; i++) union(cs[0], cs[i]);
  }

  // Group by root
  const clusters = {};
  for (const c of countryMembership.keys()) {
    const root = find(c);
    if (!clusters[root]) clusters[root] = { countries: new Set(), members: new Set() };
    clusters[root].countries.add(c);
    for (const m of countryMembership.get(c)) clusters[root].members.add(m);
  }

  // Filter clusters with enough members
  const newAlliances = new Map();
  for (const cluster of Object.values(clusters)) {
    if (cluster.members.size < ALLIANCE_MIN_MEMBERS) continue;
    if (cluster.countries.size < 2) continue; // single country isn't an alliance
    const key = [...cluster.countries].sort((a,b) => +a - +b).join('-');
    newAlliances.set(key, {
      countries: [...cluster.countries].sort((a,b) => +a - +b),
      members:   [...cluster.members],
    });
  }

  // Diff old vs new — emit events for created/dissolved alliances
  for (const [key, alliance] of newAlliances) {
    if (!alliances.has(key)) {
      console.log(`[Alliance] Formed: ${key} (${alliance.members.length} members)`);
      emitBotEvent({
        type: 'alliance_formed',
        key,
        countries: alliance.countries,
        members:   alliance.members,
      });
    } else {
      // Check if member list changed
      const oldMembers = new Set(alliances.get(key).members);
      const newMembers = new Set(alliance.members);
      const added   = [...newMembers].filter(m => !oldMembers.has(m));
      const removed = [...oldMembers].filter(m => !newMembers.has(m));
      if (added.length || removed.length) {
        emitBotEvent({
          type: 'alliance_changed',
          key,
          countries: alliance.countries,
          added,
          removed,
          members: alliance.members,
        });
      }
    }
  }
  for (const [key, alliance] of alliances) {
    if (!newAlliances.has(key)) {
      console.log(`[Alliance] Dissolved: ${key}`);
      emitBotEvent({
        type: 'alliance_dissolved',
        key,
        countries: alliance.countries,
      });
    }
  }

  alliances.clear();
  for (const [key, alliance] of newAlliances) alliances.set(key, alliance);
}

setInterval(recomputeAlliances, ALLIANCE_RECOMPUTE_MS);

// Look up which alliance a country belongs to
function getAllianceForCountry(countryId) {
  countryId = String(countryId);
  for (const [key, alliance] of alliances) {
    if (alliance.countries.includes(countryId)) return { key, ...alliance };
  }
  return null;
}

// ── Map state ─────────────────────────────────────────────────────
const claimByPixel = new Int16Array(MAP_PX).fill(-1);
const geoAtPixel   = new Int16Array(MAP_PX).fill(-1);
const landMask     = new Uint8Array(MAP_PX).fill(0);
const geoClaimCnt  = {};   // geoIdx → { countryId → count }
const geoTotal     = {};   // geoIdx → total land pixels

// ── Compressed asset cache (Brotli + gzip) ───────────────────────
// Pre-compress static assets once on startup, cache in memory.
// Saves CPU per request vs. compressing on-the-fly.
const _compressedAssets = new Map(); // path → { br, gz, raw, mime }

function _cacheAsset(diskPath, mime) {
  try {
    const raw = fs.readFileSync(diskPath);
    const zlib = require('zlib');
    const br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 }, // 9 is a good speed/ratio balance
    });
    const gz = zlib.gzipSync(raw, { level: 9 });
    _compressedAssets.set(diskPath, { raw, br, gz, mime });
    const savings = (1 - br.length / raw.length) * 100;
    console.log('[Compress] ' + diskPath + ': raw=' + raw.length +
      ', gz=' + gz.length + ', br=' + br.length + ' (' + savings.toFixed(1) + '% smaller)');
  } catch (e) {
    console.warn('[Compress] Failed for', diskPath, e.message);
  }
}

// Serve a cached asset with content negotiation
function serveCompressedAsset(req, res, diskPath, extraHeaders = {}) {
  const asset = _compressedAssets.get(diskPath);
  if (!asset) {
    res.writeHead(404); res.end();
    return;
  }
  const accept = String(req.headers['accept-encoding'] || '');
  const headers = { 'Content-Type': asset.mime, ...extraHeaders };
  let body;
  if (accept.includes('br')) {
    headers['Content-Encoding'] = 'br';
    headers['Vary'] = 'Accept-Encoding';
    body = asset.br;
  } else if (accept.includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    body = asset.gz;
  } else {
    body = asset.raw;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

// Pre-compress assets on startup. Lazy: only happens once per file.
function precompressAssets() {
  const path = require('path');
  const candidates = [
    { p: path.join(__dirname, 'pixelworld_v5.html'), mime: 'text/html; charset=utf-8' },
    { p: path.join(__dirname, 'countries-10m.json'), mime: 'application/json' },
    { p: path.join(__dirname, 'sw.js'),              mime: 'application/javascript' },
  ];
  for (const { p, mime } of candidates) {
    if (fs.existsSync(p)) _cacheAsset(p, mime);
  }
}

// Re-compress when the source HTML/json changes on disk (dev workflow).
// In production, restart the server to refresh.
function watchAssetsForChanges() {
  const path = require('path');
  const paths = [
    path.join(__dirname, 'pixelworld_v5.html'),
    path.join(__dirname, 'sw.js'),
  ];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      fs.watch(p, { persistent: false }, () => {
        const asset = _compressedAssets.get(p);
        if (asset) _cacheAsset(p, asset.mime);
      });
    } catch (e) { /* ignore watch errors */ }
  }
}

const conqueredSet = new Set();

// ── Bomb cooldown — anti-spam ────────────────────────────────────
const BOMB_COOLDOWN_MS = 30_000;
const _lastBombAt = new Map(); // discordId or countryId → timestamp

// ── Conquest immunity — anti instant-trade-back ──────────────────
const CONQUEST_IMMUNITY_MS = 20_000;  // 20s no re-conquest after a flip
const _conquestImmunity = new Map(); // geoCountryId → expiresAt

// ── Nuke lockout zones — server authoritative ─────────────────────
// On Nuke detonation, server: (1) clears all pixels in radius (sets to unclaimed),
// (2) creates a 2-minute lockout zone, (3) rejects any paint inside the zone.
const NUKE_LOCKOUT_MS = 30 * 1000; // ⚠️ DEBUG: 30s for testing (production = 2 * 60 * 1000)
const _nukeZones = []; // { cx, cy, radius, expiresAt }

// Run nuke zone expiry every 1s — guarantees timely cleanup even with no traffic
setInterval(() => { _pruneServerNukeZones(); }, 1000);


function _pruneServerNukeZones() {
  const now = Date.now();
  for (let i = _nukeZones.length - 1; i >= 0; i--) {
    const z = _nukeZones[i];
    if (z.expiresAt <= now) {
      // Defensive final clear — guarantees no leftover pixels at expiry
      const changed = clearPixelsInRadius(z.cx, z.cy, z.radius);
      if (changed.length) {
        queueDelta(changed);
        if (typeof flushDelta === 'function') flushDelta(); // force immediate broadcast
      }
      // Broadcast zone-expired so clients also know to clear their nuke canvas
      broadcast(JSON.stringify({ type: 'nuke_zone_expired', cx: z.cx, cy: z.cy, radius: z.radius }));
      console.log('[Nuke] zone expired at', z.cx, z.cy, '— final clear of', changed.length, 'leftover pixels');
      _nukeZones.splice(i, 1);
    }
  }
}

function isPixelInNukeZone(px, py) {
  _pruneServerNukeZones();
  for (const z of _nukeZones) {
    const dx = px - z.cx, dy = py - z.cy;
    if (dx*dx + dy*dy <= z.radius * z.radius) return true;
  }
  return false;
}

// Clear pixels in a radius — set them to unclaimed (-1) and emit clear deltas
function clearPixelsInRadius(cx, cy, radius) {
  const r2 = radius * radius;
  const changed = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx*dx + dy*dy > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) continue;
      const i = y * MAP_W + x;
      // Clear regardless of server's landMask state — if a pixel is currently
      // owned, the nuke wipes it. This handles cases where landMask might be
      // incomplete or stale on the server side.
      const prev = claimByPixel[i];
      if (prev < 0) continue;
      const prevId = idxToId[prev];
      countryPxCount[prevId] = Math.max(0, (countryPxCount[prevId] || 1) - 1);
      const geo = geoAtPixel[i];
      if (geo >= 0 && geoClaimCnt[geo]?.[prevId]) {
        geoClaimCnt[geo][prevId] = Math.max(0, geoClaimCnt[geo][prevId] - 1);
      }
      updateOwnerIndex(i, prev, -1);
      claimByPixel[i] = -1;
      changed.push({ x, y, owner: null });
    }
  }
  return changed;
}

// Cleanup stale conquest immunity entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of _conquestImmunity) if (t < now) _conquestImmunity.delete(k);
}, 60_000);


function isBombOnCooldownServer(key) {
  const last = _lastBombAt.get(key);
  if (!last) return false;
  return Date.now() - last < BOMB_COOLDOWN_MS;
}
function markBombDeployed(key) { _lastBombAt.set(key, Date.now()); }

// Countries that have been conquered by real players — their resident bots stop reclaiming.
// Cleared when the country's territory drops below 30% enemy occupation (player let it slip).
const humanClaimedCountries = new Set();
const HUMAN_CLAIM_RELEASE_THRESHOLD = 0.30; // bot starts reclaiming again if <30% enemy held
const countryPxCount = {}; // countryId → pixel count

// ── David vs Goliath system ───────────────────────────────────────
// Small countries (low world share) get bonus regen so they can fight back
// against neighbours that have spread aggressively.
//
// World share = (pixels owned by country) / (total land pixels in the world)
// Multiplier scale:
//   share ≤ 0.001 (0.1%) → 5×    — tiny countries get max boost
//   share ≤ 0.005 (0.5%) → 3×
//   share ≤ 0.01  (1%)   → 2×
//   share ≤ 0.05  (5%)   → 1.5×  — slight buff for mid-sized
//   share >  0.05        → 1×    — no bonus, big countries play normal
let totalLandPxCached = 0;

function recomputeTotalLand() {
  totalLandPxCached = Object.values(geoTotal).reduce((a, b) => a + b, 0);
}
function getWorldShare(countryId) {
  // World share is based on a country's NATIVE territory size (geoTotal),
  // not on actively-painted pixels. This makes the David buff geographic
  // (USA is always Goliath; Vatican is always David) regardless of who's
  // actively painting where.
  if (totalLandPxCached <= 0) return 0;
  const geoIdx = parseInt(countryId, 10);
  const territory = geoTotal[geoIdx] || 0;
  return territory / totalLandPxCached;
}
function getRegenMultiplier(countryId) {
  const share = getWorldShare(countryId);
  if (share <= 0.001) return 5;
  if (share <= 0.005) return 3;
  if (share <= 0.01)  return 2;
  if (share <= 0.05)  return 1.5;
  return 1;
}

// Build a snapshot of world shares + multipliers for the client to display.
// Sent every ~5s as part of the players broadcast.
function buildDavidSnapshot() {
  if (totalLandPxCached <= 0) recomputeTotalLand();
  const out = {};
  for (const geoIdx of Object.keys(geoTotal)) {
    const cid   = String(geoIdx);
    const share = getWorldShare(cid);
    const mult  = getRegenMultiplier(cid);
    out[cid] = { share, mult };
  }
  // Layer active encirclement bonuses on top — these stack with David
  for (const [cid, bonus] of encircleBonuses) {
    if (Date.now() > bonus.expiresAt) { encircleBonuses.delete(cid); continue; }
    if (!out[cid]) out[cid] = { share: getWorldShare(cid), mult: 1 };
    out[cid].encMult = bonus.mult;
    out[cid].encExpiresAt = bonus.expiresAt;
  }
  return out;
}

const countryNames   = {}; // countryId → display name (populated from client bootstrap)
const indexToId      = {}; // featList index → real country ID (geoAtPixel stores indices)

// geoAtPixel stores country IDs directly (not featList indices) since the
// client now sends real IDs in geoPixelRuns. geoToId is just a string conversion.
function geoToId(geoVal) {
  return String(geoVal);
}

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
  const davidSnapshot = buildDavidSnapshot();
  const list = [];
  for (const [pid, p] of players) {
    list.push({ id: pid, countryId: p.countryId, pixels: countryPxCount[p.countryId] || 0, isBot: !!p.isBot });
  }
  broadcast(JSON.stringify({ type: 'players', list, david: davidSnapshot }));
}

// ── State snapshot (RLE compressed) ──────────────────────────────
precompressAssets();
watchAssetsForChanges();

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


// ── Stroke rate limiting — anti-script/macro abuse ───────────────
// Token bucket per player. Players get STROKE_BURST_MAX pixels of burst,
// refilling at STROKE_REFILL_RATE_PS pixels per second.
// Normal organic play (mouse drag, brush size up to 5x5) stays well under
// these caps. Macro attacks blasting thousands of pixels/sec get throttled.
const STROKE_BURST_MAX      = 200;     // max pixels you can submit in one burst
const STROKE_REFILL_RATE_PS = 20;      // pixels added back per second
const _strokeBuckets = new Map();      // pid → { tokens, lastRefillAt }

function _refillStrokeBucket(pid) {
  let b = _strokeBuckets.get(pid);
  const now = Date.now();
  if (!b) {
    b = { tokens: STROKE_BURST_MAX, lastRefillAt: now };
    _strokeBuckets.set(pid, b);
    return b;
  }
  const elapsedMs = now - b.lastRefillAt;
  if (elapsedMs > 0) {
    const refill = (elapsedMs / 1000) * STROKE_REFILL_RATE_PS;
    b.tokens = Math.min(STROKE_BURST_MAX, b.tokens + refill);
    b.lastRefillAt = now;
  }
  return b;
}

// Returns the number of pixels the player is allowed to spend.
// If `requested` is more than available, only that many tokens are deducted
// and the caller should clamp the actual pixels processed.
function consumeStrokeTokens(pid, requested) {
  const b = _refillStrokeBucket(pid);
  const allowed = Math.min(requested, Math.floor(b.tokens));
  b.tokens -= allowed;
  return allowed;
}

// Cleanup stale buckets every 5 minutes (players disconnect or move on)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [pid, b] of _strokeBuckets) {
    if (b.lastRefillAt < cutoff) _strokeBuckets.delete(pid);
  }
}, 5 * 60 * 1000);

// ── Core pixel logic ──────────────────────────────────────────────
function applyPixels(pixels, countryId) {
  const cidx     = getIdx(countryId);
  const changed  = [];
  const affected = new Set();

  for (const { x, y } of pixels) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) continue;
    const i = y * MAP_W + x;
    if (!landMask[i]) continue;
    // Reject paint inside an active nuke lockout zone
    if (isPixelInNukeZone(x, y)) continue;
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
    // Skip self-conquest — a country can't conquer itself
    if (countryId === geoToId(geo)) continue;
    // Conquest immunity — don't allow flips within IMMUNITY_MS of last conquest
    const immuneUntil = _conquestImmunity.get(geoToId(geo));
    if (immuneUntil && Date.now() < immuneUntil) {
      continue; // territory is still settling after a recent flip
    }
    if (!conqueredSet.has(key) && owned / total >= CONQUEST_THRESHOLD) {
      _conquestImmunity.set(geoToId(geo), Date.now() + CONQUEST_IMMUNITY_MS);
      conqueredSet.add(key);
      conquests.push({ geoIdx: geo, countryId });
      changed.push(...finisherFill(geo, countryId));
      // War reporter event — Tier 2 (role ping)
      // Skip self-conquest (country reclaiming its own native territory)
      if (countryId !== geoToId(geo)) {
        emitBotEvent({
          type:        'war_conquest',
          tier:        2,
          attackerId:  countryId,
          defenderId:  geoToId(geo),
          timestamp:   Date.now(),
        });
        // Queue a tweet draft for the conquest. Throttle per attacker so a
        // single dominant country doesn't flood the queue.
        try {
          pushTweetDraft({
            type:        'conquest',
            text:        tweetForConquest(countryId, geoToId(geo)),
            dedupeKey:   'conquest:' + countryId + ':' + geoToId(geo),
            throttleKey: 'conquest_attacker:' + countryId,
          });
        } catch (e) { console.warn('[Tweets] conquest draft failed:', e.message); }
      }
    }
    for (const [cId, cnt] of Object.entries(geoClaimCnt[geo] || {})) {
      const rk = geo + ':' + cId;
      if (cId !== countryId && conqueredSet.has(rk) && (cnt || 0) / total < CONQUEST_THRESHOLD) {
        conqueredSet.delete(rk);
        reversals.push({ geoIdx: geo, countryId: cId });
        // Queue a tweet draft for the reversal (liberation)
        try {
          pushTweetDraft({
            type:        'reversal',
            text:        tweetForReversal(geoToId(geo), cId),
            dedupeKey:   'reversal:' + geoToId(geo) + ':' + cId,
            throttleKey: 'reversal_geo:' + geoToId(geo),
          });
        } catch (e) { console.warn('[Tweets] reversal draft failed:', e.message); }
      }
    }
    // Persistence: release the human-claim if the country's enemy occupation drops below threshold
    if (humanClaimedCountries.has(String(geo))) {
      const ownEnemyCnt = Object.entries(geoClaimCnt[geo] || {})
        .filter(([cid]) => cid !== String(geo))
        .reduce((s, [, c]) => s + c, 0);
      if (ownEnemyCnt / total < HUMAN_CLAIM_RELEASE_THRESHOLD) {
        humanClaimedCountries.delete(String(geo));
        console.log(`[Persistence] ${geo} released — bot resuming defence`);
      }
    }
    checkSiegeState(geo);
  }
  return { changed, conquests, reversals };
}

// ── Encirclement detection ────────────────────────────────────────
// After a stroke, detect any closed region the player has enclosed and
// auto-claim those pixels. Returns {enclosedCount, enclosedPixels}.
//
// Performance: limited to strokes whose bbox is < 150×150 pixels, and caps
// the enclosed claim count at 500 pixels to prevent runaway claims.
const ENCIRCLE_MAX_BBOX  = 150;    // bbox upper limit (was 80; loosened for real-world strokes)
const ENCIRCLE_MIN_PX    = 50;     // min enclosed pixels for any reward
const ENCIRCLE_MAX_PX    = 500;    // cap on auto-claimed enclosed pixels
const ENCIRCLE_BBOX_PAD  = 4;      // buffer around stroke bbox

// Bresenham line between two pixels — used to seal gaps where the mouse
// moved fast between samples. Returns all pixels on the line.
function _bresenhamLine(x0, y0, x1, y1) {
  const out = [];
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  while (true) {
    out.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
    if (out.length > 1000) break; // safety cap
  }
  return out;
}

function detectEncirclement(strokePixels, countryId) {
  if (!strokePixels || strokePixels.length < 4) return null;
  const cidx = getIdx(countryId);

  // 1. Bounding box of the stroke
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of strokePixels) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minX = Math.max(0, minX - ENCIRCLE_BBOX_PAD);
  minY = Math.max(0, minY - ENCIRCLE_BBOX_PAD);
  maxX = Math.min(MAP_W - 1, maxX + ENCIRCLE_BBOX_PAD);
  maxY = Math.min(MAP_H - 1, maxY + ENCIRCLE_BBOX_PAD);
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw > ENCIRCLE_MAX_BBOX || bh > ENCIRCLE_MAX_BBOX) return null;

  // 2. Build a "wall" mask covering the stroke + interpolated gaps.
  //    This patches over fast-moving cursor gaps so a near-closed loop
  //    still seals the BFS.
  const wall = new Uint8Array(bw * bh);
  const setWall = (gx, gy) => {
    const lx = gx - minX, ly = gy - minY;
    if (lx < 0 || lx >= bw || ly < 0 || ly >= bh) return;
    wall[ly * bw + lx] = 1;
  };
  for (let s = 0; s < strokePixels.length; s++) {
    const p = strokePixels[s];
    setWall(p.x, p.y);
    // Interpolate to previous point — seals gaps from fast mouse moves.
    // BUT only do this for SMALL gaps (≤ 30 pixels). Larger jumps probably
    // mean the stroke pixels aren't actually consecutive in the drag
    // (e.g. client packs them in batches or out of order), and drawing
    // a Bresenham line between them would cut through the interior.
    if (s > 0) {
      const prev = strokePixels[s - 1];
      const dx = Math.abs(p.x - prev.x), dy = Math.abs(p.y - prev.y);
      if ((dx > 1 || dy > 1) && dx <= 30 && dy <= 30) {
        const line = _bresenhamLine(prev.x, prev.y, p.x, p.y);
        for (const pt of line) setWall(pt.x, pt.y);
      }
    }
  }

  // 3. BFS flood-fill from bbox edges, marking outside-reachable pixels.
  //    Walls block the flood (acts like our painted stroke).
  const visited = new Uint8Array(bw * bh);
  const queue = [];
  const seed = (lx, ly) => {
    if (lx < 0 || lx >= bw || ly < 0 || ly >= bh) return;
    const li = ly * bw + lx;
    if (visited[li]) return;
    if (wall[li]) return;
    const gi = (minY + ly) * MAP_W + (minX + lx);
    if (claimByPixel[gi] === cidx) return; // our existing territory also blocks
    visited[li] = 1;
    queue.push(li);
  };

  for (let lx = 0; lx < bw; lx++) { seed(lx, 0); seed(lx, bh - 1); }
  for (let ly = 0; ly < bh; ly++) { seed(0, ly); seed(bw - 1, ly); }

  while (queue.length) {
    const li = queue.shift();
    const lx = li % bw, ly = (li / bw) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = lx + DX4[d], ny = ly + DY4[d];
      if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
      const nli = ny * bw + nx;
      if (visited[nli]) continue;
      if (wall[nli]) continue;
      const ngi = (minY + ny) * MAP_W + (minX + nx);
      if (claimByPixel[ngi] === cidx) continue;
      visited[nli] = 1;
      queue.push(nli);
    }
  }

  // 4. Collect enclosed pixels: land, not painter-owned, not visited from outside
  const enclosed = [];
  for (let ly = 0; ly < bh && enclosed.length < ENCIRCLE_MAX_PX; ly++) {
    for (let lx = 0; lx < bw && enclosed.length < ENCIRCLE_MAX_PX; lx++) {
      const li = ly * bw + lx;
      if (visited[li]) continue;
      if (wall[li]) continue; // wall pixels are already painted by us
      const gx = minX + lx, gy = minY + ly;
      const gi = gy * MAP_W + gx;
      if (!landMask[gi]) continue;
      if (claimByPixel[gi] === cidx) continue;
      enclosed.push({ x: gx, y: gy });
    }
  }

  if (enclosed.length < ENCIRCLE_MIN_PX) return null;
  // Compute centroid (average position) of enclosed pixels
  let sumX = 0, sumY = 0;
  for (const p of enclosed) { sumX += p.x; sumY += p.y; }
  const centerX = Math.round(sumX / enclosed.length);
  const centerY = Math.round(sumY / enclosed.length);
  return { enclosed, count: enclosed.length, centerX, centerY };
}

// Map enclosed pixel count → regen multiplier and duration
function getEncircleBonus(count) {
  // Tier scale:
  //   50–149   → 2×  for 60s
  //   150–299  → 5×  for 60s
  //   300–499  → 8×  for 60s
  //   500+     → 10× for 60s
  let mult = 2;
  if (count >= 500) mult = 10;
  else if (count >= 300) mult = 8;
  else if (count >= 150) mult = 5;
  else                    mult = 2;
  return { mult, durationMs: 60_000 };
}

// Active encirclement bonuses per country (countryId → { mult, expiresAt })
const encircleBonuses = new Map();

function getEncircleMultiplier(countryId) {
  const b = encircleBonuses.get(String(countryId));
  if (!b) return 1;
  if (Date.now() > b.expiresAt) { encircleBonuses.delete(String(countryId)); return 1; }
  return b.mult;
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
  // Clear existing index (must be wiped before rebuild — stale country IDs would persist otherwise)
  for (const k of Object.keys(geoPixels)) delete geoPixels[k];
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
  const cidx       = getIdx(countryId);
  const geoIdx     = getGeoForCountry(countryId);
  const homePixels = geoPixels[geoIdx];
  if (!homePixels || homePixels.length === 0) return [];

  // Three target pools, scanned in priority order:
  //   1. defend — enemy-held pixels inside our home country (reclaim our land)
  //   2. expand — unclaimed pixels inside our home country (grow into vacant land)
  //   3. attack — pixels in neighbouring countries, adjacent to our existing territory
  const defend = [], expand = [], attack = [];

  // ── Phase 1: scan home country ────────────────────────────────
  const homeSampleSize = Math.min(200, homePixels.length);
  const homeStep = Math.max(1, Math.floor(homePixels.length / homeSampleSize));
  let homeOwned = 0;
  for (let s = 0; s < homePixels.length; s += homeStep) {
    const i = homePixels[s];
    const owner = claimByPixel[i];
    if (owner === cidx) { homeOwned++; continue; }

    const x = i % MAP_W, y = (i / MAP_W) | 0;
    let adjacent = false;
    for (let d = 0; d < 4; d++) {
      const nx = x+DX4[d], ny = y+DY4[d];
      if (nx<0||nx>=MAP_W||ny<0||ny>=MAP_H) continue;
      if (claimByPixel[ny*MAP_W+nx] === cidx) { adjacent = true; break; }
    }
    if (!adjacent) {
      // No foothold yet → seed anywhere if home is currently empty
      if ((ownerPixels[cidx]?.size || 0) > 0) continue;
    }
    if (owner >= 0 && owner !== cidx) defend.push({x,y});
    else                              expand.push({x,y});
  }

  // ── Phase 2: hunt for attack targets in adjacent countries ────
  // Only attack if we have a strong home base — otherwise focus on defending.
  // Threshold: 70%+ of sampled home pixels owned (we're stable).
  const homeStableEnough = homeOwned / homeSampleSize >= 0.7;
  if (homeStableEnough && defend.length === 0 && ownerPixels[cidx]) {
    // Walk a sample of our owned pixels and look for 4-neighbour enemy land
    const owned = [...ownerPixels[cidx]];
    const ownedSample = Math.min(150, owned.length);
    const ownedStep = Math.max(1, Math.floor(owned.length / ownedSample));
    for (let s = 0; s < owned.length && attack.length < limit * 4; s += ownedStep) {
      const i = owned[s];
      const x = i % MAP_W, y = (i / MAP_W) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x+DX4[d], ny = y+DY4[d];
        if (nx<0||nx>=MAP_W||ny<0||ny>=MAP_H) continue;
        const ni = ny*MAP_W+nx;
        if (!landMask[ni]) continue;          // ocean
        const ngeo = geoAtPixel[ni];
        if (ngeo === geoIdx) continue;        // still our home — handled above
        if (claimByPixel[ni] === cidx) continue; // already ours
        attack.push({ x: nx, y: ny });
        if (attack.length >= limit * 4) break;
      }
    }
  }

  // Priority: defend > attack > expand
  // (Attack is now BEFORE expand so bots don't just slowly fill empty home; they push outward)
  const pool = defend.length > 0 ? defend
             : attack.length > 0 ? attack
             : expand;

  // Shuffle to spread paint around so bots don't always hit the same border pixels
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

// Stagger bot ticks so they don't all fire simultaneously.
// Tickers are self-terminating: if the bot disappears from the map, the ticker stops.
let _tickersStarted = false;
function startBotTickers() {
  if (_tickersStarted) return; // already running — no need to start more
  _tickersStarted = true;
  let i = 0;
  for (const [countryId] of bots) {
    const delay = (i % 20) * (BOT_TICK_MS / 20); // spread across tick window
    setTimeout(function tick() {
      if (!bots.has(countryId)) return; // bot was removed — stop this ticker
      botTickSingle(countryId);
      setTimeout(tick, BOT_TICK_MS);
    }, delay);
    i++;
  }
  console.log(`[Bot] ${bots.size} bot tickers started (staggered)`);
}

// When new bots are added later, start their tickers individually
function startTickerFor(countryId) {
  setTimeout(function tick() {
    if (!bots.has(countryId)) return;
    botTickSingle(countryId);
    setTimeout(tick, BOT_TICK_MS);
  }, Math.random() * BOT_TICK_MS);
}

function botTickSingle(countryId) {
  if (!mapReady) return;
  // Persistence: if this country was conquered by a human, the resident bot dies down
  // until the country recovers (the human-claim is released elsewhere when occupation drops)
  if (humanClaimedCountries.has(countryId)) return;
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
  // Bot regen = David multiplier × Encircle multiplier (both >= 1)
  for (const bot of bots.values()) {
    if (bot.bucket >= BOT_BUCKET_MAX) continue;
    const m1 = getRegenMultiplier(bot.countryId);
    const m2 = getEncircleMultiplier(bot.countryId);
    const mult = m1 * m2;
    bot.bucket = Math.min(BOT_BUCKET_MAX, bot.bucket + mult);
  }
}, BOT_REGEN_MS);

// ── Map readiness ─────────────────────────────────────────────────
let mapReady = false;
let geoPixelReady = false;

function checkMapReady() {
  if (!geoPixelReady || Object.keys(geoTotal).length === 0) return;

  const wasReady = mapReady;
  mapReady = true;
  console.log(wasReady
    ? '[Map] Refreshing bot roster after data update'
    : '[Map] Ready — building index and initialising bots');

  buildGeoIndex();

  // Reconcile bots: remove any bot whose country no longer exists in geoPixels
  const validCountries = new Set(Object.keys(geoPixels).map(String));
  let removed = 0;
  for (const countryId of [...bots.keys()]) {
    if (!validCountries.has(countryId)) {
      bots.delete(countryId);
      // Also remove from players map
      for (const [pid, p] of players) {
        if (p.isBot && p.countryId === countryId) {
          players.delete(pid);
          break;
        }
      }
      removed++;
    }
  }

  // Spawn bots for any country missing one
  let added = 0;
  for (const geoIdx of Object.keys(geoPixels)) {
    const countryId = String(geoIdx);
    if (!bots.has(countryId)) {
      botInit(countryId);
      added++;
      if (wasReady) startTickerFor(countryId); // start ticker individually after initial batch
    }
  }

  console.log(`[Bot] Roster: ${bots.size} bots total (${added} added, ${removed} removed)`);
  broadcastPlayers();

  if (!wasReady) startBotTickers();
}

// ── WebSocket server ──────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch (e) {
    // Malformed URL from scanner/bot — silently reject
    res.writeHead(400); res.end();
    return;
  }

  // ── Static game file (cached, compressed) ──────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const f = path.join(__dirname, 'pixelworld_v5.html');
    serveCompressedAsset(req, res, f, {
      // HTML changes per deploy; tell browser to revalidate
      'Cache-Control': 'no-cache, must-revalidate',
    });
    return;
  }

  // ── Service worker (cached, compressed) ────────────────────────
  if (url.pathname === '/sw.js') {
    const f = path.join(__dirname, 'sw.js');
    serveCompressedAsset(req, res, f, {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    });
    return;
  }

  // ── Vendored TopoJSON — compressed cache + 1 year browser cache ─
  if (url.pathname === '/countries-10m.json') {
    const f = path.join(__dirname, 'countries-10m.json');
    if (_compressedAssets.has(f)) {
      serveCompressedAsset(req, res, f, {
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return;
    }
    // Fall through to legacy path if not pre-cached (shouldn't happen)
    const fGz = f + '.gz';
    if (!fs.existsSync(f) && !fs.existsSync(fGz)) {
      res.writeHead(404); res.end('countries-10m.json not found on server');
      return;
    }
    const headers = {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    const accept = req.headers['accept-encoding'] || '';
    if (accept.includes('gzip')) {
      headers['Content-Encoding'] = 'gzip';
      // Prefer pre-compressed file (avoids gzip CPU per request)
      if (fs.existsSync(fGz)) {
        res.writeHead(200, headers);
        fs.createReadStream(fGz).pipe(res);
      } else {
        const zlib = require('zlib');
        res.writeHead(200, headers);
        fs.createReadStream(f).pipe(zlib.createGzip({ level: 9 })).pipe(res);
      }
    } else {
      res.writeHead(200, headers);
      fs.createReadStream(f).pipe(res);
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


  // ── /admin/tweets — operator-facing draft queue page ──
  if (url.pathname === '/admin/tweets') {
    const expected = process.env.TWEETS_ADMIN_SECRET;
    const key = url.searchParams.get('key');
    if (!expected) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Tweet admin disabled — set TWEETS_ADMIN_SECRET in .env');
      return;
    }
    if (key !== expected) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TWEET_ADMIN_HTML);
    return;
  }

  // ── /api/tweets — admin-only ──
  if (url.pathname.startsWith('/api/tweets')) {
    const expected = process.env.TWEETS_ADMIN_SECRET;
    if (!expected) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'admin disabled' }));
      return;
    }
    const key = url.searchParams.get('key') || (req.headers['x-admin-key'] || '');
    if (key !== expected) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tweets') {
      const status = url.searchParams.get('status');
      const filtered = status ? tweetQueue.filter(t => t.status === status) : tweetQueue;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tweets: filtered }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tweets') {
      let body = '';
      req.on('data', c => { body += c.toString(); if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const text = parsed.text;
          if (!text || typeof text !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'text required' }));
            return;
          }
          const draft = pushTweetDraft({ type: 'manual', text });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tweet: draft }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    const mutateMatch = url.pathname.match(/^\/api\/tweets\/([a-z0-9]+)\/(posted|dismissed|edit)$/);
    if (req.method === 'POST' && mutateMatch) {
      const id = mutateMatch[1], action = mutateMatch[2];
      let body = '';
      req.on('data', c => { body += c.toString(); if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        const t = tweetQueue.find(x => x.id === id);
        if (!t) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        try {
          const data = body ? JSON.parse(body) : {};
          if (action === 'edit' && data.text) t.text = String(data.text).slice(0, 280);
          else if (action === 'posted')    t.status = 'posted';
          else if (action === 'dismissed') t.status = 'dismissed';
          saveTweetQueue();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tweet: t }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown route' }));
    return;
  }

  // ── /api/world-state — public summary for the welcome popup ──
  if (url.pathname === '/api/world-state') {
    // Top 3 countries by total claimed pixel count
    const topCountries = Object.entries(countryPxCount)
      .filter(([, cnt]) => cnt > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([id, count]) => ({ id, count, name: countryNames[id] || ('Country ' + id) }));
    // Conquered country count: size of conqueredSet (each entry = "geoId:ownerId")
    // Count distinct geographic countries that are currently conquered.
    const distinctConquered = new Set();
    for (const key of conqueredSet) {
      const geoId = String(key).split(':')[0];
      distinctConquered.add(geoId);
    }
    // Top 3 players by points
    const topPlayers = [...profiles.values()]
      .filter(p => p.username && p.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 3)
      .map(p => ({
        username:    p.username,
        avatar:      p.avatar,
        points:      p.points,
        rank:        p.rank,
        country:     p.country,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      topCountries,
      conqueredCount: distinctConquered.size,
      topPlayers,
      totalPlayers:  players.size,
      totalBots:     bots.size,
    }));
    return;
  }

  // ── /api/daily-login — grant daily bonus if not yet claimed today ──
  if (url.pathname === '/api/daily-login') {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/pa_session=([a-f0-9]+)/);
    const token = m ? m[1] : null;
    const session = token ? getSession(token) : null;
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ loggedIn: false }));
      return;
    }
    const result = processDailyLogin(session.discordId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: true, ...result }));
    return;
  }

  // ── /api/stats/me — current user's stats (cookie auth) ──
  if (url.pathname === '/api/stats/me') {
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
    // Build top countries (top 5 by pixels)
    const topCountries = Object.entries(profile.topCountries || {})
      .sort(([,a],[,b]) => b - a)
      .slice(0, 5)
      .map(([id, count]) => ({ id, count, name: countryNames[id] || ('Country ' + id) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      loggedIn:      true,
      discordId:     profile.discordId,
      username:      profile.username,
      avatar:        profile.avatar,
      rank:          profile.rank,
      xp:            profile.xp,
      points:        profile.points,
      pixelsPlaced:  profile.pixelsPlaced,
      conquestsMade: profile.conquestsMade,
      countriesLost: profile.countriesLost,
      bombsDeployed: profile.bombsDeployed,
      topCountries,
      joinedAt:      profile.joinedAt,
    }));
    return;
  }

  // ── /api/stats/leaderboard — top 20 by points (public) ──
  if (url.pathname === '/api/stats/leaderboard') {
    const sorted = [...profiles.values()]
      .filter(p => p.username && p.points > 0)
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .slice(0, 20)
      .map((p, i) => ({
        rank:          i + 1,
        username:      p.username,
        avatar:        p.avatar,
        points:        p.points || 0,
        gameRank:      p.rank,
        conquestsMade: p.conquestsMade || 0,
        countryMain:   p.countryMain,
        countryMainName: p.countryMain ? (countryNames[p.countryMain] || ('Country ' + p.countryMain)) : null,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leaderboard: sorted, totalPlayers: profiles.size }));
    return;
  }

  // ── /api/alliances (public) — current alliances for client display ──
  if (url.pathname === '/api/alliances') {
    const list = [];
    for (const [key, alliance] of alliances) {
      list.push({
        key,
        countries: alliance.countries,
        memberCount: alliance.members.length,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alliances: list }));
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

  // ── /auth/update-country → sync user's chosen country back to profile ──
  if (url.pathname === '/auth/update-country' && req.method === 'POST') {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/pa_session=([a-f0-9]+)/);
    const token = m ? m[1] : null;
    const session = token ? getSession(token) : null;
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'not_logged_in' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.countryMain) { res.writeHead(400); res.end('missing countryMain'); return; }
        const profile = getProfile(session.discordId);
        profile.countryMain = String(data.countryMain);
        console.log(`[Auth] ${profile.username} → countryMain=${profile.countryMain}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end('bad request');
      }
    });
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



  // ── Bot API: shared-secret authenticated endpoints ──────────────
  const botSecret = req.headers['x-bot-secret'];
  const validBot  = botSecret && botSecret === (process.env.BOT_API_SECRET || '');

  // /api/bot/profile — get/update a player's profile by Discord ID
  if (url.pathname === '/api/bot/profile') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }

    if (req.method === 'GET') {
      const did = url.searchParams.get('discord_id');
      if (!did) { res.writeHead(400); res.end('missing discord_id'); return; }
      const profile = profiles.get(did);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(profile || null));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.discordId) { res.writeHead(400); res.end('missing discordId'); return; }
          const p = getProfile(data.discordId);
          if (data.username !== undefined)    p.username    = data.username;
          if (data.countryMain !== undefined) p.countryMain = String(data.countryMain);
          if (data.countryB !== undefined)    p.countryB    = data.countryB ? String(data.countryB) : null;
          if (data.countryC !== undefined)    p.countryC    = data.countryC ? String(data.countryC) : null;
          console.log(`[Bot] Profile updated: ${p.username} → main=${p.countryMain} b=${p.countryB} c=${p.countryC}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, profile: p }));
        } catch (e) {
          res.writeHead(400); res.end('bad request');
        }
      });
      return;
    }
  }

  // /api/bot/countries — list all available countries (for slash command autocomplete)
  if (url.pathname === '/api/bot/countries') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }
    const list = [];
    for (const geoIdx of Object.keys(geoPixels || {})) {
      list.push({ id: geoIdx, name: countryNames[geoIdx] || ('Country ' + geoIdx) });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ countries: list, mapReady }));
    return;
  }

  // /api/bot/leaderboard — top N players by points (for /leaderboard slash command)
  if (url.pathname === '/api/bot/leaderboard') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const sorted = [...profiles.values()]
      .filter(p => p.username && p.points > 0)
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .slice(0, limit)
      .map((p, i) => ({
        rank: i + 1,
        username: p.username,
        points: p.points || 0,
        gameRank: p.rank,
        conquestsMade: p.conquestsMade || 0,
        countryMain: p.countryMain,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leaderboard: sorted, totalPlayers: profiles.size }));
    return;
  }

  // /api/bot/alliances — read-only list of current alliances
  if (url.pathname === '/api/bot/alliances') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }
    const list = [];
    for (const [key, alliance] of alliances) {
      list.push({ key, countries: alliance.countries, members: alliance.members });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alliances: list }));
    return;
  }

  // /api/bot/event — bot subscribes to game events (long-polling or SSE)
  if (url.pathname === '/api/bot/events') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    botEventStreams.add(res);
    req.on('close', () => botEventStreams.delete(res));
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
        // Bind discord identity from session cookie if available
        if (msg.discordId) {
          player.discordId = String(msg.discordId);
          // Update profile username if provided
          if (msg.username) {
            const p = getProfile(player.discordId);
            p.username = msg.username;
          }
        }
        console.log(`  Player ${pid} → country ${player.countryId}`);

        // Bootstrap map data from client — always accept the latest (clients are deterministic)
        if (msg.geoTotal && Object.keys(msg.geoTotal).length > 0) {
          for (const k of Object.keys(geoTotal)) delete geoTotal[k];
          Object.assign(geoTotal, msg.geoTotal);
          recomputeTotalLand();
        }
        // Country names from client (used by bot war reporter)
        if (msg.geoNames && Object.keys(msg.geoNames).length > 0) {
          for (const k of Object.keys(countryNames)) delete countryNames[k];
          Object.assign(countryNames, msg.geoNames);
          console.log(`  geoNames: ${Object.keys(countryNames).length} country names cached`);
        }
        // featList index → real country ID mapping (geoAtPixel stores indices, not IDs)
        // featList index → real country ID mapping (geoAtPixel stores indices, not IDs)
        // Always overwrite — clients are deterministic so latest = correct
        if (msg.indexToId && typeof msg.indexToId === 'object' && Object.keys(msg.indexToId).length > 0) {
          for (const k of Object.keys(indexToId)) delete indexToId[k];
          Object.assign(indexToId, msg.indexToId);
          console.log(`  indexToId: ${Object.keys(indexToId).length} index→ID mappings cached`);
        }
        if (msg.geoPixelRuns) {
          // Reset geoAtPixel first — stale featList-index data must not mix with new country-ID data
          geoAtPixel.fill(-1);
          for (const { s, l, g } of msg.geoPixelRuns) {
            for (let i = s; i < s + l && i < MAP_PX; i++) geoAtPixel[i] = g;
          }
          if (!geoPixelReady) {
            geoPixelReady = true;
            console.log('  geoAtPixel received');
          } else {
            console.log('  geoAtPixel refreshed');
          }
        }
        if (msg.landRuns) {
          landMask.fill(0);
          for (const { s, l } of msg.landRuns) {
            for (let i = s; i < s + l && i < MAP_PX; i++) landMask[i] = 1;
          }
        }
        checkMapReady();

        ws.send(JSON.stringify({
          type: 'welcome',
          playerId: pid,
          botIds: [...bots.keys()],
          state: buildSnapshot(),
          david: buildDavidSnapshot(),
          serverVersion: SERVER_VERSION,
          nukeZones: (_pruneServerNukeZones(), _nukeZones.slice()),
        }));
        broadcastPlayers();
        break;
      }

      case 'stroke': {
        if (!player.countryId || !Array.isArray(msg.pixels)) return;
        if (msg.pixels.length > MAX_STROKE_PX) return;
        // Rate limit — clamp pixels to what the player's token bucket allows
        const allowed = consumeStrokeTokens(pid, msg.pixels.length);
        if (allowed <= 0) return; // empty bucket — drop entire stroke silently
        const limitedPixels = allowed < msg.pixels.length ? msg.pixels.slice(0, allowed) : msg.pixels;
        const { changed, conquests, reversals } = applyPixels(limitedPixels, player.countryId);
        if (changed.length) queueDelta(changed);
        // Award XP and stats to logged-in players
        if (player.discordId && changed.length) {
          updateProfileXP(player.discordId, changed.length);
          // Track stats
          const profile = getProfile(player.discordId);
          profile.points       += changed.length;
          profile.pixelsPlaced += changed.length;
          profile.lastSeen     =  Date.now();
          // Per-country pixel painting count
          for (const px of changed) {
            const geo = geoAtPixel[px.y * MAP_W + px.x];
            if (geo >= 0) {
              const cid = String(geo);
              profile.topCountries[cid] = (profile.topCountries[cid] || 0) + 1;
            }
          }
          markProfilesDirty();
        }
        conquests.forEach(c => broadcast(JSON.stringify({ type:'conquest',...c })));
        reversals.forEach(r => broadcast(JSON.stringify({ type:'reversal',...r })));
        // Conquest stats
        if (player.discordId && conquests.length) {
          updateProfileXP(player.discordId, conquests.length * 50);
          const profile = getProfile(player.discordId);
          profile.conquestsMade += conquests.length;
          profile.points        += conquests.length * 50;
          markProfilesDirty();
        }
        break;
      }

      case 'stroke-end': {
        // Sent by client on mouseup/touchend with the full stroke buffer.
        // Pixels have ALREADY been applied via per-pixel 'stroke' events.
        // We only run encirclement detection here.
        if (!player.countryId || !Array.isArray(msg.pixels)) return;
        if (msg.pixels.length < 4 || msg.pixels.length > 5000) return;
        const enc = detectEncirclement(msg.pixels, player.countryId);
        if (!enc) return;
        const encApplied = applyPixels(enc.enclosed, player.countryId);
        if (encApplied.changed.length) queueDelta(encApplied.changed);
        const bonus = getEncircleBonus(enc.count);
        encircleBonuses.set(String(player.countryId), {
          mult:      bonus.mult,
          expiresAt: Date.now() + bonus.durationMs,
        });
        try {
          if (player.ws && player.ws.readyState === 1) {
            player.ws.send(JSON.stringify({
              type:        'encirclement',
              countryId:   player.countryId,
              enclosed:    enc.count,
              mult:        bonus.mult,
              durationMs:  bonus.durationMs,
              cx:          enc.centerX,
              cy:          enc.centerY,
            }));
          }
        } catch (e) { /* silent */ }
        console.log(`[Encircle] ${player.countryId} enclosed ${enc.count}px → ${bonus.mult}× regen for ${bonus.durationMs/1000}s`);
        break;
      }

      case 'bomb': {
        if (!player.countryId) return;
        const cdKey = player.discordId || player.countryId;
        if (isBombOnCooldownServer(cdKey)) {
          console.log('[Bomb] Cooldown active for', cdKey, '— dropped');
          return;
        }
        markBombDeployed(cdKey);
        const { cx, cy, radius, bombKey } = msg;
        if (typeof cx!=='number'||typeof cy!=='number'||typeof radius!=='number') return;
        if (radius > 30) return;
        // Nuke special-case: clear pixels + create lockout zone, do NOT paint with attacker's colour
        if (bombKey === 'nuke') {
          const expiresAt = Date.now() + NUKE_LOCKOUT_MS;
          _nukeZones.push({ cx, cy, radius, expiresAt });
          const changed = clearPixelsInRadius(cx, cy, radius);
          if (changed.length) queueDelta(changed);
          // Broadcast the zone to all clients so they render the overlay + reject local paint
          broadcast(JSON.stringify({
            type: 'nuke_zone',
            cx, cy, radius, expiresAt,
          }));
          console.log('[Nuke] cleared', changed.length, 'pixels at', cx, cy, '— lockout until', new Date(expiresAt).toISOString());
          // Queue a tweet draft for the nuke detonation
          try {
            pushTweetDraft({
              type:        'nuke',
              text:        tweetForNuke(player.countryId, cx, cy),
              dedupeKey:   'nuke:' + player.countryId + ':' + Math.floor(cx/30) + ':' + Math.floor(cy/30),
              throttleKey: 'nuke_attacker:' + player.countryId,
            });
          } catch (e) { console.warn('[Tweets] nuke draft failed:', e.message); }
          // Skip the normal apply path
          break;
        }
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
        // War reporter: bomb event
        // Tier: Mortar(r<10)=1, MOAB(r<20)=2, Nuke(r>=20)=3
        const bombTier = radius < 10 ? 1 : radius < 20 ? 2 : 3;
        const bombName = radius < 10 ? 'Mortar' : radius < 20 ? 'MOAB' : 'Nuke';
        // Find primary defender — country at the bomb centre
        let defenderId = null;
        if (cx >= 0 && cx < MAP_W && cy >= 0 && cy < MAP_H) {
          const gi = geoAtPixel[cy * MAP_W + cx];
          if (gi >= 0) defenderId = geoToId(gi);
        }
        // Skip events where attacker == defender (bombing own territory)
        // Track bomb in profile stats
        if (player.discordId) {
          const profile = getProfile(player.discordId);
          profile.bombsDeployed = (profile.bombsDeployed || 0) + 1;
          markProfilesDirty();
        }
        if (defenderId !== player.countryId) {
          emitBotEvent({
            type:        'war_bomb',
            tier:        bombTier,
            bombName,
            attackerId:  player.countryId,
            defenderId,
            radius,
            timestamp:   Date.now(),
          });
        }
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
