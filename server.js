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
const SERVER_VERSION       = '2026-05-26-v68';
console.log('PixelAnnex server', SERVER_VERSION);
const MAP_W              = 2048;
const MAP_H              = 1024;
const MAP_PX             = MAP_W * MAP_H;
const CONQUEST_THRESHOLD = 0.60; // v56: lowered from 70% → 60% to match bot surrender mechanics
const MAX_STROKE_PX      = 500;
const BROADCAST_MS       = 50;    // delta broadcast debounce
const PING_MS            = 10000;
const TIMEOUT_MS         = 30000;

// ── Bot config ────────────────────────────────────────────────────
const BOT_TICK_MS         = 1000;  // v35: doubled paint rate (was 2000)
const BOT_PIXELS_PER_TICK  = 1;    // pixels per stroke per bot — halved
const BOT_BUCKET_MAX       = 60;   // smaller cap to prevent burst spikes

// ── v34: Bot activity cycle — simulates "real player" login/logout ──
// Each bot drifts between active and idle states. Only active bots paint and
// are counted in the simulated player count. The target active-bot count
// drifts slowly through the 50-200 range so the world feels alive.
const BOT_ACTIVE_MIN_MS = 5  * 60 * 1000;
const BOT_ACTIVE_MAX_MS = 30 * 60 * 1000;
const BOT_IDLE_MIN_MS   = 3  * 60 * 1000;
const BOT_IDLE_MAX_MS   = 20 * 60 * 1000;
const SIM_PLAYER_MIN    = 50;
const SIM_PLAYER_MAX    = 200;
let _simTargetActive = SIM_PLAYER_MIN + Math.floor(Math.random() * (SIM_PLAYER_MAX - SIM_PLAYER_MIN));
const _botActivity = new Map(); // countryId → { active: bool, expiresAt: number }
function _rand(min, max) { return min + Math.random() * (max - min); }
function _initBotActivity(countryId) {
  const startActive = Math.random() < 0.6;
  const dur = startActive
    ? _rand(BOT_ACTIVE_MIN_MS, BOT_ACTIVE_MAX_MS)
    : _rand(BOT_IDLE_MIN_MS,   BOT_IDLE_MAX_MS);
  _botActivity.set(countryId, { active: startActive, expiresAt: Date.now() + dur });
}
function _isBotActive(countryId) {
  const a = _botActivity.get(countryId);
  if (!a) { _initBotActivity(countryId); return _botActivity.get(countryId).active; }
  return a.active;
}
function _activeBotCount() {
  let n = 0;
  for (const a of _botActivity.values()) if (a.active) n++;
  return n;
}
function _tickBotActivity() {
  const now = Date.now();
  let currentActive = 0;
  for (const [cid, a] of _botActivity) {
    if (now >= a.expiresAt) {
      a.active = !a.active;
      a.expiresAt = now + (a.active
        ? _rand(BOT_ACTIVE_MIN_MS, BOT_ACTIVE_MAX_MS)
        : _rand(BOT_IDLE_MIN_MS,   BOT_IDLE_MAX_MS));
    }
    if (a.active) currentActive++;
  }
  // Drift target every ~3 minutes by ±10
  if (!_tickBotActivity._lastDrift || now - _tickBotActivity._lastDrift > 3 * 60 * 1000) {
    _tickBotActivity._lastDrift = now;
    _simTargetActive += Math.floor(_rand(-10, 11));
    if (_simTargetActive < SIM_PLAYER_MIN) _simTargetActive = SIM_PLAYER_MIN;
    if (_simTargetActive > SIM_PLAYER_MAX) _simTargetActive = SIM_PLAYER_MAX;
  }
  // Nudge currentActive toward target (gradual)
  const drift = _simTargetActive - currentActive;
  if (Math.abs(drift) > 8) {
    const cands = [];
    for (const [cid, a] of _botActivity) {
      if (drift > 0 && !a.active) cands.push(cid);
      else if (drift < 0 && a.active) cands.push(cid);
    }
    const flips = Math.min(cands.length, Math.floor(Math.abs(drift) / 2));
    for (let i = 0; i < flips; i++) {
      const cid = cands[Math.floor(Math.random() * cands.length)];
      const a = _botActivity.get(cid);
      a.active = (drift > 0);
      a.expiresAt = now + (a.active
        ? _rand(BOT_ACTIVE_MIN_MS, BOT_ACTIVE_MAX_MS)
        : _rand(BOT_IDLE_MIN_MS,   BOT_IDLE_MAX_MS));
    }
  }
}
setInterval(_tickBotActivity, 30 * 1000);

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
const TWEETS_MAX_KEEP   = 50;       // v39a: latest 50 only (was 500)
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
        // v39a: enforce new cap immediately on load — older drafts dropped
        if (tweetQueue.length > TWEETS_MAX_KEEP) {
          const dropped = tweetQueue.length - TWEETS_MAX_KEEP;
          tweetQueue.length = TWEETS_MAX_KEEP;
          console.log('[Tweets] Dropped', dropped, 'older drafts beyond cap of', TWEETS_MAX_KEEP);
        }
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


// v37: Sassy template pools — picked at random per event for variety
const TWITTER_HANDLE = '@PixelAnnexGame';
const DISCORD_INVITE = 'https://discord.gg/FcbzWCY2F';
const GAME_URL       = 'pixelannex.com';
function _pickSassy(pool) { return pool[Math.floor(Math.random() * pool.length)]; }
// v39a: tweet posted by @PixelAnnexGame anyway — drop the self-mention
function _suffix() { return GAME_URL + ' #PixelAnnex'; }

// CONQUEST variants — {attacker} {defender} {held}
const SASS_CONQUEST = [
  v => `🗡️ ${v.a} has conquered ${v.d}! ${v.a} now controls ${v.held} ${v.held === 1 ? 'country' : 'countries'}. ` + _suffix(),
  v => `📢 ${v.d} just got rebranded by ${v.a}. New management, same map. ` + _suffix(),
  v => `👑 ${v.a} adds ${v.d} to the collection (${v.held} total). Empire-building hours: open. ` + _suffix(),
  v => `🗺️ ${v.d} is now part of the ${v.a} extended universe. Tough day for the locals. ` + _suffix(),
  v => `⚔️ ${v.a} has annexed ${v.d}. Diplomacy was tried — briefly. ` + _suffix(),
  v => `🚩 New flag dropped: ${v.a} over ${v.d}. ${v.held} down. ` + _suffix(),
];

// REVERSAL variants — {victim} {oppressor}
const SASS_REVERSAL = [
  v => `🛡️ ${v.v} has liberated itself from ${v.o}! The resistance prevails. ` + _suffix(),
  v => `🔥 ${v.v} just kicked ${v.o} to the curb. Liberation tastes sweet. ` + _suffix(),
  v => `📢 Plot twist: ${v.v} is back. ${v.o} loses the chokehold. ` + _suffix(),
  v => `✊ ${v.v} reclaimed itself. ${v.o} is going to need a moment. ` + _suffix(),
];

// NUKE variants — {attacker} {target}
const SASS_NUKE = [
  v => `☢️ ${v.a} just nuked ${v.target}. No-paint zone active for 2 minutes. ` + _suffix(),
  v => `💥 ${v.a} chose violence. ${v.target} is a smoking crater. ` + _suffix(),
  v => `🚨 BREAKING: ${v.a} went nuclear on ${v.target}. Literally. ` + _suffix(),
  v => `☢️ Diplomatic resolution attempted via ${v.a}'s nuke at ${v.target}. ` + _suffix(),
  v => `☢️ ${v.a} fired off a nuke at ${v.target}. The 2-minute lockout will give everyone time to reflect. ` + _suffix(),
];

// MULTI-ATTACK variants — {n} {defender} {attackers}
const SASS_MULTI = [
  v => `🚨 ${v.n} countries are attacking ${v.d}! (${v.atk}) ` + _suffix(),
  v => `📢 Wow, some countries really don't like ${v.d}! ${v.n} attackers piling on: ${v.atk}. ` + _suffix(),
  v => `🔥 ${v.d} is hosting an uninvited party. ${v.n} RSVPs: ${v.atk}. ` + _suffix(),
  v => `⚠️ Today's group project subject: ${v.d}. ${v.n} contributors: ${v.atk}. ` + _suffix(),
  v => `🚨 ${v.n}-on-1 right now against ${v.d}. (${v.atk}) Reinforcements?? ` + _suffix(),
];

// ADMIRAL promotion variants — {username} {country?}
const SASS_ADMIRAL = [
  v => `🎖️ ${v.user} has reached ADMIRAL${v.country ? ' (' + v.country + ')' : ''}! Nukes unlocked. ☢️ ` + _suffix(),
  v => `🌟 New Admiral: ${v.user}${v.country ? ' of ' + v.country : ''}. The nuke codes have been handed over. ` + _suffix(),
  v => `⭐ ${v.user} is now ADMIRAL${v.country ? ' (' + v.country + ')' : ''}. May they use the nukes responsibly. (They won't.) ` + _suffix(),
];

// DAILY SUMMARY variants — {lines} {conquered}
const SASS_DAILY = [
  v => `🌍 World Snapshot · ${v.lines} · ${v.conquered} countries conquered. ` + _suffix(),
  v => `📊 Daily standings: ${v.lines}. ${v.conquered} countries currently under foreign rule. ` + _suffix(),
  v => `🌍 Today's top dogs: ${v.lines}. ${v.conquered} conquests on the board. ` + _suffix(),
];

// COMMUNITY tweet — periodic standalone
const SASS_COMMUNITY = [
  () => `🌍 PixelAnnex is a real-time pixel-conquest world map. 240+ countries, live multiplayer. Join the Discord: ${DISCORD_INVITE} · Play: ${GAME_URL} #PixelAnnex`,
  () => `🚨 Conquering the world, one pixel at a time. Join the Discord for war updates + alliance plays: ${DISCORD_INVITE} · ${GAME_URL} #PixelAnnex`,
  () => `🎖️ Climb the ranks. Drop nukes. Form alliances. PixelAnnex is live: ${GAME_URL} · Community: ${DISCORD_INVITE} #PixelAnnex`,
  () => `🗺️ Today on PixelAnnex: same map, fresh chaos. ${GAME_URL} · ${DISCORD_INVITE} #PixelAnnex`,
];

// WORLD STATUS REPORT — {leader, leaderPx, conquered, allianceLine}
const SASS_STATUS_REPORT = [
  v => `📊 Standings: ${v.leader} leads with ${v.leaderPx.toLocaleString()} pixels · ${v.conquered} countries conquered · ${v.allianceLine}${GAME_URL} #PixelAnnex`,
  v => `🌍 World intel: ${v.leader} on top (${v.leaderPx.toLocaleString()} px). ${v.allianceLine}${v.conquered} nations under occupation. ${GAME_URL} #PixelAnnex`,
  v => `🗺️ Pixel report: ${v.leader} controls the board (${v.leaderPx.toLocaleString()} px). ${v.allianceLine}${v.conquered} countries conquered. ${GAME_URL} #PixelAnnex`,
];

// TOP PLAYERS 24H — {lines}
const SASS_TOP_PLAYERS = [
  v => `🏆 Most active players (24h): ${v.lines}. Top spot is up for grabs: ${GAME_URL} #PixelAnnex`,
  v => `🎖️ Pixel warriors (last 24h): ${v.lines}. ${GAME_URL} #PixelAnnex`,
  v => `🔥 24h leaderboard: ${v.lines}. Get in the game: ${GAME_URL} #PixelAnnex`,
];

// MOST ACTIVE COUNTRIES 24H — {lines}
const SASS_ACTIVE_COUNTRIES = [
  v => `⚔️ Most active countries (24h): ${v.lines}. Join the fight: ${GAME_URL} #PixelAnnex`,
  v => `🎨 Hottest territories today: ${v.lines}. Where does your country rank? ${GAME_URL} #PixelAnnex`,
  v => `🌍 Activity report: ${v.lines}. ${GAME_URL} #PixelAnnex`,
];

// NEWS variants — {country} {headline}
const SASS_NEWS = [
  v => `📰 Real-world update on ${v.country}: "${v.headline}". How will this play out in PixelAnnex? ` + _suffix(),
  v => `🌍 ${v.country} in the headlines: "${v.headline}". Watching how it shapes the game. ` + _suffix(),
  v => `📰 ${v.country}: "${v.headline}". Real-world stakes, pixel-world consequences. ` + _suffix(),
];

// ── Geopolitical context table ────────────────────────────────────────────────
// Key: 'attackerISOnum:defenderISOnum'  (ISO 3166-1 numeric, as strings)
// When a conquest matches a known hot-spot, pick one of these instead of the
// generic SASS_CONQUEST pool.  Falls back to generic if no match.
const GEO_CONTEXT = {
  // ── USA (840) ──────────────────────────────────────────────────────────
  '840:364': [ // USA → Iran
    () => `🛢️ USA trying to open the Strait of Hormuz... with pixels?! Iran is not impressed. ` + _suffix(),
    () => `🗡️ Washington just switched from JCPOA to pixel diplomacy. It's not subtle. ` + _suffix(),
    () => `☢️ US pixel sanctions now extend to Iran's entire colour palette. Tehran responds with 240 militia bots. ` + _suffix(),
  ],
  '364:840': [ // Iran → USA
    () => `🕌 Iran pixels the Great Satan. The ayatollah is posting about it. ` + _suffix(),
    () => `🇮🇷 Tehran claims pixel sovereignty over Washington DC. This is unprecedented. ` + _suffix(),
    () => `☢️ Iran crosses the Atlantic — in pixels. CENTCOM is filing a strongly-worded pixel. ` + _suffix(),
  ],
  '840:156': [ // USA → China
    () => `🇺🇸 US pixel tariffs hit China. 145% surcharge on every painted square. ` + _suffix(),
    () => `💻 US-China pixel war escalates. TikTok ban now extends to map tiles. ` + _suffix(),
    () => `🛸 America repaints China red — wait, China's already red. ` + _suffix(),
  ],
  '156:840': [ // China → USA
    () => `🐉 China conquers America on a pixel map. First the chips, now the pixels. ` + _suffix(),
    () => `🇨🇳 Beijing paints over Washington. Wall Street is nervously refreshing. ` + _suffix(),
    () => `🏴 China claims the continental US. Trade war: now with territorial gains. ` + _suffix(),
  ],
  '840:643': [ // USA → Russia
    () => `🗽 American pixel division advances into Russia. Sanctions mode: now includes colour palette. ` + _suffix(),
    () => `🇺🇸 USA pixels into Russia. NATO's 2D eastern flank: secured. ` + _suffix(),
  ],
  '643:840': [ // Russia → USA
    () => `🐻 Russian pixel bear hug reaches Washington. NATO Article 5 says nothing about 2D maps. ` + _suffix(),
    () => `🇷🇺 Russia conquers America — in pixels. The pixel split negotiations begin. ` + _suffix(),
  ],
  '840:484': [ // USA → Mexico
    () => `🇺🇸 USA pixels into Mexico. The pixel deportation flights are already inbound. ` + _suffix(),
    () => `🌮 Washington paints south of the border. The pixel wall couldn't keep them in. ` + _suffix(),
  ],
  '484:840': [ // Mexico → USA
    () => `🌮 Mexico pixels across the border. The pixel wall couldn't stop them either. ` + _suffix(),
    () => `🇲🇽 Mexico takes the fight north. Pixel by pixel. ` + _suffix(),
  ],
  // ── Russia (643) ───────────────────────────────────────────────────────
  '643:804': [ // Russia → Ukraine
    () => `🇷🇺 Russia advances on Ukraine — again. Zelensky is typing... ` + _suffix(),
    () => `🚀 Pixel blitzkrieg in Ukraine. Someone call NATO. ` + _suffix(),
    () => `🌻 Eastern Ukraine just turned Russian pixels. The ICC is watching. ` + _suffix(),
    () => `🛡️ Russia pushes to the Dnipro — one pixel at a time. ` + _suffix(),
  ],
  '804:643': [ // Ukraine → Russia
    () => `🇺🇦 Ukraine counter-pixels into Russia! The Kursk offensive: now in 2D. ` + _suffix(),
    () => `⚡ Zelensky pixel update: Ukraine is winning on the map at least. ` + _suffix(),
    () => `🌻 Ukraine strikes deep into Russian territory. One pixel at a time. ` + _suffix(),
  ],
  '643:246': [ // Russia → Finland
    () => `🇷🇺 Russia pixels toward Finland. NATO's newest member: fully activated. ` + _suffix(),
    () => `🌲 Russia eyes the Finnish border — in pixels. Helsinki is not amused. ` + _suffix(),
  ],
  '643:616': [ // Russia → Poland
    () => `🇷🇺 Russia pixels into Poland. Article 5 is sweating. ` + _suffix(),
    () => `🏰 Russia crosses into Poland on the pixel map. Warsaw is calling an emergency session. ` + _suffix(),
  ],
  '643:233': [ // Russia → Estonia
    () => `🇷🇺 Russia pixels Estonia. The smallest NATO member, the biggest pixel problem. ` + _suffix(),
  ],
  '643:428': [ // Russia → Latvia
    () => `🇷🇺 Russian pixels reach Latvia. The Baltics are speed-dialling Brussels. ` + _suffix(),
  ],
  '643:440': [ // Russia → Lithuania
    () => `🇷🇺 Russia pixels into Lithuania, cutting off the Suwałki corridor — in 2D. ` + _suffix(),
  ],
  // ── China (156) ────────────────────────────────────────────────────────
  '156:158': [ // China → Taiwan
    () => `🇨🇳 China achieves pixel reunification with Taiwan. Xi counted those pixels twice. ` + _suffix(),
    () => `🎆 One China Policy: now enforced in pixel form. TSMC pixel fabs at risk. ` + _suffix(),
    () => `⚓ PLA pixel flotilla encircles Taiwan. The semiconductor supply chain: concerned. ` + _suffix(),
  ],
  '158:156': [ // Taiwan → China
    () => `🇹🇼 Taiwan says: "We paint our own pixels." Beijing: "No you don't." ` + _suffix(),
    () => `🗽 Taiwan takes the fight to the mainland! Pixel independence movement: real. ` + _suffix(),
  ],
  '156:608': [ // China → Philippines
    () => `🇨🇳 China repaints the West Philippine Sea — one pixel at a time. Manila sends a pixel coast guard. ` + _suffix(),
    () => `⛵ Second Thomas Shoal, Second Pixel Shoal. China pixels over the Philippines again. ` + _suffix(),
  ],
  '608:156': [ // Philippines → China
    () => `🇵🇭 Philippines reclaims South China Sea pixels. Manila 1 – Beijing 0. ` + _suffix(),
    () => `⚓ Philippine coast guard pixels back. BRP Sierra Madre: holding. ` + _suffix(),
  ],
  '156:356': [ // China → India
    () => `🏔️ China pixels over the Galwan Valley — again. LAC tensions: pixel edition. ` + _suffix(),
    () => `🇨🇳 PLA pixels across the Line of Actual Control. New Delhi is fuming. ` + _suffix(),
  ],
  '356:156': [ // India → China
    () => `🇮🇳 India pushes back along the LAC — pixel by pixel. ` + _suffix(),
    () => `🏔️ India reclaims the border ridge — in 2D. Doklam: re-pixelated. ` + _suffix(),
  ],
  '156:704': [ // China → Vietnam
    () => `🐉 China pixels into Vietnam's EEZ. Hanoi files a strongly-worded pixel protest. ` + _suffix(),
  ],
  // ── Middle East ────────────────────────────────────────────────────────
  '376:275': [ // Israel → Palestine
    () => `🇮🇱 Israel expands the pixel buffer zone. Ceasefire negotiations: paused. ` + _suffix(),
    () => `🕍 IDF pixel operation launched. Ground offensive starts at row 512. ` + _suffix(),
  ],
  '275:376': [ // Palestine → Israel
    () => `🕌 Palestine reclaims pixels. Resistance in 2D. ` + _suffix(),
  ],
  '376:364': [ // Israel → Iran
    () => `🇮🇱 Israel skips the proxies and goes direct on Iran. Mossad pixel division: active. ` + _suffix(),
    () => `✡️ Israeli strikes reach Tehran — in 2D. F-35 pixel squadron deployed. ` + _suffix(),
  ],
  '364:376': [ // Iran → Israel
    () => `🇮🇷 Iran fires pixel ballistic missiles at Israel. Iron Dome: bricked on a 2D map. ` + _suffix(),
    () => `🕌 Iran goes direct on Israel, skipping the proxies. Pixel war: escalated. ` + _suffix(),
  ],
  '682:887': [ // Saudi Arabia → Yemen
    () => `🇸🇦 Saudi pixel coalition strikes Yemen. Houthi pixel drones already inbound. ` + _suffix(),
    () => `✈️ Saudi airstrikes go digital. Red Sea pixel shipping: disrupted. ` + _suffix(),
  ],
  '887:682': [ // Yemen (Houthis) → Saudi Arabia
    () => `⚓ Houthis pixel-strike Saudi Arabia. Red Sea routes: somehow even more disrupted. ` + _suffix(),
    () => `🚀 Yemen fires pixel cruise missiles at Riyadh. ARAMCO is watching nervously. ` + _suffix(),
  ],
  '887:376': [ // Yemen → Israel
    () => `🚀 Houthis launch pixels at Israel. Iron Dome intercepts 94% of them. ` + _suffix(),
  ],
  // ── South Asia ─────────────────────────────────────────────────────────
  '356:586': [ // India → Pakistan
    () => `🇮🇳 India pixels across the Line of Control. The pixel Kashmir dispute: heated. ` + _suffix(),
    () => `🏔️ Two nuclear neighbours settle it on the pixel map. Bold. ` + _suffix(),
    () => `🇮🇳 India launches pixel strikes into Pakistan. Operation Sindoor: 2D edition. ` + _suffix(),
  ],
  '586:356': [ // Pakistan → India
    () => `🇵🇰 Pakistan crosses the LoC in pixel form. India responds with 1.4 billion pixels of disapproval. ` + _suffix(),
    () => `✈️ PAF pixel jets cross into India. New Delhi: not having it. ` + _suffix(),
  ],
  // ── Korean Peninsula ───────────────────────────────────────────────────
  '408:410': [ // North Korea → South Korea
    () => `🇰🇵 Kim Jong-un crosses the pixel DMZ! The sirens are very confused. ` + _suffix(),
    () => `💣 DPRK pixel strike on the South. K-pop plays louder in response. ` + _suffix(),
    () => `🪖 North Korea activates the pixel artillery. Seoul: refreshing the PixelAnnex tab anxiously. ` + _suffix(),
  ],
  '410:408': [ // South Korea → North Korea
    () => `🇰🇷 South Korea pixels into the North. Pyongyang is not logging it in state media. ` + _suffix(),
    () => `📺 ROK pushes past the DMZ in 2D. Kim Jong-un: very displeased. ` + _suffix(),
  ],
  // ── Europe ─────────────────────────────────────────────────────────────
  '792:300': [ // Turkey → Greece
    () => `🇹🇷 Turkey pixels into Greek airspace. Greece calls it a violation. Erdoğan: "It's fine." ` + _suffix(),
    () => `🏛️ Aegean dispute goes pixel. Turkey and Greece fight over 2D islands now. ` + _suffix(),
  ],
  '300:792': [ // Greece → Turkey
    () => `🇬🇷 Greece pixels back at Turkey. The Aegean dispute has entered its 2D phase. ` + _suffix(),
  ],
  '688:383': [ // Serbia → Kosovo
    () => `🇷🇸 Serbia pixels over Kosovo. Pristina does not recognise this conquest. ` + _suffix(),
  ],
  '383:688': [ // Kosovo → Serbia
    () => `🇽🇰 Kosovo pixels into Serbia. Belgrade is calling an emergency session. ` + _suffix(),
  ],
  '31:51': [ // Azerbaijan → Armenia
    () => `🇦🇿 Azerbaijan pixels over Armenia. Nagorno-Karabakh is now just a pixel. ` + _suffix(),
    () => `🏔️ Baku advances — again. The pixel Caucasus: contested. ` + _suffix(),
  ],
  '51:31': [ // Armenia → Azerbaijan
    () => `🇦🇲 Armenia reclaims Karabakh pixels. The resistance continues in 2D. ` + _suffix(),
  ],
  // ── Americas ───────────────────────────────────────────────────────────
  '826:32': [ // UK → Argentina
    () => `🇬🇧 Britain repaints the Falklands again. Argentina is already writing a strongly-worded pixel protest. ` + _suffix(),
    () => `⚓ UK pixels the South Atlantic. Las Malvinas discourse: reignited. ` + _suffix(),
  ],
  '32:826': [ // Argentina → UK
    () => `🇦🇷 Argentina claims Las Malvinas in pixel form. The Falklands War: rebooted. ` + _suffix(),
    () => `🇦🇷 Milei launches a pixel offensive on the Falklands. Thatcher could not be reached for comment. ` + _suffix(),
  ],
  '862:170': [ // Venezuela → Colombia
    () => `🇻🇪 Venezuela pixels into Colombia. Maduro calls it a "Bolivarian pixel operation." ` + _suffix(),
  ],
  // ── Africa ─────────────────────────────────────────────────────────────
  '231:232': [ // Ethiopia → Eritrea
    () => `🇪🇹 Ethiopia and Eritrea — back at it again, this time in pixel form. ` + _suffix(),
  ],
  '504:12': [ // Morocco → Algeria
    () => `🇲🇦 Morocco pixels into Algeria. The Western Sahara dispute: going regional. ` + _suffix(),
  ],
};

// Returns a context-aware sassy string for a conquest pair, or null if no match.
function _geoContextSassy(attackerId, defenderId) {
  const pool = GEO_CONTEXT[String(attackerId) + ':' + String(defenderId)];
  if (!pool || !pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)]();
}

function tweetForConquest(attackerId, defenderGeoId) {
  const a = _countryName(attackerId);
  const d = _countryName(defenderGeoId);
  const contextual = _geoContextSassy(attackerId, defenderGeoId);
  if (contextual) return contextual;
  let conquestsHeld = 0;
  for (const key of conqueredSet) {
    const parts = String(key).split(':');
    if (parts[1] === String(attackerId)) conquestsHeld++;
  }
  return _pickSassy(SASS_CONQUEST)({ a, d, held: conquestsHeld });
}

function tweetForReversal(victimId, oppressorId) {
  return _pickSassy(SASS_REVERSAL)({
    v: _countryName(victimId),
    o: _countryName(oppressorId),
  });
}

function tweetForNuke(attackerId, cx, cy) {
  const i = cy * MAP_W + cx;
  const geoId = (i >= 0 && i < geoAtPixel.length) ? geoAtPixel[i] : -1;
  const targetName = geoId >= 0 ? _countryName(String(geoId)) : 'open territory';
  return _pickSassy(SASS_NUKE)({ a: _countryName(attackerId), target: targetName });
}

function tweetForDailySummary() {
  const top = Object.entries(countryPxCount)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  if (!top.length) return null;
  const distinctConquered = new Set();
  for (const key of conqueredSet) distinctConquered.add(String(key).split(':')[0]);
  const lines = top.map(([id, c], i) => `${i + 1}. ${_countryName(id)} (${c.toLocaleString()} px)`).join(' · ');
  return _pickSassy(SASS_DAILY)({ lines, conquered: distinctConquered.size });
}

function tweetForAdmiralPromotion(username, countryId) {
  return _pickSassy(SASS_ADMIRAL)({
    user: username,
    country: countryId ? _countryName(countryId) : null,
  });
}

// v37: news + community templates
function tweetForNews(countryName, headline) {
  return _pickSassy(SASS_NEWS)({ country: countryName, headline });
}
function tweetForCommunity() {
  return _pickSassy(SASS_COMMUNITY)();
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

// ── v65: Rolling 24h activity tracker (hourly buckets) ───────────
// Tracks pixels painted by human players per-player and per-country.
// Used for status reports: top players (24h), most active countries (24h).
const _playerHourly  = new Map(); // discordId → Map(hourKey → count)
const _countryHourly = new Map(); // countryId → Map(hourKey → count)

function _recordActivity(discordId, countryId, pixelCount) {
  const hour = Math.floor(Date.now() / 3600000);
  const addBucket = (map, key) => {
    if (!map.has(key)) map.set(key, new Map());
    const b = map.get(key);
    b.set(hour, (b.get(hour) || 0) + pixelCount);
    for (const [h] of b) if (h < hour - 25) b.delete(h); // keep 25h
  };
  if (discordId) addBucket(_playerHourly, discordId);
  if (countryId) addBucket(_countryHourly, String(countryId));
}

function _get24hCount(buckets) {
  const cutoff = Math.floor(Date.now() / 3600000) - 24;
  let sum = 0;
  for (const [h, c] of buckets) if (h > cutoff) sum += c;
  return sum;
}

// ── v65: World status report ─────────────────────────────────────
// Builds a snapshot of current world standings for tweets + Discord.
function _buildWorldStatus() {
  // Top countries by current pixel count
  const topByPx = Object.entries(countryPxCount)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([id, px]) => ({ id, name: _countryName(id), px }));

  // Top alliances by combined pixel count
  const allianceRanks = [];
  for (const [key, ally] of alliances) {
    const totalPx = ally.countries.reduce((s, c) => s + (countryPxCount[String(c)] || 0), 0);
    if (totalPx > 0) allianceRanks.push({ key, names: ally.countries.map(c => _countryName(c)), totalPx });
  }
  allianceRanks.sort((a, b) => b.totalPx - a.totalPx);

  // Conquests per country + total countries under foreign rule
  const conquestsByCountry = {};
  const conqueredGeos = new Set();
  for (const key of conqueredSet) {
    const parts = String(key).split(':');
    const aid = parts[1];
    if (aid) conquestsByCountry[aid] = (conquestsByCountry[aid] || 0) + 1;
    if (parts[0]) conqueredGeos.add(parts[0]);
  }
  const topByConquests = Object.entries(conquestsByCountry)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([id, n]) => ({ id, name: _countryName(id), conquests: n }));

  // Top players 24h (human players with discordId)
  const topPlayers24h = [..._playerHourly.entries()]
    .map(([dId, buckets]) => {
      const p = profiles.get(dId);
      return { username: p?.username || '?', px24h: _get24hCount(buckets) };
    })
    .filter(e => e.px24h > 0 && e.username !== '?')
    .sort((a, b) => b.px24h - a.px24h)
    .slice(0, 10);

  // Most active countries 24h (by human player painting activity)
  const topCountries24h = [..._countryHourly.entries()]
    .map(([cId, buckets]) => ({ id: cId, name: _countryName(cId), px24h: _get24hCount(buckets) }))
    .filter(e => e.px24h > 0)
    .sort((a, b) => b.px24h - a.px24h)
    .slice(0, 5);

  return { topByPx, allianceRanks, topByConquests, topPlayers24h, topCountries24h, totalConquered: conqueredGeos.size };
}

// Emit a full standings report (country leaders + alliance leaders + conquests)
function _emitStatusReport() {
  const s = _buildWorldStatus();
  if (!s.topByPx.length) return;

  const leader  = s.topByPx[0];
  const topAlly = s.allianceRanks[0];
  const allianceLine = topAlly
    ? `Alliance lead: ${topAlly.names.slice(0, 3).join('+')}${topAlly.names.length > 3 ? '+' + (topAlly.names.length - 3) + ' more' : ''} (${topAlly.totalPx.toLocaleString()} px combined). `
    : '';

  // Discord — rich multi-section embed
  const topPxLines      = s.topByPx.slice(0, 5).map((c, i) => `${i + 1}. **${c.name}** — ${c.px.toLocaleString()} px`).join('\n');
  const conquestLines   = s.topByConquests.slice(0, 3).map((c, i) => `${i + 1}. **${c.name}** — ${c.conquests} countries`).join('\n');
  const allyBlock       = topAlly ? `\n🤝 **Alliance Leaders**\n${topAlly.names.slice(0, 4).join(' + ')} — ${topAlly.totalPx.toLocaleString()} px combined` : '';
  const discordText = [
    `🗺️ **Top Countries by Pixels**\n${topPxLines}`,
    allyBlock,
    conquestLines ? `\n⚔️ **Top Conquerors**\n${conquestLines}` : '',
    `\n${s.totalConquered} countries currently under foreign rule · [Play now](${GAME_URL})`,
  ].filter(Boolean).join('');

  emitBotEvent({ type: 'world_status_report', tier: 1, timestamp: Date.now(), sassyText: discordText });

  // Tweet — compact version
  pushTweetDraft({
    type:      'status_report',
    text:      _pickSassy(SASS_STATUS_REPORT)({ leader: leader.name, leaderPx: leader.px, conquered: s.totalConquered, allianceLine }),
    dedupeKey: 'status_report:' + Math.floor(Date.now() / (6 * 3600000)),
  });
}

// Emit an activity report (top players 24h + most active countries 24h)
function _emitActiveReport() {
  const s = _buildWorldStatus();

  // Tweet — top players
  if (s.topPlayers24h.length >= 2) {
    const lines = s.topPlayers24h.slice(0, 5)
      .map((p, i) => `${i + 1}. ${p.username} (${p.px24h.toLocaleString()} px)`).join(' · ');
    pushTweetDraft({
      type:      'top_players',
      text:      _pickSassy(SASS_TOP_PLAYERS)({ lines }),
      dedupeKey: 'top_players:' + Math.floor(Date.now() / (6 * 3600000)),
    });
  }

  // Tweet — most active countries
  if (s.topCountries24h.length >= 2) {
    const lines = s.topCountries24h.slice(0, 5)
      .map((c, i) => `${i + 1}. ${c.name} (${c.px24h.toLocaleString()} px)`).join(' · ');
    pushTweetDraft({
      type:      'active_countries',
      text:      _pickSassy(SASS_ACTIVE_COUNTRIES)({ lines }),
      dedupeKey: 'active_countries:' + Math.floor(Date.now() / (6 * 3600000)),
    });
  }

  // Discord — combined active report
  const playerLines  = s.topPlayers24h.slice(0, 10).map((p, i) => `${i + 1}. **${p.username}** — ${p.px24h.toLocaleString()} px`).join('\n');
  const countryLines = s.topCountries24h.slice(0, 5).map((c, i) => `${i + 1}. **${c.name}** — ${c.px24h.toLocaleString()} px`).join('\n');
  if (!playerLines && !countryLines) return;

  const discordText = [
    playerLines  ? `🏆 **Most Active Players (24h)**\n${playerLines}` : '',
    countryLines ? `\n🎨 **Most Active Countries (24h)**\n${countryLines}` : '',
    `\n[Play at PixelAnnex](${GAME_URL})`,
  ].filter(Boolean).join('');

  emitBotEvent({ type: 'world_status_report', tier: 1, timestamp: Date.now(), sassyText: discordText });
}

// Fire at 0:00, 6:00, and 18:00 UTC (12:00 is the existing daily summary)
function scheduleStatusReports() {
  const REPORT_HOURS = [0, 6, 18]; // UTC hours

  function _scheduleNext() {
    const now      = new Date();
    const nowHour  = now.getUTCHours() + now.getUTCMinutes() / 60;
    let   nextHour = REPORT_HOURS.find(h => h > nowHour) ?? (REPORT_HOURS[0] + 24);
    const next     = new Date(now);
    if (nextHour >= 24) { next.setUTCDate(next.getUTCDate() + 1); nextHour -= 24; }
    next.setUTCHours(nextHour, 5, 0, 0); // :05 past the hour to avoid collisions
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

    setTimeout(() => {
      const h = new Date().getUTCHours();
      if (h === 6) _emitActiveReport();  // 6:00 UTC — player/country activity
      else         _emitStatusReport();  // 0:00 & 18:00 UTC — standings
      _scheduleNext();
    }, next - now);
    console.log('[Status] Next report at', next.toISOString());
  }

  _scheduleNext();
}

scheduleStatusReports();

// ── v37: Daily news scraper ──────────────────────────────────────
// Pulls BBC World News RSS once per day, matches headlines against game
// country names, and queues up to 3 topical tweet drafts. No external API
// keys required — RSS is public.
const NEWS_FEED_URLS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.npr.org/1004/rss.xml',          // NPR World
  'https://rss.cnn.com/rss/edition_world.rss',
];
const NEWS_MAX_DRAFTS  = 3;
const NEWS_SCRAPE_MS   = 24 * 60 * 60 * 1000; // daily

// Lazy-built map of (lowercased name → country id) for keyword matching.
// Includes some demonyms / alternate names for common countries.
let _newsCountryAliases = null;
function _buildNewsCountryAliases() {
  const m = new Map();
  const ALTS = {
    '840': ['us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'america', 'americans'],
    '826': ['uk', 'u.k.', 'britain', 'british', 'england', 'english', 'scotland', 'wales'],
    '643': ['russia', 'russian'],
    '156': ['china', 'chinese'],
    '276': ['germany', 'german'],
    '250': ['france', 'french'],
    '356': ['india', 'indian'],
    '392': ['japan', 'japanese'],
    '410': ['korea', 'south korea', 'korean'],
    '410.n': ['north korea'],   // not a real id; placeholder
    '408': ['north korea', 'dprk'],
    '124': ['canada', 'canadian'],
    '036': ['australia', 'australian', 'aussie'],
    '076': ['brazil', 'brazilian'],
    '484': ['mexico', 'mexican'],
    '380': ['italy', 'italian'],
    '724': ['spain', 'spanish'],
    '792': ['turkey', 'turkish'],
    '364': ['iran', 'iranian'],
    '368': ['iraq', 'iraqi'],
    '376': ['israel', 'israeli'],
    '275': ['palestine', 'palestinian', 'gaza'],
    '682': ['saudi arabia', 'saudi'],
    '784': ['uae', 'emirates'],
    '818': ['egypt', 'egyptian'],
    '710': ['south africa'],
    '566': ['nigeria', 'nigerian'],
    '404': ['kenya'],
    '231': ['ethiopia'],
    '352': ['iceland'],
    '372': ['ireland', 'irish'],
    '528': ['netherlands', 'dutch'],
    '056': ['belgium', 'belgian'],
    '208': ['denmark', 'danish'],
    '578': ['norway', 'norwegian'],
    '752': ['sweden', 'swedish'],
    '246': ['finland', 'finnish'],
    '616': ['poland', 'polish'],
    '300': ['greece', 'greek'],
    '320': ['guatemala'],
    '702': ['singapore'],
    '764': ['thailand', 'thai'],
    '704': ['vietnam', 'vietnamese'],
    '360': ['indonesia', 'indonesian'],
    '608': ['philippines', 'filipino'],
    '586': ['pakistan', 'pakistani'],
    '050': ['bangladesh'],
    '004': ['afghanistan', 'afghan'],
    '760': ['syria', 'syrian'],
    '422': ['lebanon', 'lebanese'],
    '400': ['jordan'],
    '887': ['yemen'],
    '634': ['qatar'],
    '414': ['kuwait'],
    '716': ['zimbabwe'],
    '858': ['uruguay'],
    '600': ['paraguay'],
    '604': ['peru', 'peruvian'],
    '152': ['chile', 'chilean'],
    '032': ['argentina', 'argentine', 'argentinian'],
    '170': ['colombia', 'colombian'],
    '862': ['venezuela', 'venezuelan'],
    '218': ['ecuador'],
    '068': ['bolivia'],
    '188': ['costa rica'],
    '192': ['cuba', 'cuban'],
    '214': ['dominican republic'],
    '320.h': ['haiti'],
    '332': ['haiti', 'haitian'],
    '388': ['jamaica'],
    '780': ['trinidad'],
  };
  // First add the full official names from countryNames
  for (const [id, name] of Object.entries(countryNames || {})) {
    if (typeof name === 'string' && name.length > 2) m.set(name.toLowerCase(), id);
  }
  // Then overlay the aliases
  for (const [id, names] of Object.entries(ALTS)) {
    for (const n of names) m.set(n, id.split('.')[0]);
  }
  return m;
}

// Minimal RSS parser — just <title> and <description> inside <item>
function _parseRSSItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkMatch  = block.match(/<link>([\s\S]*?)<\/link>/);
    if (titleMatch) {
      let title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
      // Limit headline length to keep tweet under 280 chars
      if (title.length > 140) title = title.slice(0, 137) + '…';
      items.push({
        title,
        link: linkMatch ? linkMatch[1].trim() : null,
      });
    }
  }
  return items;
}

async function _scrapeNewsAndQueue() {
  if (!_newsCountryAliases) _newsCountryAliases = _buildNewsCountryAliases();
  const UA = 'Mozilla/5.0 (compatible; PixelAnnexBot/1.0; +https://pixelannex.com)';
  let xml = null;
  let usedUrl = null;
  for (const url of NEWS_FEED_URLS) {
    try {
      console.log('[News] Trying feed:', url);
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8' } });
      if (res.ok) {
        xml = await res.text();
        usedUrl = url;
        break;
      } else {
        console.warn('[News]', url, 'returned', res.status);
      }
    } catch (e) {
      console.warn('[News]', url, 'fetch error:', e.message);
    }
  }
  if (!xml) { console.warn('[News] all feeds failed; skipping'); return; }
  try {
    console.log('[News] Using feed:', usedUrl);
    const items = _parseRSSItems(xml);
    console.log('[News] Parsed', items.length, 'items');

    // Score items: prefer those mentioning a game country
    const matched = [];
    for (const it of items) {
      const lc = it.title.toLowerCase();
      for (const [alias, countryId] of _newsCountryAliases) {
        if (lc.includes(alias)) {
          // Take canonical name from countryNames for display
          const displayName = countryNames[countryId] || alias.replace(/\b\w/g, c => c.toUpperCase());
          matched.push({ headline: it.title, countryId, countryName: displayName });
          break;
        }
      }
      if (matched.length >= NEWS_MAX_DRAFTS) break;
    }
    console.log('[News] Matched', matched.length, 'country-relevant headlines');
    for (const m of matched) {
      pushTweetDraft({
        type:      'news',
        text:      tweetForNews(m.countryName, m.headline),
        dedupeKey: 'news:' + m.headline.slice(0, 60),
      });
    }
  } catch (e) {
    console.warn('[News] scrape failed:', e.message);
  }
}

// Run once on boot (delayed) + then once per day
setTimeout(_scrapeNewsAndQueue, 90 * 1000); // 90s after start (let map data settle)
setInterval(_scrapeNewsAndQueue, NEWS_SCRAPE_MS);

// ── v37: Community tweet scheduler — every 24h ────────────────────
setInterval(() => {
  pushTweetDraft({
    type:      'community',
    text:      tweetForCommunity(),
    dedupeKey: 'community:' + Math.floor(Date.now() / NEWS_SCRAPE_MS),
  });
  console.log('[Community] Daily community tweet queued');
}, NEWS_SCRAPE_MS);
// Also schedule one within 5 minutes of boot
setTimeout(() => {
  pushTweetDraft({
    type:      'community',
    text:      tweetForCommunity(),
    dedupeKey: 'community:boot:' + Math.floor(Date.now() / (60 * 60 * 1000)),
  });
}, 5 * 60 * 1000);



// Broadcast a game event to all connected bots
// (v34: kept as a let so the cooldown wrapper below can rebind it)
let emitBotEvent = function(event) {
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const stream of botEventStreams) {
    try { stream.write(data); } catch (e) { botEventStreams.delete(stream); }
  }
};
// ── v34: Discord cooldown wrapper ────────────────────────────────
// Cap non-priority events to 15 minutes minimum between consecutive emissions
// of the same type. Conquests and nukes are exempt (always emit).
const DISCORD_COOLDOWN_MS = 15 * 60 * 1000;
const _lastEmitByType = new Map(); // type:key → ts

function _isPriorityEvent(event) {
  if (event.type === 'war_conquest') return true;
  if (event.type === 'war_bomb' && event.bombName === 'Nuke') return true;
  return false;
}

// Bucket strategy: cap per (type + sub-key) so different attacker→defender pairs
// each have their own 15min window. For non-pair events (rank_change, alliance_*)
// the sub-key is empty so global per-type cap applies.
function _eventCooldownKey(event) {
  switch (event.type) {
    case 'war_siege_start':
    case 'war_siege_end':
      return event.type + ':' + (event.defenderId || '') + ':' + (event.attackerId || '');
    case 'war_bomb':
      return event.type + ':' + (event.bombName || '') + ':' + (event.attackerId || '');
    case 'war_multi_attack':
      return event.type + ':' + (event.defenderId || '');
    case 'rank_change':
      return event.type + ':' + (event.discordId || '');
    case 'alliance_formed':
    case 'alliance_changed':
    case 'alliance_dissolved':
      return event.type + ':' + (event.key || '');
    default:
      return event.type;
  }
}

// Wrap the original emitBotEvent
const _origEmitBotEvent = emitBotEvent;
emitBotEvent = function(event) {
  if (!_isPriorityEvent(event)) {
    const key = _eventCooldownKey(event);
    const last = _lastEmitByType.get(key) || 0;
    const now = Date.now();
    if (now - last < DISCORD_COOLDOWN_MS) {
      // Suppressed by cooldown — log for visibility but don't notify
      console.log('[Discord] cooldown suppressed', event.type, key, '(' + Math.round((DISCORD_COOLDOWN_MS - (now-last))/1000) + 's left)');
      return;
    }
    _lastEmitByType.set(key, now);
  }
  return _origEmitBotEvent(event);
};

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



// ── v34: Multi-attacker detection ────────────────────────────────
// When 5+ distinct attacker countries paint into the same defender geo within
// a rolling 60-second window, emit a 'war_multi_attack' event once per defender
// per 5-minute cooldown.
const MULTI_ATTACK_THRESHOLD   = 5;
const MULTI_ATTACK_WINDOW_MS   = 60 * 1000;
const MULTI_ATTACK_COOLDOWN_MS = 5 * 60 * 1000;
const _multiAttackTracker = new Map(); // defenderGeoIdx → { attackers: Map(attackerId → ts), lastNotifyAt }

function trackAttackerOnDefender(attackerCountryId, defenderGeoIdx) {
  // Skip self-paint (resident bot painting own country)
  if (String(attackerCountryId) === String(geoToId(defenderGeoIdx))) return;
  const now = Date.now();
  let entry = _multiAttackTracker.get(defenderGeoIdx);
  if (!entry) {
    entry = { attackers: new Map(), lastNotifyAt: 0 };
    _multiAttackTracker.set(defenderGeoIdx, entry);
  }
  // Prune expired
  for (const [aid, ts] of entry.attackers) {
    if (now - ts > MULTI_ATTACK_WINDOW_MS) entry.attackers.delete(aid);
  }
  entry.attackers.set(String(attackerCountryId), now);
  if (entry.attackers.size >= MULTI_ATTACK_THRESHOLD &&
      now - entry.lastNotifyAt > MULTI_ATTACK_COOLDOWN_MS) {
    const attackerIds = [...entry.attackers.keys()];
    // v65: only emit if attackers have COLLECTIVELY claimed >5% of the defender's
    // territory — filters out momentary pings and ensures this is a sustained assault.
    const defTotal = geoTotal[defenderGeoIdx] || 1;
    const claimedByAttackers = attackerIds.reduce(
      (sum, aid) => sum + (geoClaimCnt[defenderGeoIdx]?.[aid] || 0), 0);
    if (claimedByAttackers / defTotal < 0.05) return;
    entry.lastNotifyAt = now;
    const defenderId = geoToId(defenderGeoIdx);
    const _sassyMulti = _pickSassy(SASS_MULTI)({
      n:   attackerIds.length,
      d:   _countryName(defenderId),
      atk: attackerIds.slice(0, 3).map(id => _countryName(id)).join(', ') + (attackerIds.length > 3 ? ' +' + (attackerIds.length - 3) + ' more' : ''),
    });
    emitBotEvent({
      type:         'war_multi_attack',
      tier:         2,
      defenderId,
      attackerIds,
      attackerCount: attackerIds.length,
      timestamp:    now,
      sassyText:    _sassyMulti,
    });
    try {
      const defName = _countryName(defenderId);
      const attNames = attackerIds.slice(0, 3).map(id => _countryName(id)).join(', ');
      const more = attackerIds.length > 3 ? ' +' + (attackerIds.length - 3) + ' more' : '';
      const sassyMulti = _pickSassy(SASS_MULTI)({
        n: attackerIds.length,
        d: defName,
        atk: attNames + more,
      });
      pushTweetDraft({
        type:        'multi_attack',
        text:        sassyMulti,
        dedupeKey:   'multi_attack:' + defenderId + ':' + Math.floor(now / 60000),
        throttleKey: 'multi_attack_def:' + defenderId,
      });
    } catch (e) { /* ignore */ }
  }
}
// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [defId, entry] of _multiAttackTracker) {
    for (const [aid, ts] of entry.attackers) {
      if (now - ts > MULTI_ATTACK_WINDOW_MS) entry.attackers.delete(aid);
    }
    if (entry.attackers.size === 0 && now - entry.lastNotifyAt > MULTI_ATTACK_COOLDOWN_MS * 2) {
      _multiAttackTracker.delete(defId);
    }
  }
}, 30 * 1000);


// ── v38: World conquest watcher + 5-min countdown reset ───────────
const WORLD_CONQUEST_THRESHOLD = 0.70;
const WORLD_RESET_COUNTDOWN_MS = 5 * 60 * 1000;
let _worldConquestActive = false;
let _worldResetAt = 0;
// v61: persist the conquest payload so late-joiners and refreshes get the same screen
let _worldConquestPayload = null;

function _countDistinctConquered() {
  const set = new Set();
  for (const key of conqueredSet) set.add(String(key).split(':')[0]);
  return set.size;
}
function _totalCountries() {
  return Object.keys(countryNames || {}).length || 240;
}
function _isPaintLocked() { return _worldConquestActive; }

function _checkWorldConquest() {
  if (_worldConquestActive) return;
  const total = _totalCountries();
  const conquered = _countDistinctConquered();
  if (total === 0) return;
  const ratio = conquered / total;
  if (ratio < WORLD_CONQUEST_THRESHOLD) return;
  _worldConquestActive = true;
  _worldResetAt = Date.now() + WORLD_RESET_COUNTDOWN_MS;
  const conquestsByCountry = {};
  for (const key of conqueredSet) {
    const attackerId = String(key).split(':')[1];
    if (!attackerId) continue;
    conquestsByCountry[attackerId] = (conquestsByCountry[attackerId] || 0) + 1;
  }
  const topCountries = Object.entries(conquestsByCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(e => ({ countryId: e[0], name: _countryName(e[0]), conquests: e[1] }));
  const topPlayers = [...profiles.values()]
    .filter(p => p.username && p.points > 0 && !p.isBot)
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 5)
    .map(p => ({ username: p.username, points: p.points || 0, avatar: p.avatar, country: p.countryMain }));
  console.log('[v38] WORLD CONQUERED! ratio=' + (ratio*100).toFixed(1) + '% top=' + topCountries.map(c => c.name).join(','));
  // v61: store payload so late-joiners and refreshers get the same screen
  _worldConquestPayload = { type: 'world_conquest', conquered, total, topCountries, topPlayers, resetAt: _worldResetAt };
  broadcast(JSON.stringify(_worldConquestPayload));
  emitBotEvent({
    type:        'world_conquest',
    tier:        3,
    conquered, total, topCountries, topPlayers,
    timestamp:   Date.now(),
    sassyText:   '🌍 THE WORLD HAS BEEN CONQUERED! ' + conquered + '/' + total + ' countries claimed. Top conqueror: ' + (topCountries[0] && topCountries[0].name || '??') + ' with ' + (topCountries[0] && topCountries[0].conquests || 0) + '. Resetting in 5 minutes.',
  });
  try {
    const winners = topCountries.slice(0, 3).map(c => c.name).join(', ');
    pushTweetDraft({
      type:      'world_conquest',
      text:      '🌍 THE WORLD HAS BEEN CONQUERED! Top dogs: ' + winners + '. The map resets in 5 minutes — get ready for round 2. ' + GAME_URL + ' #PixelAnnex',
      dedupeKey: 'world_conquest:' + Math.floor(_worldResetAt / 1000),
    });
  } catch(e) {}
  setTimeout(_resetWorld, WORLD_RESET_COUNTDOWN_MS);
}

function _resetWorld() {
  console.log('[v38] Resetting world state…');
  for (let i = 0; i < claimByPixel.length; i++) claimByPixel[i] = -1;
  conqueredSet.clear();
  permanentlyConquered.clear();
  for (const k of Object.keys(geoClaimCnt)) delete geoClaimCnt[k];
  for (const k of Object.keys(countryPxCount)) countryPxCount[k] = 0;
  for (const k of Object.keys(ownerPixels)) ownerPixels[k] = new Set();
  if (typeof _nukeZones !== 'undefined') _nukeZones.length = 0;
  _worldConquestActive = false;
  _worldResetAt = 0;
  _worldConquestPayload = null; // v61: clear so new sessions don't see stale overlay
  broadcast(JSON.stringify({ type: 'world_reset' }));
  console.log('[v38] World reset complete — broadcasting fresh state');
  try {
    pushTweetDraft({
      type:      'world_reset',
      text:      '🌍 World map has been reset. Fresh canvas, fresh chaos. Get back in: ' + GAME_URL + ' #PixelAnnex',
      dedupeKey: 'world_reset:' + Math.floor(Date.now() / 1000),
    });
  } catch(e) {}
}
setInterval(_checkWorldConquest, 30 * 1000);



// ── Monster system (v49) ───────────────────────────────────────────
// Three independent monster types with their own timers and behaviors.
//
// DEBUG=true  → each type spawns at startup (staggered) and every 2 min
// DEBUG=false → production intervals (UFO 50-70min, Kraken 5-10min, Godzilla 10-30min)
//
// UFO:      arrives with alert, moves around region 10 s, blasts pixels,
//           moves to new region 10 s, blasts again — total 2 min.
// Kraken:   stationary in coastal ocean, 2-frame tentacle animation, 1 min duration.
// Godzilla: walks on land 80 px over 3 min, 5 px-wide cleared trail, then sinks.

const MONSTER_DEBUG = true; // ← flip false for production

// Production intervals
const UFO_PROD_MIN_MS      = 50 * 60 * 1000;
const UFO_PROD_MAX_MS      = 70 * 60 * 1000;
const KRAKEN_PROD_MIN_MS   =  5 * 60 * 1000;
const KRAKEN_PROD_MAX_MS   = 10 * 60 * 1000;
const GODZILLA_PROD_MIN_MS = 10 * 60 * 1000;
const GODZILLA_PROD_MAX_MS = 30 * 60 * 1000;
const DEBUG_RESPAWN_MS     =  2 * 60 * 1000;

function _randInterval(minMs, maxMs) {
  return MONSTER_DEBUG ? DEBUG_RESPAWN_MS
    : minMs + Math.random() * (maxMs - minMs);
}

let _ufoActive = false,      _ufoHandle = null;
let _krakenActive = false,   _krakenHandle = null;
let _godzillaActive = false, _godzillaHandle = null;

function _pickConqueredTarget() {
  const conq = [...conqueredSet];
  if (conq.length === 0) return null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = conq[Math.floor(Math.random() * conq.length)];
    const geoId = parseInt(String(key).split(':')[0], 10);
    if (!geoPixels[geoId] || geoPixels[geoId].length === 0) continue;
    const pixels = geoPixels[geoId];
    const offset = pixels[Math.floor(Math.random() * pixels.length)];
    if (offset === undefined) continue;
    return { x: offset % MAP_W, y: Math.floor(offset / MAP_W), geoIdx: geoId };
  }
  return null;
}

function _pickCoastalOcean() {
  for (let i = 0; i < 80; i++) {
    const x = Math.floor(Math.random() * MAP_W);
    const y = Math.floor(Math.random() * MAP_H);
    const idx = y * MAP_W + x;
    if (idx < 0 || idx >= MAP_PX) continue;
    if (landMask[idx] !== 0) continue;
    let hasLand = false;
    for (let dy = -12; dy <= 12 && !hasLand; dy += 4) {
      for (let dx = -12; dx <= 12 && !hasLand; dx += 4) {
        const ni = (y + dy) * MAP_W + (x + dx);
        if (ni >= 0 && ni < MAP_PX && landMask[ni] === 1) hasLand = true;
      }
    }
    if (hasLand) return { x, y };
  }
  return null;
}

function _pickRandomLand() {
  for (let i = 0; i < 80; i++) {
    const x = Math.floor(Math.random() * MAP_W);
    const y = Math.floor(Math.random() * MAP_H);
    const idx = y * MAP_W + x;
    if (idx >= 0 && idx < MAP_PX && landMask[idx] === 1) return { x, y };
  }
  return null;
}

function _clearMonsterArea(cx, cy, radius) {
  const changed = [];
  const affectedGeos = new Set();
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const px = Math.round(cx + dx), py = Math.round(cy + dy);
      if (px < 0 || px >= MAP_W || py < 0 || py >= MAP_H) continue;
      const i = py * MAP_W + px;
      if (!landMask[i]) continue;
      if (claimByPixel[i] === -1) continue;
      const prev = claimByPixel[i];
      const owner = idxToId[prev];
      if (owner !== undefined) {
        updateOwnerIndex(i, prev, -1);
        countryPxCount[owner] = Math.max(0, (countryPxCount[owner] || 0) - 1);
        const geo = geoAtPixel[i];
        if (geo >= 0) {
          affectedGeos.add(geo);
          if (geoClaimCnt[geo] && geoClaimCnt[geo][owner]) {
            geoClaimCnt[geo][owner]--;
            if (geoClaimCnt[geo][owner] <= 0) delete geoClaimCnt[geo][owner];
          }
        }
      }
      claimByPixel[i] = -1;
      changed.push({ x: px, y: py, owner: null });
    }
  }
  // v41b: re-evaluate conquest threshold for affected geos
  for (const geo of affectedGeos) {
    const total = geoTotal[geo] || 1;
    for (const key of [...conqueredSet]) {
      if (!key.startsWith(geo + ':')) continue;
      const ownerId = key.split(':')[1];
      // v64: check combined alliance count — monster damage doesn't break an alliance conquest
      if (getAllyOwnedCount(geo, ownerId) / total < CONQUEST_THRESHOLD) {
        conqueredSet.delete(key);
        broadcast(JSON.stringify({
          type:        'reversal',
          attackerId:  geoToId(geo),
          defenderId:  ownerId,
          reason:      'monster',
        }));
      }
    }
  }
  if (changed.length > 0) queueDelta(changed);
  return changed.length;
}

// ── UFO ─────────────────────────────────────────────────────────────
// Arrives, moves around a region for 10 s, blasts pixels, repeats — 2 min total.
function _spawnUFO(eventId) {
  if (_ufoActive) return;
  _ufoActive = true;
  console.log('[Monster] UFO spawning');

  const DURATION_MS   = 2 * 60 * 1000;   // 2-minute run
  const HOVER_MS      = 10 * 1000;        // 10 s stationary abduction per target
  const BLAST_RADIUS  = 10;              // radius of pixel abduction circle
  const TRANSIT_SPEED = 3;               // px / 100 ms tick when in transit

  let mainTarget = _pickConqueredTarget() || _pickRandomLand();
  if (!mainTarget) { _ufoActive = false; setTimeout(_scheduleUFO, _randInterval(UFO_PROD_MIN_MS, UFO_PROD_MAX_MS)); return; }

  let cur        = { x: mainTarget.x, y: mainTarget.y };
  let phase      = 'transit'; // 'transit' | 'hover'
  let hoverStart = 0;
  const startTs  = Date.now();
  const endTs    = startTs + DURATION_MS;

  broadcast(JSON.stringify({ type:'monster_spawn', monsterId:eventId, monsterType:'ufo',
    x:cur.x, y:cur.y, durationMs:DURATION_MS, timestamp:startTs }));
  emitBotEvent({ type:'monster_event', tier:2, monsterType:'ufo', timestamp:startTs,
    sassyText:'🛸 UFO sighting! Pixel cattle abduction in progress.' });

  _ufoHandle = setInterval(() => {
    const now = Date.now();
    if (now >= endTs) {
      clearInterval(_ufoHandle); _ufoHandle = null; _ufoActive = false;
      broadcast(JSON.stringify({ type:'monster_despawn', monsterId:eventId }));
      setTimeout(_scheduleUFO, _randInterval(UFO_PROD_MIN_MS, UFO_PROD_MAX_MS));
      return;
    }

    if (phase === 'transit') {
      // Move quickly toward main target
      const dx = mainTarget.x - cur.x, dy = mainTarget.y - cur.y;
      const dist = Math.hypot(dx, dy);
      if (dist > TRANSIT_SPEED) {
        cur.x += (dx / dist) * TRANSIT_SPEED;
        cur.y += (dy / dist) * TRANSIT_SPEED;
      } else {
        // Arrived — lock on and start abducting
        phase      = 'hover';
        hoverStart = now;
        cur.x = mainTarget.x;
        cur.y = mainTarget.y;
      }
    } else {
      // Hover: UFO is stationary — locked on, beam active, abducting pixels
      cur.x = mainTarget.x;
      cur.y = mainTarget.y;

      if (now - hoverStart >= HOVER_MS) {
        // Abduct! Clear pixels beneath, then fly to next target
        _clearMonsterArea(cur.x, cur.y, BLAST_RADIUS);
        broadcast(JSON.stringify({ type:'monster_ray', monsterId:eventId,
          x:cur.x, y:cur.y, radius:BLAST_RADIUS, timestamp:now }));
        const next = _pickConqueredTarget() || _pickRandomLand();
        if (next) mainTarget = next;
        phase = 'transit';
      }
    }

    broadcast(JSON.stringify({ type:'monster_tick', monsterId:eventId,
      x:cur.x, y:cur.y, phase, timestamp:now }));
  }, 100);
}

function _scheduleUFO() {
  const delay = _randInterval(UFO_PROD_MIN_MS, UFO_PROD_MAX_MS);
  console.log('[UFO] next spawn in', Math.round(delay/60000), 'min');
  setTimeout(() => {
    if (typeof landMask === 'undefined' || !landMask) { _scheduleUFO(); return; }
    _spawnUFO('ufo-' + Date.now());
  }, delay);
}

// ── Kraken ──────────────────────────────────────────────────────────
// Stationary coastal pop-up, 2-frame tentacle animation, 1-min duration.
function _spawnKraken(eventId) {
  if (_krakenActive) return;
  _krakenActive = true;
  console.log('[Monster] Kraken spawning');

  const DURATION_MS = 60 * 1000; // 1 minute
  const spawn = _pickCoastalOcean();
  if (!spawn) { _krakenActive = false; setTimeout(_scheduleKraken, _randInterval(KRAKEN_PROD_MIN_MS, KRAKEN_PROD_MAX_MS)); return; }

  const startTs = Date.now();
  broadcast(JSON.stringify({ type:'monster_spawn', monsterId:eventId, monsterType:'kraken',
    x:spawn.x, y:spawn.y, durationMs:DURATION_MS, timestamp:startTs }));
  emitBotEvent({ type:'monster_event', tier:2, monsterType:'kraken', timestamp:startTs,
    sassyText:'🦑 Kraken surfaced! A coastline is having a very bad afternoon.' });

  _krakenHandle = setTimeout(() => {
    _krakenHandle = null; _krakenActive = false;
    broadcast(JSON.stringify({ type:'monster_despawn', monsterId:eventId }));
    setTimeout(_scheduleKraken, _randInterval(KRAKEN_PROD_MIN_MS, KRAKEN_PROD_MAX_MS));
  }, DURATION_MS);
}

function _scheduleKraken() {
  const delay = _randInterval(KRAKEN_PROD_MIN_MS, KRAKEN_PROD_MAX_MS);
  console.log('[Kraken] next spawn in', Math.round(delay/60000), 'min');
  setTimeout(() => {
    if (typeof landMask === 'undefined' || !landMask) { _scheduleKraken(); return; }
    _spawnKraken('kraken-' + Date.now());
  }, delay);
}

// ── Godzilla ─────────────────────────────────────────────────────────
// Emerges on land, trudges 80 px over 3 min leaving a 5 px-wide cleared trail.
function _spawnGodzilla(eventId) {
  if (_godzillaActive) return;
  _godzillaActive = true;
  console.log('[Monster] Godzilla spawning');

  const DURATION_MS    = 3 * 60 * 1000;  // 3 minutes
  const TOTAL_DIST_PX  = 80;
  const TRAIL_RAD      = 5;              // radius 5 → ~10 px wide swath
  const TICK_MS        = 200;
  const TICKS          = DURATION_MS / TICK_MS;           // 900 ticks
  const STEP_PER_TICK  = TOTAL_DIST_PX / TICKS;           // ≈0.089 px/tick

  const start = _pickRandomLand();
  if (!start) { _godzillaActive = false; setTimeout(_scheduleGodzilla, _randInterval(GODZILLA_PROD_MIN_MS, GODZILLA_PROD_MAX_MS)); return; }

  const angle = Math.random() * Math.PI * 2;
  const vx = Math.cos(angle), vy = Math.sin(angle);
  let cur = { x: start.x, y: start.y };
  let lastClear = { x: cur.x, y: cur.y };
  const startTs = Date.now();
  const endTs   = startTs + DURATION_MS;

  broadcast(JSON.stringify({ type:'monster_spawn', monsterId:eventId, monsterType:'godzilla',
    x:cur.x, y:cur.y, durationMs:DURATION_MS, timestamp:startTs,
    vx, vy, totalDist:TOTAL_DIST_PX }));
  emitBotEvent({ type:'monster_event', tier:2, monsterType:'godzilla', timestamp:startTs,
    sassyText:'🦖 Giant Radioactive Lizard! It is stomping through the map. Run.' });

  _godzillaHandle = setInterval(() => {
    const now = Date.now();
    if (now >= endTs) {
      clearInterval(_godzillaHandle); _godzillaHandle = null; _godzillaActive = false;
      broadcast(JSON.stringify({ type:'monster_despawn', monsterId:eventId }));
      setTimeout(_scheduleGodzilla, _randInterval(GODZILLA_PROD_MIN_MS, GODZILLA_PROD_MAX_MS));
      return;
    }

    cur.x = Math.max(0, Math.min(MAP_W - 1, cur.x + vx * STEP_PER_TICK));
    cur.y = Math.max(0, Math.min(MAP_H - 1, cur.y + vy * STEP_PER_TICK));

    // Clear pixels when we've moved at least 1 map-pixel from last clear
    if (Math.hypot(cur.x - lastClear.x, cur.y - lastClear.y) >= 1) {
      _clearMonsterArea(cur.x, cur.y, TRAIL_RAD);
      lastClear = { x: cur.x, y: cur.y };
    }

    broadcast(JSON.stringify({ type:'monster_tick', monsterId:eventId,
      x:cur.x, y:cur.y, timestamp:now }));
  }, TICK_MS);
}

function _scheduleGodzilla() {
  const delay = _randInterval(GODZILLA_PROD_MIN_MS, GODZILLA_PROD_MAX_MS);
  console.log('[Godzilla] next spawn in', Math.round(delay/60000), 'min');
  setTimeout(() => {
    if (typeof landMask === 'undefined' || !landMask) { _scheduleGodzilla(); return; }
    _spawnGodzilla('godzilla-' + Date.now());
  }, delay);
}

// ── Bootstrap ──────────────────────────────────────────────────────
// DEBUG: spawn each type at startup (staggered) then every 2 min after despawn.
// PROD:  schedule each at their own independent random interval.
if (MONSTER_DEBUG) {
  setTimeout(() => _spawnUFO('ufo-'     + Date.now()),       5 * 1000);
  setTimeout(() => _spawnKraken('kraken-'  + Date.now()),   35 * 1000);
  setTimeout(() => _spawnGodzilla('godzilla-' + Date.now()), 65 * 1000);
} else {
  _scheduleUFO();
  _scheduleKraken();
  _scheduleGodzilla();
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

// v64: sum pixel count for countryId + all its alliance partners in a given geo.
// Used so allied countries share conquest credit (any one member painting pushes
// the combined total towards the threshold).
function getAllyOwnedCount(geo, countryId) {
  const own = geoClaimCnt[geo]?.[String(countryId)] || 0;
  const ally = getAllianceForCountry(countryId);
  if (!ally) return own;
  let sum = own;
  for (const memberId of ally.countries) {
    if (String(memberId) !== String(countryId)) {
      sum += geoClaimCnt[geo]?.[String(memberId)] || 0;
    }
  }
  return sum;
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
// Once a territory is conquered this game cycle it stays locked even after
// pixel reversals (monsters / nukes can drop it below threshold). Cleared only
// on world reset so the conquest is a lasting consequence.
const permanentlyConquered = new Set(); // geoToId values

// ── Conquest consequences ─────────────────────────────────────────
// Pick the best country for a defeated bot to migrate to:
// alliance partner preferred, else underpopulated unconquered country.
function _pickBotMigrationTarget(fromCountryId) {
  const ally = getAllianceForCountry(String(fromCountryId));
  if (ally) {
    const partners = ally.countries.filter(c =>
      String(c) !== String(fromCountryId) && !permanentlyConquered.has(String(c)));
    if (partners.length) {
      // Prefer the partner with most pixels (strongest ally)
      return partners.reduce((best, c) =>
        (countryPxCount[c] || 0) > (countryPxCount[best] || 0) ? c : best, partners[0]);
    }
  }
  // Fallback: unconquered country needing the most help (fewest pixels, has territory)
  const cands = Object.keys(geoPixels).filter(g =>
    g !== String(fromCountryId) &&
    !permanentlyConquered.has(g) &&
    geoPixels[g] && geoPixels[g].length > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => (countryPxCount[a] || 0) - (countryPxCount[b] || 0));
  return cands[0];
}

// Called (deferred) when a territory is permanently conquered:
//   1. Transfer foreign pixels to alliance partner
//   2. Migrate the defeated bot (boost ally's bot + update player entry)
function _onCountryConquered(conqueredGeoId) {
  conqueredGeoId = String(conqueredGeoId);
  const homeGeoIdx    = parseInt(conqueredGeoId, 10); // numeric ISO stored in geoAtPixel
  const conqueredCidx = getIdx(conqueredGeoId);

  // ── 1. Alliance pixel transfer ──────────────────────────────────
  const ally = getAllianceForCountry(conqueredGeoId);
  let transferTo = null;
  if (ally) {
    const partners = ally.countries.filter(c =>
      String(c) !== conqueredGeoId && !permanentlyConquered.has(String(c)));
    if (partners.length) {
      transferTo = partners.reduce((best, c) =>
        (countryPxCount[c] || 0) > (countryPxCount[best] || 0) ? c : best, partners[0]);
    }
  }
  if (transferTo) {
    const newCidx      = getIdx(transferTo);
    const ownedPixels  = ownerPixels[conqueredCidx];
    const toTransfer   = ownedPixels
      ? [...ownedPixels].filter(i => geoAtPixel[i] !== homeGeoIdx)
      : [];
    if (toTransfer.length) {
      const changed = [];
      for (const i of toTransfer) {
        const geo = geoAtPixel[i];
        updateOwnerIndex(i, conqueredCidx, newCidx);
        claimByPixel[i] = newCidx;
        countryPxCount[conqueredGeoId] = Math.max(0, (countryPxCount[conqueredGeoId] || 1) - 1);
        countryPxCount[transferTo]     = (countryPxCount[transferTo] || 0) + 1;
        if (geo >= 0 && geoClaimCnt[geo]) {
          geoClaimCnt[geo][conqueredGeoId] = Math.max(0, (geoClaimCnt[geo][conqueredGeoId] || 1) - 1);
          geoClaimCnt[geo][transferTo]     = (geoClaimCnt[geo][transferTo] || 0) + 1;
        }
        changed.push({ x: i % MAP_W, y: (i / MAP_W) | 0, owner: transferTo });
      }
      queueDelta(changed);
      console.log(`[Conquest] ${conqueredGeoId} foreign pixels (${changed.length}) → ally ${transferTo}`);
    }
  }

  // ── 2. Bot migration ────────────────────────────────────────────
  const migTarget = transferTo || _pickBotMigrationTarget(conqueredGeoId);
  if (migTarget) {
    if (bots.has(migTarget)) {
      // Boost target bot's bucket with the conquered bot's remaining energy
      const targetBot = bots.get(migTarget);
      targetBot.bucket = Math.min(BOT_BUCKET_MAX, (targetBot.bucket || 0) + BOT_BUCKET_MAX * 0.5);
    }
    // Reassign the conquered bot's player slot to the new country so it shows
    // in the player list as playing there instead of a dead country
    for (const [, p] of players) {
      if (p.isBot && String(p.countryId) === conqueredGeoId) {
        p.countryId  = migTarget;
        p.countryIdx = getIdx(migTarget);
        break; // only reassign one slot
      }
    }
    console.log(`[Bot] ${conqueredGeoId} conquered → migrated to ${migTarget}`);
    broadcastPlayers();
  }
}

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
  // v36: include simulated player count so clients show it immediately
  const realHumans = list.filter(p => !p.isBot).length;
  const activeBots = typeof _activeBotCount === 'function' ? _activeBotCount() : 0;
  const simulatedPlayerCount = realHumans + activeBots;
  broadcast(JSON.stringify({ type: 'players', list, david: davidSnapshot, simulatedPlayerCount }));
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
  // v38: paint locked during world-conquest fanfare countdown
  if (typeof _isPaintLocked === 'function' && _isPaintLocked()) {
    return { changed: [], conquests: [], reversals: [] };
  }
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
      // v34: track multi-attacker on this defender geo
      if (String(countryId) !== String(geoToId(geo))) {
        trackAttackerOnDefender(countryId, geo);
      }
    }
    changed.push({ x, y, owner: countryId });
  }

  const conquests = [], reversals = [];
  for (const geo of affected) {
    const total = geoTotal[geo] || 0;
    if (!total) continue;
    // v64: use combined alliance pixel count so allied countries share conquest credit
    const owned = getAllyOwnedCount(geo, countryId);
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
      permanentlyConquered.add(geoToId(geo)); // persists through reversals until world reset
      // Defer so applyPixels finishes before we mutate ownership data
      const _cgid = geoToId(geo);
      setTimeout(() => _onCountryConquered(_cgid), 0);
      conquests.push({ geoIdx: geo, countryId });
      changed.push(...finisherFill(geo, countryId));
      // War reporter event — Tier 2 (role ping)
      // Skip self-conquest (country reclaiming its own native territory)
      if (countryId !== geoToId(geo)) {
        const _defId = geoToId(geo);
        const _sassyConq = _geoContextSassy(countryId, _defId) || _pickSassy(SASS_CONQUEST)({
          a: _countryName(countryId),
          d: _countryName(_defId),
          held: Array.from(conqueredSet).filter(k => String(k).split(':')[1] === String(countryId)).length,
        });
        emitBotEvent({
          type:        'war_conquest',
          tier:        2,
          attackerId:  countryId,
          defenderId:  _defId,
          timestamp:   Date.now(),
          sassyText:   _sassyConq,
        });
        // v38: notify players who were playing as the conquered country
        for (const [pid, p] of players) {
          if (p.isBot) continue;
          if (!p.ws) continue;
          if (String(p.countryId) === String(_defId)) {
            try {
              p.ws.send(JSON.stringify({
                type:           'your_country_lost',
                lostCountryId:  _defId,
                attackerId:     countryId,
                mercenaryBonus: 20,
              }));
            } catch (e) {}
          }
        }
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
      // v64: use combined alliance count for reversal — conquest only breaks when
      // the whole alliance drops below the threshold, not just one member.
      if (cId !== countryId && conqueredSet.has(rk) && getAllyOwnedCount(geo, cId) / total < CONQUEST_THRESHOLD) {
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
// auto-claim those pixels. Returns {enclosed, count, centerX, centerY}.
//
// v68 algorithm: uses the bounding box of ALL own pixels in the touched geo
// (not just the current stroke) so rings built pixel-by-pixel over multiple
// clicks are detected the moment the ring closes.
// Performance: BFS is bounded by own-pixel bbox area capped at 200k cells.
const ENCIRCLE_MIN_PX      = 50;    // min enclosed pixels for any reward
const ENCIRCLE_MAX_PX      = 500;   // cap on auto-claimed enclosed pixels
const ENCIRCLE_BBOX_PAD    = 8;     // padding around own-pixel bbox
const ENCIRCLE_MAX_BBOX_AREA = 200000; // bail if bbox area exceeds this

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
  if (!strokePixels || strokePixels.length < 1) return null;
  const cidx = getIdx(countryId);

  // 1. Which geos does this stroke touch?
  const touchedGeos = new Set();
  for (const { x, y } of strokePixels) {
    const gi = y * MAP_W + x;
    if (gi >= 0 && gi < MAP_PX && landMask[gi]) {
      const g = geoAtPixel[gi];
      if (g >= 0) touchedGeos.add(g);
    }
  }
  if (touchedGeos.size === 0) return null;

  // 2. Build Bresenham-interpolated stroke wall once (seals fast-drag gaps).
  //    These interpolated pixels are NOT in claimByPixel yet but must block BFS.
  // We build a sparse map indexed by (y*MAP_W+x) for quick lookup.
  const strokeWallMap = new Set();
  for (let s = 0; s < strokePixels.length; s++) {
    const p = strokePixels[s];
    strokeWallMap.add(p.y * MAP_W + p.x);
    if (s > 0) {
      const prev = strokePixels[s - 1];
      const dx = Math.abs(p.x - prev.x), dy = Math.abs(p.y - prev.y);
      if ((dx > 1 || dy > 1) && dx <= 30 && dy <= 30) {
        for (const pt of _bresenhamLine(prev.x, prev.y, p.x, p.y))
          strokeWallMap.add(pt.y * MAP_W + pt.x);
      }
    }
  }

  let bestResult = null;

  for (const geoIdx of touchedGeos) {
    const geoPxArr = geoPixels[geoIdx];
    if (!geoPxArr || geoPxArr.length === 0) continue;

    // 3. Bounding box of all OWN pixels in this geo.
    //    This works for rings built over many separate strokes because
    //    claimByPixel reflects the full cumulative paint history.
    let ownMinX = MAP_W, ownMinY = MAP_H, ownMaxX = 0, ownMaxY = 0, hasOwn = false;
    for (let pi = 0; pi < geoPxArr.length; pi++) {
      const i = geoPxArr[pi];
      if (claimByPixel[i] !== cidx && !strokeWallMap.has(i)) continue;
      const x = i % MAP_W, y = (i / MAP_W) | 0;
      if (x < ownMinX) ownMinX = x; if (x > ownMaxX) ownMaxX = x;
      if (y < ownMinY) ownMinY = y; if (y > ownMaxY) ownMaxY = y;
      hasOwn = true;
    }
    if (!hasOwn) continue;

    const minX = Math.max(0, ownMinX - ENCIRCLE_BBOX_PAD);
    const minY = Math.max(0, ownMinY - ENCIRCLE_BBOX_PAD);
    const maxX = Math.min(MAP_W - 1, ownMaxX + ENCIRCLE_BBOX_PAD);
    const maxY = Math.min(MAP_H - 1, ownMaxY + ENCIRCLE_BBOX_PAD);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw * bh > ENCIRCLE_MAX_BBOX_AREA) continue; // too large, skip

    // 4. Inline wall check: Bresenham gaps OR all own pixels (cumulative).
    const isWall = (gx, gy) => {
      const gi = gy * MAP_W + gx;
      return strokeWallMap.has(gi) || claimByPixel[gi] === cidx;
    };

    // 5. BFS from bbox edges — anything reachable = "outside the ring".
    const visited = new Uint8Array(bw * bh);
    const queue   = new Int32Array(bw * bh);
    let head = 0, tail = 0;
    const seed = (lx, ly) => {
      if (lx < 0 || lx >= bw || ly < 0 || ly >= bh) return;
      const li = ly * bw + lx;
      if (visited[li]) return;
      if (isWall(minX + lx, minY + ly)) return;
      visited[li] = 1; queue[tail++] = li;
    };
    for (let lx = 0; lx < bw; lx++) { seed(lx, 0); seed(lx, bh - 1); }
    for (let ly = 0; ly < bh; ly++) { seed(0, ly); seed(bw - 1, ly); }
    while (head < tail) {
      const li = queue[head++];
      const lx = li % bw, ly = (li / bw) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = lx + DX4[d], ny = ly + DY4[d];
        if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
        const nli = ny * bw + nx;
        if (visited[nli]) continue;
        if (isWall(minX + nx, minY + ny)) continue;
        visited[nli] = 1; queue[tail++] = nli;
      }
    }

    // 6. Collect enclosed: same geo, land, not own, not reachable from outside.
    const enclosed = [];
    for (let ly = 0; ly < bh && enclosed.length < ENCIRCLE_MAX_PX; ly++) {
      for (let lx = 0; lx < bw && enclosed.length < ENCIRCLE_MAX_PX; lx++) {
        const li = ly * bw + lx;
        if (visited[li]) continue;
        const gx = minX + lx, gy = minY + ly;
        const gi = gy * MAP_W + gx;
        if (!landMask[gi]) continue;
        if (geoAtPixel[gi] !== geoIdx) continue; // stay within this geo
        if (claimByPixel[gi] === cidx) continue; // exclude own pixels
        if (strokeWallMap.has(gi)) continue;      // exclude Bresenham wall pixels
        enclosed.push({ x: gx, y: gy });
      }
    }

    if (enclosed.length >= ENCIRCLE_MIN_PX) {
      if (!bestResult || enclosed.length > bestResult.count) {
        let sumX = 0, sumY = 0;
        for (const p of enclosed) { sumX += p.x; sumY += p.y; }
        bestResult = {
          enclosed, count: enclosed.length,
          centerX: Math.round(sumX / enclosed.length),
          centerY: Math.round(sumY / enclosed.length),
        };
      }
    }
  }

  return bestResult;
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
const geoBbox      = {};  // geoIdx → {minX,minY,maxX,maxY} (built once in buildGeoIndex)

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
  // v68: Build per-geo bounding boxes used by detectEncirclement
  for (const k of Object.keys(geoBbox)) delete geoBbox[k];
  for (const [gStr, pixels] of Object.entries(geoPixels)) {
    const g = +gStr;
    let minX = MAP_W, minY = MAP_H, maxX = 0, maxY = 0;
    for (const pi of pixels) {
      const x = pi % MAP_W, y = (pi / MAP_W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    geoBbox[g] = { minX, minY, maxX, maxY };
  }
  console.log(`[Bot] Geo index built: ${Object.keys(geoPixels).length} countries`);
}

// Get target pixels for a bot — v60 strategic AI
// ─────────────────────────────────────────────
// Priority:
//   0. Roaming scout (1% chance) — seed a pixel in a distant large/contested country
//   1. Defend        — reclaim enemy pixels inside home territory
//   2. Strategic attack — pick the highest-scoring neighbouring geo and push into it
//   3. Expand        — fill unclaimed pixels inside home territory (last resort)
//
// Attack scoring per neighbouring geo (higher = more desirable):
//   • Opportunistic:        +5 if ≥40% already foreign-held, +3 if ≥20%, +1 if ≥5%
//   • Size-weighted:        bots always prefer large neighbours (max +6 bonus)
//   • Alliance coordination: +3 if an alliance partner already has pixels there
const DX4 = [-1,1,0,0], DY4 = [0,0,-1,1];
function getBotTargets(countryId, limit) {
  const cidx       = getIdx(countryId);
  const geoIdx     = getGeoForCountry(countryId);
  const homePixels = geoPixels[geoIdx];
  if (!homePixels || homePixels.length === 0) return [];

  // ── 0. Roaming scout — 1% chance to seed in a distant appealing territory ──
  if (Math.random() < 0.01) {
    const geoKeys = Object.keys(geoPixels);
    let bestGeo = -1, bestScore = -1;
    // Sample 15 random geos and score them
    for (let attempt = 0; attempt < 15; attempt++) {
      const gi = parseInt(geoKeys[Math.floor(Math.random() * geoKeys.length)], 10);
      if (gi === geoIdx) continue;
      const total   = geoTotal[gi] || 1;
      const homeId  = geoToId(gi);
      const claims  = geoClaimCnt[gi] || {};
      const foreign = Object.entries(claims)
        .filter(([c]) => c !== homeId).reduce((s, [, v]) => s + v, 0);
      // Prefer large countries; bonus if already contested
      let score = Math.round(getWorldShare(homeId) * 1000);
      if (foreign / total >= 0.2) score += 3;
      if (score > bestScore) { bestScore = score; bestGeo = gi; }
    }
    if (bestGeo >= 0 && geoPixels[bestGeo]) {
      const tp = geoPixels[bestGeo];
      const i  = tp[Math.floor(Math.random() * tp.length)];
      if (claimByPixel[i] !== cidx)
        return [{ x: i % MAP_W, y: (i / MAP_W) | 0 }];
    }
  }

  // ── 1. Scan home territory ────────────────────────────────────
  const defend = [], expand = [];
  const homeSampleSize = Math.min(200, homePixels.length);
  const homeStep = Math.max(1, Math.floor(homePixels.length / homeSampleSize));
  let homeOwned = 0;
  for (let s = 0; s < homePixels.length; s += homeStep) {
    const i     = homePixels[s];
    const owner = claimByPixel[i];
    if (owner === cidx) { homeOwned++; continue; }

    const x = i % MAP_W, y = (i / MAP_W) | 0;
    let adjacent = false;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d], ny = y + DY4[d];
      if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
      if (claimByPixel[ny * MAP_W + nx] === cidx) { adjacent = true; break; }
    }
    if (!adjacent && (ownerPixels[cidx]?.size || 0) > 0) continue;
    if (owner >= 0 && owner !== cidx) defend.push({ x, y });
    else                              expand.push({ x, y });
  }

  // Defend always wins — bots never attack while being pushed back
  if (defend.length > 0) {
    for (let i = defend.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [defend[i], defend[j]] = [defend[j], defend[i]];
    }
    return defend.slice(0, limit);
  }

  // ── 2. Strategic attack — score all neighbouring geos ────────
  const homeStable = homeOwned / homeSampleSize >= 0.4; // v60: attack even when home is only 40% secured
  if (homeStable && ownerPixels[cidx]) {
    const geoScores    = new Map(); // targetGeoIdx → score
    const geoCandidates = new Map(); // targetGeoIdx → [{x,y}]
    const myShare      = getWorldShare(countryId);
    const ally         = getAllianceForCountry(String(countryId));

    const owned      = [...ownerPixels[cidx]];
    const ownedSample = Math.min(150, owned.length);
    const ownedStep  = Math.max(1, Math.floor(owned.length / ownedSample));

    for (let s = 0; s < owned.length; s += ownedStep) {
      const i = owned[s];
      const x = i % MAP_W, y = (i / MAP_W) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX4[d], ny = y + DY4[d];
        if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
        const ni = ny * MAP_W + nx;
        if (!landMask[ni]) continue;
        const ngeo = geoAtPixel[ni];
        if (ngeo === geoIdx) continue;
        if (claimByPixel[ni] === cidx) continue;

        if (!geoScores.has(ngeo)) {
          let score = 1;
          const nTotal   = geoTotal[ngeo] || 1;
          const nHomeId  = geoToId(ngeo);
          const nClaims  = geoClaimCnt[ngeo] || {};

          // Opportunistic: pile on contested territories (v60: raised bonuses)
          const foreign = Object.entries(nClaims)
            .filter(([c]) => c !== nHomeId).reduce((s, [, v]) => s + v, 0);
          const contested = foreign / nTotal;
          if      (contested >= 0.40) score += 5;
          else if (contested >= 0.20) score += 3;
          else if (contested >= 0.05) score += 1;

          // Size-weighted: ALL bots prefer large neighbours (v60: no myShare gate)
          const theirShare = getWorldShare(nHomeId);
          if      (theirShare >= 0.05)  score += 6;
          else if (theirShare >= 0.02)  score += 4;
          else if (theirShare >= 0.01)  score += 2;
          else if (theirShare >= 0.005) score += 1;

          // Alliance coordination: join where allies are already painting
          if (ally) {
            const allyPx = ally.countries
              .filter(c => String(c) !== String(countryId))
              .reduce((sum, c) => sum + (nClaims[String(c)] || 0), 0);
            if (allyPx > 0) score += 3;
          }

          geoScores.set(ngeo, score);
          geoCandidates.set(ngeo, []);
        }

        const cands = geoCandidates.get(ngeo);
        if (cands.length < limit * 8) cands.push({ x: nx, y: ny });
      }
    }

    if (geoScores.size > 0) {
      // Pick the highest-scoring neighbouring geo
      let bestGeo = -1, bestScore = -1;
      for (const [g, sc] of geoScores) {
        if (sc > bestScore) { bestScore = sc; bestGeo = g; }
      }
      if (bestGeo >= 0) {
        const attack = geoCandidates.get(bestGeo);
        if (attack.length > 0) {
          for (let i = attack.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [attack[i], attack[j]] = [attack[j], attack[i]];
          }
          return attack.slice(0, limit);
        }
      }
    }
  }

  // ── 3. Expand into unclaimed home pixels ─────────────────────
  for (let i = expand.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [expand[i], expand[j]] = [expand[j], expand[i]];
  }
  return expand.slice(0, limit);
}

function botInit(countryId) {
  const bot = { countryId, bucket: BOT_BUCKET_MAX, geoIdx: getGeoForCountry(countryId) };
  bots.set(countryId, bot);
  players.set(nextPid++, { ws: null, countryId, countryIdx: getIdx(countryId), lastSeen: Date.now(), isBot: true });
  ownerPixels[getIdx(countryId)] = new Set();
  countryPxCount[countryId] = countryPxCount[countryId] || 0;
  _initBotActivity(countryId); // v34
  _initBotProfile(countryId);  // v35
}

// v36: clear stale bot profiles from previous schema on boot
(function _cleanStaleBotProfiles(){
  let cleared = 0;
  for (const [id, p] of [...profiles.entries()]) {
    if (p && p.isBot && (p.countryB || p.countryC)) {
      profiles.delete(id);
      cleared++;
    }
  }
  if (cleared > 0) console.log('[v36] Cleared', cleared, 'stale multi-country bot profiles');
})();

// v36: bot profile bootstrap — single random country pref to participate in alliances without forming mega-alliances
function _initBotProfile(countryId) {
  const synthId = 'bot:' + countryId;
  if (profiles.has(synthId)) return;
  const allIds = [...bots.keys()];
  if (allIds.length < 4) return;
  // v36: only assign a single random ally to prevent mega-alliances of all bots
  const others = allIds.filter(id => id !== countryId);
  const pick = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : null;
  profiles.set(synthId, {
    discordId:   synthId,
    username:    'Bot ' + (countryNames[countryId] || countryId),
    rank:        'Soldier',
    points:      0,
    xp:          0,
    countryMain: pick,
    countryB:    null,
    countryC:    null,
    joinedAt:    Date.now(),
    isBot:       true,
  });
}
setInterval(() => {
  for (const countryId of bots.keys()) {
    const synthId = 'bot:' + countryId;
    const p = profiles.get(synthId);
    if (!p || !p.countryMain) _initBotProfile(countryId);
  }
}, 60 * 1000);

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

// v39c: returns true if any other country has conquered the given country.
// conqueredSet keys are 'geoId:attackerId'. We match on geoId regardless of attacker.
function _isCountryConquered(countryId) {
  const target = String(countryId) + ':';
  for (const key of conqueredSet) {
    if (String(key).startsWith(target)) return true;
  }
  return false;
}

// v56: bot surrender threshold — once any single enemy holds this share of a
// country's home territory the defending bot stands down completely.  This lets
// the attacker accumulate pixels unopposed until applyPixels fires formal
// conquest at CONQUEST_THRESHOLD (60%).  Keeping the two thresholds separate
// (50% stand-down / 60% formal) means finisherFill runs properly and the
// reversal check never immediately undoes the conquest (reversal fires at <60%).
const BOT_SURRENDER_THRESHOLD = 0.50;

function botTickSingle(countryId) {
  if (!mapReady) return;
  // Once permanently conquered this cycle the bot never resumes — even if a
  // monster/nuke reversal temporarily drops the attacker below the threshold.
  if (permanentlyConquered.has(countryId)) return;
  // Active conquest gate (redundant with permanentlyConquered, but kept for
  // clarity and to block mid-conquest activity before the set is populated).
  if (_isCountryConquered(countryId)) return;
  // (legacy: humanClaimedCountries is still consulted in case it gets used
  // elsewhere; the new gate above covers it as a superset.)
  if (humanClaimedCountries.has(countryId)) return;
  // v56: bot stands down when overwhelmed so the attacker can reach the formal
  // conquest threshold (60%) without constant reclaim interference.
  const _homeGeoIdx = getGeoForCountry(countryId);
  const _homeTotal  = geoTotal[_homeGeoIdx] || 0;
  if (_homeTotal > 0) {
    const _claims = geoClaimCnt[_homeGeoIdx];
    if (_claims) {
      for (const [cId, cnt] of Object.entries(_claims)) {
        if (cId !== countryId && cnt / _homeTotal >= BOT_SURRENDER_THRESHOLD) {
          return; // overwhelmed — stand down, let applyPixels fire formal conquest
        }
      }
    }
  }
  // v34: only active bots paint
  if (!_isBotActive(countryId)) return;
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
  if (url.pathname === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ version: SERVER_VERSION }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const f = path.join(__dirname, 'pixelworld_v5.html');
    serveCompressedAsset(req, res, f, {
      // HTML changes per deploy; tell browser to revalidate
      'Cache-Control': 'no-cache, must-revalidate',
    });
    return;
  }

  // ── v41a: Flag PNG files at /flags/{iso2}.png ─────────────────
  // DaFluffyPotato CC0 pack — 252 flags in public/flags/ as 15×10 PNGs.
  // Cached aggressively since flags are immutable.
  if (url.pathname.startsWith('/flags/') && url.pathname.endsWith('.png')) {
    // Whitelist: only allow [a-z]{2}.png to prevent path-traversal/scan
    const m = url.pathname.match(/^\/flags\/([a-z]{2})\.png$/);
    if (!m) {
      res.writeHead(400);
      res.end('invalid flag path');
      return;
    }
    const iso2 = m[1];
    const f = path.join(__dirname, 'public', 'flags', iso2 + '.png');
    if (!fs.existsSync(f)) {
      res.writeHead(404);
      res.end('flag not found: ' + iso2);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(f).pipe(res);
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
    // v34: report simulated player count = real humans + active bots
    const realHumans = [...players.values()].filter(p => !p.isBot && p.ws).length;
    const activeBots = _activeBotCount();
    res.end(JSON.stringify({
      topCountries,
      conqueredCount:  distinctConquered.size,
      totalCountries:  _totalCountries(), // v62: for "X countries remain" stat
      topPlayers,
      totalPlayers:    realHumans + activeBots,
      totalBots:       activeBots,
    }));
    return;
  }

  // ── /api/admin/force-win — end game now, winner by pixel count ─────
  // Protected by the same TWEETS_ADMIN_SECRET used for the tweet panel.
  if (url.pathname === '/api/admin/force-win' && req.method === 'POST') {
    const expected = process.env.TWEETS_ADMIN_SECRET;
    const key = url.searchParams.get('key') || (req.headers['x-admin-key'] || '');
    if (!expected || key !== expected) {
      res.writeHead(expected ? 401 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: expected ? 'unauthorized' : 'admin disabled' }));
      return;
    }
    if (_worldConquestActive) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'world conquest already active' }));
      return;
    }
    // Determine winner by raw pixel count
    const topCountriesByPx = Object.entries(countryPxCount)
      .filter(([, cnt]) => cnt > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([cid, px]) => ({ countryId: cid, name: _countryName(cid), conquests: px, pixels: px }));
    const topPlayers = [...profiles.values()]
      .filter(p => p.username && p.points > 0 && !p.isBot)
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .slice(0, 5)
      .map(p => ({ username: p.username, points: p.points || 0, avatar: p.avatar, country: p.countryMain }));
    _worldConquestActive = true;
    _worldResetAt = Date.now() + WORLD_RESET_COUNTDOWN_MS;
    const conquered = _countDistinctConquered();
    const total     = _totalCountries();
    console.log('[Admin] force-win triggered — winner by pixel count:', topCountriesByPx[0]?.name || '?');
    // v61: store payload so late-joiners/refreshers see the same screen
    _worldConquestPayload = { type: 'world_conquest', conquered, total, topCountries: topCountriesByPx, topPlayers, resetAt: _worldResetAt, forceWin: true };
    broadcast(JSON.stringify(_worldConquestPayload));
    emitBotEvent({
      type:      'world_conquest',
      tier:       3,
      conquered, total,
      topCountries: topCountriesByPx,
      topPlayers,
      timestamp:  Date.now(),
      sassyText:  '🏆 GAME OVER (forced)! Winner by pixel count: ' + (topCountriesByPx[0]?.name || '?') + '. Resetting in 5 minutes.',
      forceWin:  true,
    });
    setTimeout(_resetWorld, WORLD_RESET_COUNTDOWN_MS);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, winner: topCountriesByPx[0] || null }));
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
    // v35: skip bots so leaderboard only shows real players
    const allRanked = [...profiles.values()]
      .filter(p => p.username && p.points > 0 && !p.isBot)
      .sort((a, b) => (b.points || 0) - (a.points || 0));
    const sorted = allRanked
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
    // v35: if caller supplies discord_id, include their rank position even when below top-20
    const viewerDiscordId = url.searchParams.get('discord_id');
    let viewer = null;
    if (viewerDiscordId) {
      const idx = allRanked.findIndex(p => p.discordId === viewerDiscordId);
      if (idx >= 0) {
        const p = allRanked[idx];
        viewer = {
          rank: idx + 1,
          username: p.username,
          avatar:   p.avatar,
          points:   p.points || 0,
          gameRank: p.rank,
          inTop20:  idx < 20,
        };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leaderboard: sorted, totalPlayers: allRanked.length, viewer }));
    return;
  }

  // ── v66: /api/stats/conquests — top 20 countries by conquest count ──
  if (url.pathname === '/api/stats/conquests') {
    const conquestCounts = {};
    for (const key of conqueredSet) {
      const parts = String(key).split(':');
      const attackerId = parts[1];
      if (attackerId) conquestCounts[attackerId] = (conquestCounts[attackerId] || 0) + 1;
    }
    const top20 = Object.entries(conquestCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([id, count], i) => ({ rank: i + 1, countryId: id, name: _countryName(id), count }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ conquests: top20, total: conqueredSet.size }));
    return;
  }

  // ── v36: /api/bot/country-name — fallback country-name lookup ──
  if (url.pathname === '/api/bot/country-name') {
    if (req.headers['x-bot-secret'] !== process.env.BOT_API_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const countryId = url.searchParams.get('country_id');
    const name = countryId ? (countryNames[countryId] || null) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ countryId, name }));
    return;
  }

  // ── v35: /api/bot/users-by-country — Discord IDs whose prefs include this country ──
  if (url.pathname === '/api/bot/users-by-country') {
    if (req.headers['x-bot-secret'] !== process.env.BOT_API_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const countryId = url.searchParams.get('country_id');
    if (!countryId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'country_id required' }));
      return;
    }
    const ids = [];
    for (const p of profiles.values()) {
      if (p.isBot) continue;
      if (String(p.countryMain) === String(countryId) ||
          String(p.countryB)    === String(countryId) ||
          String(p.countryC)    === String(countryId)) {
        ids.push(p.discordId);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ countryId, discordIds: ids }));
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
        // v61: if a world conquest is active, immediately replay it for this client
        // so refreshers and late-joiners see the conquest screen rather than the map
        if (_worldConquestActive && _worldConquestPayload) {
          try { ws.send(JSON.stringify(_worldConquestPayload)); } catch(e) {}
        }
        broadcastPlayers();
        break;
      }

      case 'set-country': {
        // v38: player re-picked country after their own was conquered
        // v40: also rejects culled countries (those with no playable pixels)
        const cid = String(msg.countryId);
        const geoIdx = parseInt(cid, 10);
        const hasPixels = geoPixels[geoIdx] && geoPixels[geoIdx].length > 0;
        if (permanentlyConquered.has(cid)) break; // can't select a conquered country
        if (countryNames && countryNames[cid] && hasPixels) {
          p.countryId = cid;
          p.countryIdx = getIdx(cid);
          if (!ownerPixels[p.countryIdx]) ownerPixels[p.countryIdx] = new Set();
          countryPxCount[cid] = countryPxCount[cid] || 0;
          console.log('[v38] Player', pid, 'switched to country', cid);
          broadcastPlayers();
        } else {
          console.log('[v40] Rejected set-country for', cid, 'no playable pixels');
        }
        break;
      }
      case 'stroke': {
        if (!player.countryId || !Array.isArray(msg.pixels)) return;
        if (msg.pixels.length > MAX_STROKE_PX) return;
        // Conquered country — player must repick; reject silently (client is notified via 'conquest' broadcast)
        if (permanentlyConquered.has(player.countryId)) return;
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
          // v65: track 24h activity for status reports
          _recordActivity(player.discordId, player.countryId, changed.length);
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
        if (msg.pixels.length < 1 || msg.pixels.length > 5000) return; // v68: ≥1 (was ≥4)
        const enc = detectEncirclement(msg.pixels, player.countryId);
        if (!enc) return;
        const { changed: encChanged, conquests: encConquests, reversals: encReversals } =
          applyPixels(enc.enclosed, player.countryId);
        if (encChanged.length) queueDelta(encChanged);
        // v60: broadcast any conquest/reversal triggered by encirclement
        encConquests.forEach(c => broadcast(JSON.stringify({ type: 'conquest', ...c })));
        encReversals.forEach(r => broadcast(JSON.stringify({ type: 'reversal', ...r })));
        if (player.discordId && encConquests.length) {
          updateProfileXP(player.discordId, encConquests.length * 50);
          const _ep = getProfile(player.discordId);
          _ep.conquestsMade += encConquests.length;
          _ep.points        += encConquests.length * 50;
          markProfilesDirty();
        }
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
