// v92v: override:true makes .env authoritative over any pre-set process env.
// Without it, dotenv leaves existing vars untouched, so PM2's cached/stale env
// (e.g. a leftover DISCORD_REDIRECT_URI=http://<ip>:3000/...) silently wins over
// the .env value and breaks Discord OAuth ("invalid redirect URI"). This ends
// that whole class of PM2-stale-env bug — .env is now the single source of truth.
require('dotenv').config({ override: true });
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
const crypto    = require('crypto'); // v98b: timing-safe admin auth
const os        = require('os');
const { execFile } = require('child_process');
const { renderCountryPNG, renderWorldPNG, preloadFlags, preloadBaseMap, getFlagImage } = require('./mapshot'); // v88/v92e/v92m: tweet screenshots + flags; v136: baked basemap
const xposter = require('./xposter'); // v93l: optional manual-approve X (Twitter) poster

// ── Config ────────────────────────────────────────────────────────
const PORT               = parseInt(process.env.PORT || '3000', 10);
const SERVER_VERSION       = '2026-06-28-v145';
console.log('PixelAnnex server', SERVER_VERSION);
const MAP_W              = 2048;
const MAP_H              = 1024;
const MAP_PX             = MAP_W * MAP_H;
// v95g: countries that must NEVER be playable — no bot, no conquest. Mirrors the
// client's NON_PLAYABLE_IDS (picker hides them), but the SERVER also needs it:
// these geos keep a few stray pixels after the client's lat<-60 / artifact cull
// (e.g. Antarctica's 10-px sliver), so without this the server span a bot for
// them and they actively painted + conquered. Keep in sync with the client list.
const NON_PLAYABLE_IDS   = new Set([
  '10',  // Antarctica (10px sliver survives the lat<-60 cull)
  '74',  // Bouvet Island
  '260', // French Southern Territories
  '334', // Heard Island & McDonald Islands
  '239', // South Georgia & South Sandwich Is.
]);
// v98b: full server-side playability check — mirrors the client picker rules
// (NON_PLAYABLE_IDS + MIN_PLAYABLE_PX + real name) so Vatican/Gibraltar/
// "Country 133"-style artifacts can't be picked via stale clients or raw WS,
// and never get bots. geoTotal arrives with the first client join, so the size
// floor only applies once the map data exists (otherwise nothing would be
// pickable at boot).
const MIN_PLAYABLE_PX_SRV = 5; // keep in sync with client MIN_PLAYABLE_PX
function _isPlayableCountry(id) {
  const s = String(id);
  if (NON_PLAYABLE_IDS.has(s)) return false;
  const nm = countryNames[s];
  if (!nm || nm === 'Disputed Territory') return false; // unnamed NE artifacts
  if (Object.keys(geoTotal).length > 0) {
    if ((geoTotal[parseInt(s, 10)] || 0) < MIN_PLAYABLE_PX_SRV) return false;
  }
  return true;
}
const CONQUEST_THRESHOLD = 0.60; // legacy base — superseded by conquestThreshold() below (kept for any stray refs)
// ── v91: progressive, size-scaled conquest threshold ──────────────
// Small countries need a HIGHER share to conquer (75%) because 70% of a tiny
// country is trivially reached; large countries need 70%. Log scale between
// 500px (→0.75) and 50,000px (→0.70). This function MUST stay byte-identical
// to the copy in pixelworld_v5.html so client prediction matches the server.
// v91c: small-country cap lowered 0.90 → 0.75 — 90% was too hard to reach when
// unclaimed pixels are scarce in a small territory.
function conquestThreshold(total) {
  if (!total || total <= 500)   return 0.75;
  if (total >= 50000)           return 0.70;
  const t = (Math.log10(total) - Math.log10(500)) / (Math.log10(50000) - Math.log10(500));
  return 0.75 - t * 0.05;
}
// Reversal sits 15 points below conquest (hysteresis) so a freshly-fallen
// country doesn't flip back the instant it loses a single pixel.
function reversalThreshold(total) {
  return Math.max(0, conquestThreshold(total) - 0.15);
}
// v91: a country has "fallen by plurality" when its NATIVE holding drops to
// this fraction or below — i.e. it's been carved up by 2+ attackers, none of
// whom individually reached conquestThreshold(). The largest foreign holder
// is then declared the conqueror.
const FALLEN_NATIVE_FRAC = 0.05; // (legacy — retained for the debug endpoint label)
// v93h: contested-territory conquest. Measuring fall vs TOTAL land made big /
// multi-attacked countries unconquerable — their large UNPAINTED interior (faint
// prepopulate, never actively painted) diluted every %. Instead a country falls
// to its largest foreign holder when the CONTESTED (painted) territory is
// foreign-dominated and a real chunk of the country is in play, and the leading
// attacker out-holds the native. Tunables:
const CONTEST_FLOOR      = 0.40; // >= 40% of the country must be painted (painted-relative path)
const CONTEST_MAJORITY   = 0.85; // painted-relative bar: foreigners hold >= 85% of the PAINTED area
const CONTEST_TOTAL_FRAC = 0.85; // v95n: group/contested bar vs ALL land — foreigners hold >= 85% of the WHOLE country
// v95n: the lenient painted-relative path (CONTEST_FLOOR/CONTEST_MAJORITY, which
// discounts unpainted native land) only applies to GENUINELY LARGE countries where
// reaching 85% of TOTAL is impractical. Small/medium countries (Denmark 103px,
// New Zealand, …) must hit the real bar — 75% single (champion) or 85% of total
// (group) — so a passive/fresh country can't be taken at ~45% by dominating the
// little that's painted.
const CONTEST_LARGE_MIN  = 8000; // px; painted-relative contested allowed only above this
// ── v93p (#1): empire-backed homeland defense ─────────────────────
// Each territory a country has conquered ("outpost") raises the bar to take its
// HOMELAND, so expansion makes you harder to dislodge — gains feel durable while
// staying defendable. Applied as an EFFECTIVE threshold layered on top of the
// byte-identical conquestThreshold(); the same function is mirrored in
// pixelworld_v5.html so client-side conquest prediction stays aligned.
const EMPIRE_DEF_STEP = 0.02;  // +2% conquest threshold per outpost held
const EMPIRE_DEF_MAX  = 0.20;  // capped at +20%
const EMPIRE_DEF_CEIL = 0.95;  // never require more than 95% (always conquerable)
function empireDefenseBonus(countryId) {
  let outposts = 0;
  const id = String(countryId);
  for (const k of conqueredSet) {           // keys: "geoId:conquerorId"
    if (String(k).split(':')[1] === id) outposts++;
  }
  return Math.min(EMPIRE_DEF_MAX, outposts * EMPIRE_DEF_STEP);
}
const MAX_STROKE_PX      = 500;
const BROADCAST_MS       = 1000;  // v77: 1Hz delta broadcast (was 20Hz/50ms).
                                    // Client visually staggers paints over ~900ms
// v92p: per-region viewport delta filter. Zoomed-in clients report their visible
// rect; the server then sends them only the deltas inside it (+ a one-shot region
// snapshot on viewport change to correct stale off-screen state). Clients viewing
// most of the map ("full") still get the shared broadcast. Kill-switch + a max-area
// guard (above which a client is treated as full — filtering/snapshot stop paying off).
const VIEWPORT_FILTER_ENABLED  = true;
const VIEWPORT_MAX_FILTER_AREA = 600000; // ~28% of the 2048x1024 map
                                    // so users see smooth ambient activity at
                                    // 1/20th the bandwidth. Player's own paints
                                    // remain instant client-side (claimPixel).
const PING_MS            = 10000;
const TIMEOUT_MS         = 30000;

// ── Bot config ────────────────────────────────────────────────────
const BOT_TICK_MS         = 1000;  // v35: doubled paint rate (was 2000)
const BOT_PIXELS_PER_TICK  = 1;    // pixels per stroke per bot — halved
const BOT_BUCKET_MAX       = 60;   // smaller cap to prevent burst spikes
// v100 (Phase 2A): bots are a redistributable POOL. Each country's bot carries
// `units` (1..BOT_UNITS_MAX); throughput + bucket capacity scale with units.
// When a country falls its units move to active countries (cap below), keeping
// the map lively as the field shrinks. Each live human on a country deactivates
// one unit ("one bot per player").
const BOT_UNITS_MAX        = 5;

// ── v34: Bot activity cycle — simulates "real player" login/logout ──
// Each bot drifts between active and idle states. Only active bots paint and
// are counted in the simulated player count. The target active-bot count
// follows a daily cycle (rush hours) so the world feels like real humans
// logging in and out.
const BOT_ACTIVE_MIN_MS = 5  * 60 * 1000;
const BOT_ACTIVE_MAX_MS = 30 * 60 * 1000;
const BOT_IDLE_MIN_MS   = 3  * 60 * 1000;
const BOT_IDLE_MAX_MS   = 20 * 60 * 1000;
const SIM_PLAYER_MIN    = 50;
const SIM_PLAYER_MAX    = 200;
// v80: daily rush-hour cycle (UTC).
//   Peak (~200 active bots) at 21:00 UTC — that's evening in EU + afternoon in Americas
//   Trough (~50 active bots) at 09:00 UTC — late night Americas, early morning Asia
// Plus ±15 organic noise so the curve isn't too predictable.
const SIM_NOISE_RANGE = 15;
let _simNoise = 0; // wanders slowly via _tickBotActivity
function _computeRushHourTarget() {
  const hoursUTC = (Date.now() / 3600000) % 24;
  const center   = (SIM_PLAYER_MIN + SIM_PLAYER_MAX) / 2; // 125
  const amp      = (SIM_PLAYER_MAX - SIM_PLAYER_MIN) / 2; // 75
  // sin peaks at hours=21 (tShift=15: 21-15=6, 6*2π/24 = π/2)
  const wave     = Math.sin((hoursUTC - 15) * 2 * Math.PI / 24);
  let target     = center + amp * wave + _simNoise;
  if (target < SIM_PLAYER_MIN) target = SIM_PLAYER_MIN;
  if (target > SIM_PLAYER_MAX) target = SIM_PLAYER_MAX;
  return Math.round(target);
}
let _simTargetActive = _computeRushHourTarget();
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
// v100 (Phase 2A): live human count per country (rebuilt in broadcastPlayers on
// every join/leave). Drives "one bot unit deactivated per human player".
const _humansByCountry = new Map();
function _rebuildHumansByCountry() {
  _humansByCountry.clear();
  for (const p of players.values()) {
    if (p.isBot || !p.ws || !p.countryId) continue;
    const k = String(p.countryId);
    _humansByCountry.set(k, (_humansByCountry.get(k) || 0) + 1);
  }
}
function _effectiveBotUnits(bot) {
  if (!bot) return 0;
  const humans = _humansByCountry.get(String(bot.countryId)) || 0;
  return Math.max(0, (bot.units || 1) - humans);
}
// Move `units` bot-units from a fallen country to active under-cap countries —
// alliance heir (preferId) first, then the countries that need help most.
function _redistributeBotUnits(fromCountryId, units, preferId) {
  if (!(units > 0)) return;
  const underCap = () => {
    const out = [];
    for (const [cid, b] of bots) {
      if (String(cid) === String(fromCountryId)) continue;
      if (permanentlyConquered.has(String(cid))) continue;
      if ((b.units || 1) >= BOT_UNITS_MAX) continue;
      out.push(cid);
    }
    return out;
  };
  let moved = 0;
  for (let n = 0; n < units; n++) {
    const cands = underCap();
    if (!cands.length) break;
    let pick = null;
    if (preferId && bots.has(String(preferId)) &&
        (bots.get(String(preferId)).units || 1) < BOT_UNITS_MAX &&
        !permanentlyConquered.has(String(preferId))) {
      pick = String(preferId);
    } else {
      cands.sort((a, b) => ((bots.get(a).units || 1) - (bots.get(b).units || 1)) ||
                           ((countryPxCount[a] || 0) - (countryPxCount[b] || 0)));
      pick = cands[0];
    }
    const tb = bots.get(pick);
    tb.units = (tb.units || 1) + 1;
    tb.bucket = Math.min(BOT_BUCKET_MAX * tb.units, (tb.bucket || 0) + BOT_BUCKET_MAX * 0.5);
    moved++;
  }
  if (moved) console.log(`[Bot] redistributed ${moved} unit(s) from ${fromCountryId}` + (preferId ? ` (heir ${preferId})` : ''));
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
  // v80: recompute target from rush-hour cycle + slow-wandering noise.
  // The wave updates every tick (smooth daily curve), noise drifts in chunks
  // every ~3 min to add organic variation on top.
  if (!_tickBotActivity._lastDrift || now - _tickBotActivity._lastDrift > 3 * 60 * 1000) {
    _tickBotActivity._lastDrift = now;
    // Random walk on noise: -8..+8 each step, clamped to ±SIM_NOISE_RANGE
    _simNoise += _rand(-8, 8);
    if (_simNoise < -SIM_NOISE_RANGE) _simNoise = -SIM_NOISE_RANGE;
    if (_simNoise >  SIM_NOISE_RANGE) _simNoise =  SIM_NOISE_RANGE;
  }
  _simTargetActive = _computeRushHourTarget();
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
        // v95s: drop duplicate PENDING drafts with identical text (e.g. the same
        // news headline re-queued across restarts before the persisted-queue
        // dedupe existed). Keep the first occurrence (newest, since newest-first).
        const _seenText = new Set();
        for (const t of raw) {
          if (t && t.status === 'pending') {
            if (_seenText.has(t.text)) continue; // skip dup
            _seenText.add(t.text);
          }
          tweetQueue.push(t);
        }
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

// v84: notable-countries filter for tweets. Event tweets (conquest, multi-attack,
// nuke, reversal) only push if at least one of the involved countries is in this
// set. Daily/status/community tweets pass through unaffected (they're not country-
// specific). Set is ~30 globally recognised countries — covers the headlines we
// want to amplify, drops the obscure ones that wouldn't engage a Twitter audience.
const NOTABLE_COUNTRY_IDS = new Set([
  '840', // USA
  '156', // China
  '643', // Russia
  '826', // United Kingdom
  '276', // Germany
  '250', // France
  '392', // Japan
  '356', // India
  '076', // Brazil
  '036', // Australia
  '124', // Canada
  '380', // Italy
  '724', // Spain
  '484', // Mexico
  '410', // South Korea
  '364', // Iran
  '376', // Israel
  '792', // Turkey
  '682', // Saudi Arabia
  '360', // Indonesia
  '586', // Pakistan
  '408', // North Korea
  '804', // Ukraine
  '616', // Poland
  '710', // South Africa
  '818', // Egypt
  '566', // Nigeria
  '032', // Argentina
  '170', // Colombia
  '764', // Thailand
  '704', // Vietnam
  '275', // Palestine
  '158', // Taiwan
]);

// v92f: country IDs flow through the game UNPADDED (76, 36, 32) but a few
// NOTABLE entries above are zero-padded ('076','036','032'). String(c) never
// matched those, so Brazil/Australia/Argentina silently failed the filter.
// Normalize both sides via parseInt before comparing.
const _NOTABLE_NUM = new Set([...NOTABLE_COUNTRY_IDS].map(s => parseInt(s, 10)));
function isNotableCountry(id) {
  const n = typeof id === 'number' ? id : parseInt(id, 10);
  return Number.isFinite(n) && _NOTABLE_NUM.has(n);
}

function pushTweetDraft({ type, text, dedupeKey, throttleKey, countries, imageUrl }) {
  const now = Date.now();
  // v84: notable-countries filter — only fire event tweets if at least one
  // involved country is notable. Calls without `countries` (community,
  // daily, status) pass through.
  if (Array.isArray(countries) && countries.length > 0) {
    const hasNotable = countries.some(c => isNotableCountry(c));
    if (!hasNotable) return null;
    // v99h: per-country cooldown — at most ONE draft mentioning a given country
    // per 12h window, across ALL generators (operator saw two #Iran drafts
    // queued at the same moment — Iran in two football fixtures). Checked
    // against the persisted queue so it survives restarts. Older drafts
    // (pre-v99h) have no countries field and don't block.
    const COUNTRY_DRAFT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
    const _cs = countries.map(String);
    if (tweetQueue.some(d => Array.isArray(d.countries) &&
          (now - d.ts) < COUNTRY_DRAFT_COOLDOWN_MS &&
          d.countries.some(c => _cs.includes(String(c))))) return null;
  }
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
  const _text = String(text || '').slice(0, 280);
  // v95s: persisted-queue dedupe. _tweetLastByKey (above) is in-memory and lost on
  // restart, so frequent restarts re-ran the 90s news scrape and re-queued the same
  // headline tweet repeatedly. The queue IS persisted — so skip if an identical
  // PENDING draft (same dedupeKey, or same text) is already waiting for review.
  if (tweetQueue.some(d => d.status === 'pending' &&
        ((dedupeKey && d.dedupeKey === dedupeKey) || d.text === _text))) return null;
  const draft = {
    id:     Math.random().toString(36).slice(2, 10),
    ts:     now,
    type,
    text:   _text,
    dedupeKey: dedupeKey || null, // v95s: stored so dedupe survives restarts
    countries: (Array.isArray(countries) && countries.length) ? countries.map(String) : null, // v99h: for per-country cooldowns
    imageUrl: imageUrl || null,   // v88: optional screenshot URL for the post
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

// ── v114: nominal GDP (USD) by country, for tweet/Discord colour ──────────────
// Approx 2023 nominal GDP. Keyed by lowercased Natural Earth admin name (matches
// the client COUNTRY_GDP table). Used to add "— $1.7T GDP" to conquest / siege /
// fallen-spotlight posts where a single country is the clear subject.
const COUNTRY_GDP = {
  'united states of america':27360e9,'china':17790e9,'germany':4456e9,'japan':4213e9,
  'india':3550e9,'united kingdom':3340e9,'france':3030e9,'italy':2255e9,'brazil':2174e9,
  'canada':2140e9,'russia':2021e9,'mexico':1789e9,'australia':1724e9,'south korea':1713e9,
  'spain':1580e9,'indonesia':1371e9,'netherlands':1118e9,'turkey':1108e9,'saudi arabia':1067e9,
  'switzerland':905e9,'poland':811e9,'taiwan':790e9,'argentina':641e9,'belgium':627e9,
  'sweden':593e9,'ireland':564e9,'norway':546e9,'austria':526e9,'thailand':515e9,
  'israel':510e9,'united arab emirates':504e9,'singapore':501e9,'bangladesh':446e9,
  'philippines':437e9,'vietnam':430e9,'malaysia':415e9,'denmark':404e9,'iran':388e9,
  'hong kong':382e9,'south africa':378e9,'colombia':364e9,'nigeria':363e9,'romania':351e9,
  'egypt':396e9,'pakistan':338e9,'chile':335e9,'czechia':330e9,'finland':300e9,
  'portugal':287e9,'peru':268e9,'kazakhstan':261e9,'iraq':254e9,'new zealand':252e9,
  'algeria':240e9,'greece':238e9,'qatar':235e9,'hungary':212e9,'ukraine':179e9,
  'kuwait':161e9,'ethiopia':156e9,'morocco':147e9,'slovakia':133e9,'ecuador':121e9,
  'dominican rep.':121e9,'cuba':107e9,'kenya':110e9,'oman':108e9,'guatemala':102e9,
  'bulgaria':102e9,'angola':94e9,'venezuela':92e9,'uzbekistan':90e9,'luxembourg':89e9,
  'costa rica':86e9,'panama':83e9,'croatia':81e9,'tanzania':79e9,"côte d'ivoire":79e9,
  'azerbaijan':78e9,'lithuania':78e9,'uruguay':77e9,'ghana':76e9,'serbia':75e9,
  'belarus':73e9,'slovenia':68e9,'dem. rep. congo':67e9,'myanmar':65e9,'tunisia':50e9,
  'jordan':50e9,'cameroon':49e9,'uganda':49e9,'libya':45e9,'bolivia':45e9,
  'bahrain':44e9,'paraguay':43e9,'latvia':47e9,'nepal':41e9,'estonia':41e9,
  'el salvador':34e9,'honduras':34e9,'zimbabwe':35e9,'cyprus':32e9,'senegal':31e9,
  'iceland':31e9,'cambodia':31e9,'georgia':30e9,'sudan':30e9,'zambia':28e9,
  'north korea':28e9,'bosnia and herz.':27e9,'armenia':24e9,'albania':23e9,'guinea':21e9,
  'mali':21e9,'gabon':21e9,'mozambique':21e9,'haiti':20e9,'yemen':21e9,
  'burkina faso':20e9,'botswana':20e9,'malta':20e9,'benin':19e9,'mongolia':18e9,
  'nicaragua':17e9,'niger':17e9,'madagascar':16e9,'moldova':16e9,'laos':15e9,
  'afghanistan':14e9,'rwanda':14e9,'mauritius':14e9,'macedonia':14e9,'north macedonia':14e9,
  'malawi':13e9,'chad':13e9,'kyrgyzstan':12e9,'tajikistan':12e9,'namibia':12e9,
  'somalia':11e9,'mauritania':10e9,'syria':9e9,'togo':9e9,'montenegro':7e9,
};
const GDP_ALIASES = {
  'united states':'united states of america','usa':'united states of america',
  'great britain':'united kingdom','czech rep.':'czechia','viet nam':'vietnam',
  'congo (kinshasa)':'dem. rep. congo','dr congo':'dem. rep. congo',
  'ivory coast':"côte d'ivoire",'dominican republic':'dominican rep.',
  'bosnia and herzegovina':'bosnia and herz.','uae':'united arab emirates',
};
function _countryGDP(id) {
  const name = countryNames[id];
  if (!name) return 0;
  const k = name.toLowerCase().trim();
  if (COUNTRY_GDP[k] != null) return COUNTRY_GDP[k];
  if (GDP_ALIASES[k] && COUNTRY_GDP[GDP_ALIASES[k]] != null) return COUNTRY_GDP[GDP_ALIASES[k]];
  return 0;
}
function _fmtGDPCompact(v) {
  if (!v || v <= 0) return null;
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
  if (v >= 1e9)  return '$' + Math.round(v / 1e9) + 'B';
  if (v >= 1e6)  return '$' + Math.round(v / 1e6) + 'M';
  return '$' + v;
}
// " — $1.7T GDP" suffix for a country, or '' if unknown. Append only where one
// country is the clear subject (conquest, multi-attack, fallen spotlight).
function _gdpTag(id) {
  const g = _fmtGDPCompact(_countryGDP(id));
  return g ? (' — ' + g + ' GDP') : '';
}

// ── v115e: leader-portrait images for tweets ─────────────────────────────────
// Mirrors the client _avatarURL mapping. Returns a /Avatars/{file}.png media URL
// (served by the server, uploadable by xposter) for a country, or null. Notable
// countries get a specific face; everyone else gets a region-matched generic.
// Used to attach a leader portrait to country-tagged tweets (news, football,
// fallen-spotlight) that otherwise had no image.
const _AVATAR_NOTABLE = {
  '840':'USA','156':'CHINA','643':'RUSSIA','826':'ENGLAND','276':'Germany','250':'France',
  '392':'Japan','356':'India','76':'Brazil','36':'Australia','124':'Canada','380':'Italy',
  '724':'Spain','484':'Mexico','410':'SouthKorea','364':'Iran','376':'Isreal','792':'Turkey',
  '682':'SaudiArabia','360':'Indonesia','586':'Pakistan','408':'NorthKorea','804':'Ukraine',
  '616':'Poland','710':'SouthAfrica','818':'Egypt','566':'Nigeria','32':'Argentina',
  '170':'Columbia','764':'Thailand','704':'VN','275':'Palestine','158':'TW',
};
const _AVATAR_GENERIC = { asia:'GenericAsia', africa:'GenericAfrica', me:'GenericMiddleEast' };
const _AVATAR_REGION = {};
(function () {
  const asia = ['050','064','096','104','116','144','344','398','417','418','446','458','462','496','524','608','626','702','762','795','860'];
  const me   = ['004','031','048','051','196','268','368','400','414','422','512','634','760','784','887'];
  const africa = ['012','024','072','108','120','132','140','148','174','178','180','204','226','231','232','262','266','270','288','324','384','404','426','430','434','450','454','466','478','480','504','508','516','562','646','686','694','706','728','729','748','768','788','800','834','854','894','716','624'];
  asia.forEach(c => _AVATAR_REGION[String(+c)] = 'asia');
  me.forEach(c => _AVATAR_REGION[String(+c)] = 'me');
  africa.forEach(c => _AVATAR_REGION[String(+c)] = 'africa');
})();
const _AVATARS_DIR = path.join(__dirname, 'public', 'Avatars');
function _avatarMediaUrl(id) {
  const k = String(parseInt(id, 10));
  // Try the specific face, then a regional generic, then a western generic —
  // falling through to the first that actually exists on disk (so a missing
  // notable file, e.g. VN, still yields a regional/western portrait).
  const candidates = [];
  if (_AVATAR_NOTABLE[k]) candidates.push(_AVATAR_NOTABLE[k]);
  const r = _AVATAR_REGION[k];
  if (r && _AVATAR_GENERIC[r]) candidates.push(_AVATAR_GENERIC[r]);
  candidates.push((parseInt(id, 10) % 2) ? 'GenericWest' : 'GenericWest2');
  for (const f of candidates) {
    if (fs.existsSync(path.join(_AVATARS_DIR, f + '.png'))) return '/Avatars/' + f + '.png';
  }
  return null;
}
// When several countries are tagged, prefer a notable one for a recognisable face.
function _portraitUrlFor(ids) {
  if (!Array.isArray(ids) || !ids.length) return _avatarMediaUrl(ids);
  const notable = ids.find(id => isNotableCountry(String(id)));
  return _avatarMediaUrl(notable || ids[0]);
}
function _countryTag(id) {
  // ISO 3166-1 numeric → hashtag-safe name (alphanumeric only)
  const n = _countryName(id).replace(/[^A-Za-z0-9]/g, '');
  return n ? '#' + n : '';
}

// ── v88: localized tagging (flag emoji + national hashtags) ──────
// ISO 3166-1 numeric → alpha-2 for the notable countries we tag (others
// fall back to no flag). Numeric keys are unpadded strings to match the
// numeric country IDs used everywhere on the server.
const ISO_NUM_TO_A2 = {
  '840':'US','156':'CN','643':'RU','826':'GB','276':'DE','250':'FR','392':'JP',
  '356':'IN','76':'BR','36':'AU','124':'CA','380':'IT','724':'ES','484':'MX',
  '410':'KR','364':'IR','376':'IL','792':'TR','682':'SA','360':'ID','586':'PK',
  '408':'KP','804':'UA','616':'PL','710':'ZA','818':'EG','566':'NG','32':'AR',
  '170':'CO','764':'TH','704':'VN','275':'PS','158':'TW','300':'GR','528':'NL',
  '752':'SE','578':'NO','246':'FI','208':'DK','756':'CH','40':'AT','56':'BE',
  '620':'PT','372':'IE','554':'NZ','152':'CL','604':'PE','862':'VE','886':'__',
};
// Short, recognisable hashtags for the biggest countries; fallback = stripped name.
const NAT_HASHTAG = {
  '840':'#USA','826':'#UK','156':'#China','643':'#Russia','276':'#Germany',
  '250':'#France','392':'#Japan','356':'#India','76':'#Brazil','410':'#Korea',
  '408':'#NorthKorea','364':'#Iran','376':'#Israel','804':'#Ukraine','792':'#Turkey',
};
// Convert alpha-2 to a regional-indicator flag emoji (🇺🇸 etc.).
function _flagEmoji(id) {
  const a2 = ISO_NUM_TO_A2[String(parseInt(id, 10))];
  if (!a2 || a2.length !== 2 || a2 === '__') return '';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (a2.charCodeAt(0) - 65)) +
         String.fromCodePoint(A + (a2.charCodeAt(1) - 65));
}
// "🇺🇸 USA" — flag + name for use inside tweet bodies.
function _flagName(id) {
  const flag = _flagEmoji(id);
  return (flag ? flag + ' ' : '') + _countryName(id);
}
// National hashtag (short alias or stripped name).
function _natHashtag(id) {
  return NAT_HASHTAG[String(parseInt(id, 10))] || _countryTag(id);
}

// v97d: holder-aware display for war notifications (tweets + Discord). A country
// whose homeland has been conquered is named by its CURRENT holder, noting the
// fallen native — e.g. "Brazil (formerly USA)". A still-native country is just its
// own name. Prevents "USA defending…" posts after USA has already fallen.
// (_foreignHolderOf is a hoisted fn declaration defined later in the file.)
function _geoDefenderName(geoId) {
  const holder = _foreignHolderOf(geoId);
  if (holder && String(holder) !== String(geoId)) {
    return `${_countryName(holder)} (formerly ${_countryName(geoId)})`;
  }
  return _countryName(geoId);
}
function _geoDefenderTag(geoId) {
  const holder = _foreignHolderOf(geoId);
  if (holder && String(holder) !== String(geoId)) {
    return `${_natHashtag(holder)} (formerly ${_natHashtag(geoId)})`;
  }
  return _natHashtag(geoId);
}

// ── v88: tweet screenshots ───────────────────────────────────────
// Render a 256x256 PNG of a country, save under /shots, return a public
// URL path (served by the HTTP handler). Returns null if rendering fails
// or @napi-rs/canvas isn't installed. Keeps only the most recent files.
const SHOTS_DIR = path.join(__dirname, 'shots');
const SHOTS_MAX = 60;
try { if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch (e) {}
function _pruneShots() {
  try {
    const files = fs.readdirSync(SHOTS_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ f, t: fs.statSync(path.join(SHOTS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (let i = SHOTS_MAX; i < files.length; i++) {
      try { fs.unlinkSync(path.join(SHOTS_DIR, files[i].f)); } catch (e) {}
    }
  } catch (e) {}
}
// v92m: FULL ISO numeric -> alpha-2 (lowercase, padded keys) for flag-file lookup
// (public/flags/{a2}.png). Distinct from the partial uppercase ISO_NUM_TO_A2 above,
// which exists for regional-indicator emoji on a handful of major countries.
const FLAG_NUM_TO_A2 = {
  '004':'af','008':'al','010':'aq','012':'dz','016':'as','020':'ad','024':'ao','028':'ag',
  '031':'az','032':'ar','036':'au','040':'at','044':'bs','048':'bh','050':'bd','051':'am',
  '052':'bb','056':'be','060':'bm','064':'bt','068':'bo','070':'ba','072':'bw','074':'bv',
  '076':'br','084':'bz','086':'io','090':'sb','092':'vg','096':'bn','100':'bg','104':'mm',
  '108':'bi','112':'by','116':'kh','120':'cm','124':'ca','132':'cv','136':'ky','140':'cf',
  '144':'lk','148':'td','152':'cl','156':'cn','158':'tw','162':'cx','166':'cc','170':'co',
  '174':'km','175':'yt','178':'cg','180':'cd','184':'ck','188':'cr','191':'hr','192':'cu',
  '196':'cy','203':'cz','204':'bj','208':'dk','212':'dm','214':'do','218':'ec','222':'sv',
  '226':'gq','231':'et','232':'er','233':'ee','234':'fo','238':'fk','239':'gs','242':'fj',
  '246':'fi','248':'ax','250':'fr','254':'gf','258':'pf','260':'tf','262':'dj','266':'ga',
  '268':'ge','270':'gm','275':'ps','276':'de','288':'gh','292':'gi','296':'ki','300':'gr',
  '304':'gl','308':'gd','312':'gp','316':'gu','320':'gt','324':'gn','328':'gy','332':'ht',
  '334':'hm','336':'va','340':'hn','344':'hk','348':'hu','352':'is','356':'in','360':'id',
  '364':'ir','368':'iq','372':'ie','376':'il','380':'it','384':'ci','388':'jm','392':'jp',
  '398':'kz','400':'jo','404':'ke','408':'kp','410':'kr','414':'kw','417':'kg','418':'la',
  '422':'lb','426':'ls','428':'lv','430':'lr','434':'ly','438':'li','440':'lt','442':'lu',
  '446':'mo','450':'mg','454':'mw','458':'my','462':'mv','466':'ml','470':'mt','474':'mq',
  '478':'mr','480':'mu','484':'mx','492':'mc','496':'mn','498':'md','499':'me','500':'ms',
  '504':'ma','508':'mz','512':'om','516':'na','520':'nr','524':'np','528':'nl','531':'cw',
  '533':'aw','534':'sx','535':'bq','540':'nc','548':'vu','554':'nz','558':'ni','562':'ne',
  '566':'ng','570':'nu','574':'nf','578':'no','580':'mp','581':'um','583':'fm','584':'mh',
  '585':'pw','586':'pk','591':'pa','598':'pg','600':'py','604':'pe','608':'ph','612':'pn',
  '616':'pl','620':'pt','624':'gw','626':'tl','630':'pr','634':'qa','638':'re','642':'ro',
  '643':'ru','646':'rw','652':'bl','654':'sh','659':'kn','660':'ai','662':'lc','663':'mf',
  '666':'pm','670':'vc','674':'sm','678':'st','682':'sa','686':'sn','688':'rs','690':'sc',
  '694':'sl','702':'sg','703':'sk','704':'vn','705':'si','706':'so','710':'za','716':'zw',
  '724':'es','728':'ss','729':'sd','732':'eh','740':'sr','744':'sj','748':'sz','752':'se',
  '756':'ch','760':'sy','762':'tj','764':'th','768':'tg','772':'tk','776':'to','780':'tt',
  '784':'ae','788':'tn','792':'tr','795':'tm','796':'tc','798':'tv','800':'ug','804':'ua',
  '807':'mk','818':'eg','826':'gb','831':'gg','832':'je','833':'im','834':'tz','840':'us',
  '850':'vi','854':'bf','858':'uy','860':'uz','862':'ve','876':'wf','882':'ws','887':'ye',
  '894':'zm',
};
function _isoNumericToA2(numId) {
  if (numId == null) return null;
  return FLAG_NUM_TO_A2[String(numId).padStart(3, '0')] || null;
}
// Preload flag images once at startup so makeCountryShot can draw them synchronously.
preloadFlags(path.join(__dirname, 'public', 'flags')).catch(e =>
  console.warn('[Mapshot] flag preload failed:', e.message));
// v136: preload the baked basemap art so world-snapshot frames (the daily GIF) draw on
// the real terrain instead of the procedural grey-land/blue-ocean fill.
preloadBaseMap(path.join(__dirname, 'public')).catch(e =>
  console.warn('[Mapshot] basemap preload failed:', e.message));

// v92g: outlier-robust bbox for SCREENSHOTS only. geoBbox is the true min/max
// over every pixel (needed by detectEncirclement), but map-data artifacts give
// some countries stray pixels far across the map (the placeFlag code notes e.g.
// El Salvador's 4 outlier "island" pixels in the Mediterranean). A raw bbox
// then spans half the world and the screenshot looks fully zoomed out
// (Montenegro symptom). This computes a percentile-trimmed bbox: drop the
// outer 2% of pixels on each axis so a handful of strays can't blow it up.
// Cached per country (territory shape is static).
const _shotBboxCache = {};
function _shotBbox(geoNum) {
  if (_shotBboxCache[geoNum]) return _shotBboxCache[geoNum];
  const pixels = geoPixels[geoNum];
  if (!pixels || pixels.length === 0) return null;
  const n = pixels.length;
  const xs = new Uint16Array(n), ys = new Uint16Array(n);
  for (let k = 0; k < n; k++) { const pi = pixels[k]; xs[k] = pi % MAP_W; ys[k] = (pi / MAP_W) | 0; }
  xs.sort(); ys.sort();
  // 2nd / 98th percentile on each axis (clamped to valid indices)
  const lo = Math.floor(n * 0.02), hi = Math.min(n - 1, Math.ceil(n * 0.98));
  const bbox = { minX: xs[lo], maxX: xs[hi], minY: ys[lo], maxY: ys[hi] };
  _shotBboxCache[geoNum] = bbox;
  return bbox;
}

// v92l: flag-centered framing for screenshots. The percentile bbox (_shotBbox)
// still trusted axis extremes and could leave small countries (Montenegro) zoomed
// out when strays exceeded the 2% trim. This instead replicates the client's
// placeFlag density algorithm server-side:
//   1. BFS the country's land pixels into connected components; take the LARGEST
//      (the main landmass) — stray cross-map artifact pixels are tiny separate
//      components and are discarded entirely, not merely trimmed.
//   2. Bucket that component into a 32x32 density grid; the densest cell's mean
//      position is the "flag spot" — exactly where the in-game flag sits.
//   3. Return a square bbox CENTERED on the flag spot, sized to still contain the
//      whole main landmass. renderCountryPNG pads + squares it from there.
// Cached per country (territory shape is static).
const _shotFrameCache = {};
function _shotFrame(geoNum) {
  if (_shotFrameCache[geoNum]) return _shotFrameCache[geoNum];
  const pixels = geoPixels[geoNum];
  if (!pixels || pixels.length === 0) return null;
  const isMember = (n) => geoAtPixel[n] === geoNum && landMask[n];
  // 1. Largest connected component via iterative BFS/DFS.
  const visited = new Set();
  const stack = [];
  let best = null;
  for (let k = 0; k < pixels.length; k++) {
    const start = pixels[k];
    if (visited.has(start)) continue;
    const comp = [];
    stack.length = 0; stack.push(start); visited.add(start);
    while (stack.length) {
      const idx = stack.pop();
      comp.push(idx);
      const x = idx % MAP_W, y = (idx / MAP_W) | 0;
      if (x > 0         && !visited.has(idx - 1)     && isMember(idx - 1))     { visited.add(idx - 1);     stack.push(idx - 1); }
      if (x < MAP_W - 1 && !visited.has(idx + 1)     && isMember(idx + 1))     { visited.add(idx + 1);     stack.push(idx + 1); }
      if (y > 0         && !visited.has(idx - MAP_W) && isMember(idx - MAP_W)) { visited.add(idx - MAP_W); stack.push(idx - MAP_W); }
      if (y < MAP_H - 1 && !visited.has(idx + MAP_W) && isMember(idx + MAP_W)) { visited.add(idx + MAP_W); stack.push(idx + MAP_W); }
    }
    if (!best || comp.length > best.length) best = comp;
    if (best.length >= pixels.length * 0.8) break; // dominant landmass found
  }
  const comp = best;
  // Component bbox (outlier-free, since strays are in other components).
  let minX = MAP_W, minY = MAP_H, maxX = 0, maxY = 0;
  for (const idx of comp) {
    const x = idx % MAP_W, y = (idx / MAP_W) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // 2. Density grid → flag spot (densest 32x32 cell mean).
  const GRID_W = 32, GRID_H = 32;
  const cellW = MAP_W / GRID_W, cellH = MAP_H / GRID_H;
  const cnt = new Int32Array(GRID_W * GRID_H);
  const sumX = new Float64Array(GRID_W * GRID_H);
  const sumY = new Float64Array(GRID_W * GRID_H);
  for (const idx of comp) {
    const x = idx % MAP_W, y = (idx / MAP_W) | 0;
    const gx = Math.min(GRID_W - 1, (x / cellW) | 0);
    const gy = Math.min(GRID_H - 1, (y / cellH) | 0);
    const ci = gy * GRID_W + gx;
    cnt[ci]++; sumX[ci] += x; sumY[ci] += y;
  }
  let bc = -1, bn = 0;
  for (let i = 0; i < cnt.length; i++) if (cnt[i] > bn) { bn = cnt[i]; bc = i; }
  let cx, cy;
  if (bc >= 0) { cx = Math.round(sumX[bc] / bn); cy = Math.round(sumY[bc] / bn); }
  else { cx = Math.round((minX + maxX) / 2); cy = Math.round((minY + maxY) / 2); }
  // 3. Square bbox centered on the flag spot, big enough to contain the landmass.
  const half = Math.max(cx - minX, maxX - cx, cy - minY, maxY - cy);
  const frame = { minX: cx - half, maxX: cx + half, minY: cy - half, maxY: cy + half, cx, cy };
  _shotFrameCache[geoNum] = frame;
  return frame;
}

// v92m: flagCountryId = whose flag to stamp on the shot (the conqueror after a
// conquest; the defender for a siege). Defaults to the framed country.
function makeCountryShot(countryId, flagCountryId) {
  try {
    const geoNum = parseInt(countryId, 10);
    // v92l: flag-centered frame first (largest landmass, density-centered, strays
    // discarded). Falls back to the percentile bbox, then the raw geo bbox.
    const frame = _shotFrame(geoNum);
    const bbox = frame || _shotBbox(geoNum) || geoBbox[geoNum];
    if (!bbox) return null;
    // v92m: resolve the flag image + its spot (the frame's density center).
    let flag = null;
    const flagImg = getFlagImage(_isoNumericToA2(flagCountryId != null ? flagCountryId : countryId));
    if (flagImg && frame) flag = { img: flagImg, cx: frame.cx, cy: frame.cy };
    const buf = renderCountryPNG({
      MAP_W, MAP_H, geoAtPixel, claimByPixel, landMask, idxToId, geoColorsById, bbox, flag,
    });
    if (!buf) return null;
    const name = 'shot_' + countryId + '_' + Date.now().toString(36) + '.png';
    fs.writeFileSync(path.join(SHOTS_DIR, name), buf);
    _pruneShots();
    return '/shots/' + name;
  } catch (e) {
    console.warn('[Mapshot] render failed for', countryId, e.message);
    return null;
  }
}

// v93 (Phase 2): combined-territory shot for a new alliance — frames the union of
// all member countries' landmasses (no single flag) so the announcement shows the
// bloc's footprint. Reuses renderCountryPNG, which colours every painted pixel in
// the crop by its owner.
function makeAllianceShot(countryIds) {
  try {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const cid of countryIds) {
      const f = _shotFrame(parseInt(cid, 10)) || geoBbox[parseInt(cid, 10)];
      if (!f) continue;
      any = true;
      if (f.minX < minX) minX = f.minX; if (f.maxX > maxX) maxX = f.maxX;
      if (f.minY < minY) minY = f.minY; if (f.maxY > maxY) maxY = f.maxY;
    }
    if (!any) return null;
    const buf = renderCountryPNG({
      MAP_W, MAP_H, geoAtPixel, claimByPixel, landMask, idxToId, geoColorsById,
      bbox: { minX, minY, maxX, maxY },
    });
    if (!buf) return null;
    const name = 'alliance_' + countryIds.slice().sort().join('_').slice(0, 40) + '_' + Date.now().toString(36) + '.png';
    fs.writeFileSync(path.join(SHOTS_DIR, name), buf);
    _pruneShots();
    return '/shots/' + name;
  } catch (e) {
    console.warn('[Mapshot] alliance render failed:', e.message);
    return null;
  }
}

// v92e: full-world snapshot for the daily summary post. Saved to a STABLE
// filename so it isn't pruned by the 60-shot rotation (it overwrites daily).
function makeWorldShot() {
  try {
    const buf = renderWorldPNG({
      MAP_W, MAP_H, claimByPixel, landMask, idxToId, geoColorsById, outW: 512,
    });
    if (!buf) return null;
    // Date-stamped name → fresh URL each day so Discord/CDN don't serve stale.
    const name = 'world_' + new Date().toISOString().slice(0, 10) + '.png';
    fs.writeFileSync(path.join(SHOTS_DIR, name), buf);
    _pruneShots();
    return '/shots/' + name;
  } catch (e) {
    console.warn('[Mapshot] world render failed:', e.message);
    return null;
  }
}

// ── v92n: World timelapse → daily "state of the world" GIF ──────────
// Periodically render the full map (1024x512) to /timelapse/ frames, then
// assemble the trailing window into a 256-colour GIF (2fps) via ffmpeg for the
// daily Twitter/Discord status post.
//
// TEST MODE (TIMELAPSE_TEST=true): 10s frames over a 5min window so the pipeline
// can be verified quickly. PROD: 30min frames over 24h = 48 frames (24s @ 2fps).
// Flip TIMELAPSE_TEST to false once verified, then redeploy.
const TIMELAPSE_TEST  = false;
const TL_FRAME_MS     = TIMELAPSE_TEST ? 10 * 1000      : 15 * 60 * 1000;      // v93j: 15-min frames
const TL_WINDOW_MS    = TIMELAPSE_TEST ? 5 * 60 * 1000  : 12 * 60 * 60 * 1000; // v93j: 12h window (~48 frames)
const TL_GIF_FPS      = 2;
const TL_GIF_COLORS   = 256;
const TL_OUT_W        = 1024, TL_OUT_H = 512;
const TL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;        // keep frames 30 days
const TIMELAPSE_DIR   = path.join(__dirname, 'timelapse');
try { if (!fs.existsSync(TIMELAPSE_DIR)) fs.mkdirSync(TIMELAPSE_DIR, { recursive: true }); } catch (e) {}
const _serverStartMs       = Date.now();   // "start from server reset"
// v95x: was `_serverStartMs` — but that made EVERY restart/deploy wipe the GIF
// window (frames on disk older than the boot were excluded), so the 12h summary
// fell back to the static PNG whenever a deploy happened within 12h. Start at 0
// so the window is purely trailing-TL_WINDOW_MS; only an actual world reset bumps
// it (so a reset still starts a fresh timelapse).
let   _timelapseRoundStart = 0;

// Render one full-map frame. Skipped until the geo index is built (map ready) so
// we never bank empty all-ocean frames right after a restart.
function captureTimelapseFrame() {
  try {
    if (Object.keys(geoPixels).length === 0) return; // map not ready yet
    // v95y: burn the capture time into the frame so the GIF ticks through 12h.
    const _ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const buf = renderWorldPNG({ MAP_W, MAP_H, claimByPixel, landMask, idxToId, geoColorsById, outW: TL_OUT_W, label: _ts });
    if (!buf) return;
    // zero-padded epoch-ms filename → lexical sort == chronological
    const name = 'tl_' + String(Date.now()).padStart(15, '0') + '.png';
    fs.writeFileSync(path.join(TIMELAPSE_DIR, name), buf);
    _pruneTimelapseFrames();
  } catch (e) { console.warn('[Timelapse] frame capture failed:', e.message); }
}
function _pruneTimelapseFrames() {
  try {
    const cutoff = Date.now() - TL_RETENTION_MS;
    for (const f of fs.readdirSync(TIMELAPSE_DIR)) {
      if (!f.startsWith('tl_') || !f.endsWith('.png')) continue;
      const ts = parseInt(f.slice(3, -4), 10);
      if (ts && ts < cutoff) { try { fs.unlinkSync(path.join(TIMELAPSE_DIR, f)); } catch (e) {} }
    }
  } catch (e) {}
}
// Frames within the GIF window: trailing TL_WINDOW_MS, but never older than the
// current round/server start (so a restart starts a fresh timelapse).
function _timelapseFramesInWindow() {
  const since = Math.max(Date.now() - TL_WINDOW_MS, _timelapseRoundStart);
  const out = [];
  try {
    for (const f of fs.readdirSync(TIMELAPSE_DIR)) {
      if (!f.startsWith('tl_') || !f.endsWith('.png')) continue;
      const ts = parseInt(f.slice(3, -4), 10);
      if (ts && ts >= since) out.push({ ts, f });
    }
  } catch (e) {}
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
function _rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
// Assemble the windowed frames into a 256-colour GIF via ffmpeg (palettegen +
// paletteuse for clean colour). Returns Promise<string|null> = served URL.
function assembleTimelapseGif() {
  return new Promise((resolve) => {
    const frames = _timelapseFramesInWindow();
    if (frames.length < 2) { console.warn('[Timelapse] not enough frames to assemble (' + frames.length + ')'); return resolve(null); }
    let stage;
    try {
      stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tlstage-'));
      frames.forEach((fr, i) => {
        fs.copyFileSync(path.join(TIMELAPSE_DIR, fr.f), path.join(stage, 'f_' + String(i).padStart(5, '0') + '.png'));
      });
    } catch (e) { console.warn('[Timelapse] staging failed:', e.message); return resolve(null); }
    const input   = path.join(stage, 'f_%05d.png');
    const pal     = path.join(stage, 'pal.png');
    const outName = 'timelapse_' + new Date().toISOString().slice(0, 10) + '.gif';
    const outPath = path.join(TIMELAPSE_DIR, outName);
    const vf      = 'fps=' + TL_GIF_FPS + ',scale=' + TL_OUT_W + ':' + TL_OUT_H + ':flags=lanczos';
    // Pass 1 — palette
    execFile('ffmpeg', ['-y', '-framerate', String(TL_GIF_FPS), '-i', input,
      '-vf', vf + ',palettegen=max_colors=' + TL_GIF_COLORS, pal], (e1) => {
      if (e1) { console.warn('[Timelapse] palettegen failed:', e1.message); _rmrf(stage); return resolve(null); }
      // Pass 2 — apply palette
      execFile('ffmpeg', ['-y', '-framerate', String(TL_GIF_FPS), '-i', input, '-i', pal,
        '-lavfi', vf + ' [x]; [x][1:v] paletteuse', outPath], (e2) => {
        _rmrf(stage);
        if (e2) { console.warn('[Timelapse] paletteuse failed:', e2.message); return resolve(null); }
        console.log('[Timelapse] GIF assembled: ' + outName + ' (' + frames.length + ' frames)');
        resolve('/timelapse/' + outName);
      });
    });
  });
}
// Start the capture loop.
setInterval(captureTimelapseFrame, TL_FRAME_MS);
console.log('[Timelapse] capture every ' + (TL_FRAME_MS / 1000) + 's, ' +
  (TL_WINDOW_MS / 60000) + 'min window, mode=' + (TIMELAPSE_TEST ? 'TEST' : 'PROD'));

// ── Tweet template generators ────────────────────────────────────


// v37: Sassy template pools — picked at random per event for variety
const TWITTER_HANDLE = '@PixelAnnexGame';
const DISCORD_INVITE = 'https://discord.gg/UHQRqXDpBE'; // v99j: permanent (never-expiring) invite
const GAME_URL       = 'pixelannex.com';
function _pickSassy(pool) { return pool[Math.floor(Math.random() * pool.length)]; }
// v39a: tweet posted by @PixelAnnexGame anyway — drop the self-mention
function _suffix() { return GAME_URL + ' #PixelAnnex'; }

// CONQUEST variants — {attacker} {defender} {held}
// v84: pool expanded with paraphrased war/strategy tropes. Rules:
//   • No exact quotes from copyrighted films
//   • No real political leader names
//   • Generic titles (the General, the High Command, the Politburo) are fine
//   • References to historical/public-domain figures (Caesar, Sun Tzu) are fine
const SASS_CONQUEST = [
  v => `🗡️ ${v.a} has conquered ${v.d}! ${v.a} now controls ${v.held} ${v.held === 1 ? 'country' : 'countries'}. ` + _suffix(),
  v => `📢 ${v.d} just got rebranded by ${v.a}. New management, same map. ` + _suffix(),
  v => `👑 ${v.a} adds ${v.d} to the collection (${v.held} total). Empire-building hours: open. ` + _suffix(),
  v => `🗺️ ${v.d} is now part of the ${v.a} extended universe. Tough day for the locals. ` + _suffix(),
  v => `⚔️ ${v.a} has annexed ${v.d}. Diplomacy was tried — briefly. ` + _suffix(),
  v => `🚩 New flag dropped: ${v.a} over ${v.d}. ${v.held} down. ` + _suffix(),
  // v84 additions ↓
  v => `🏛️ ${v.a} came, ${v.a} saw, ${v.a} re-coloured. ${v.held} flags planted. ` + _suffix(),
  v => `🎯 ${v.a} just ran the table on ${v.d}. ${v.held} countries to their name. ` + _suffix(),
  v => `🚁 ${v.a} loves the smell of fresh pixels in the morning — ${v.d} is theirs. ` + _suffix(),
  v => `🛡️ ${v.a} chose violence. ${v.d} chose to lose. ${v.held} on the wall. ` + _suffix(),
  v => `🚀 ${v.a} just rebranded ${v.d}. Welcome to ${v.a}-stan, population: you. ` + _suffix(),
  v => `🌅 Sun never sets on the ${v.a} pixel empire. ${v.d} is the latest dawn. ${v.held} held. ` + _suffix(),
  v => `📡 ${v.d}'s walls came down. ${v.a} planted ${v.held} flags and counting. ` + _suffix(),
  v => `🔱 ${v.a} took ${v.d} the way nature intended — by overwhelming pixel count. ` + _suffix(),
  v => `📜 The High Command of ${v.a} decrees: ${v.d} is now theirs. Effective immediately. ` + _suffix(),
  v => `🏴 ${v.a} planted the flag on ${v.d}. The cartographers are crying. ` + _suffix(),
  v => `🐉 ${v.a} burned through ${v.d}. There is no peace at the end of pixel war, only more pixels. ` + _suffix(),
  v => `🗡️ ${v.a} repainted ${v.d} corner to corner. The map has spoken. ${v.held} territories. ` + _suffix(), // v99a: reworded — "swept clean" reads badly in a war context
  v => `🎬 ${v.a} cut a long story short with ${v.d}. ${v.held} held, none returned. ` + _suffix(),
  v => `📯 Service guaranteed pixels for the ${v.a} legions. ${v.d}: claimed. ` + _suffix(),
  v => `⚒️ ${v.a} hammered ${v.d} flat. ${v.held} in the trophy case. ` + _suffix(),
  v => `🧭 Strategy guide for ${v.d}: it's too late. ${v.a} already painted it. ` + _suffix(),
  v => `🪖 ${v.a}'s pixel battalion marched into ${v.d}. The defenders went home. ` + _suffix(),
  // v98b additions — revenge bait (operator request: rally patriots of the fallen)
  v => `💔 ${v.d} has fallen to ${v.a}. Patriots won't take that lying down… will they?? ` + _suffix(),
  v => `🩸 ${v.d} is off the map — courtesy of ${v.a}. Revenge is a dish best served in pixels. ` + _suffix(),
  v => `🔥 ${v.a} just toppled ${v.d}. Somewhere, a resistance is loading its brushes. ` + _suffix(),
  v => `🏴 ${v.d} flies the ${v.a} flag tonight. Who's taking it back? ` + _suffix(),
];

// REVERSAL variants — {victim} {oppressor}
const SASS_REVERSAL = [
  v => `🛡️ ${v.v} has liberated itself from ${v.o}! The resistance prevails. ` + _suffix(),
  v => `🔥 ${v.v} just kicked ${v.o} to the curb. Liberation tastes sweet. ` + _suffix(),
  v => `📢 Plot twist: ${v.v} is back. ${v.o} loses the chokehold. ` + _suffix(),
  v => `✊ ${v.v} reclaimed itself. ${v.o} is going to need a moment. ` + _suffix(),
  // v84 additions ↓
  v => `🦅 ${v.v} liberated. Phoenix mode: engaged. ${v.o} is left holding the brush. ` + _suffix(),
  v => `⚡ ${v.v} flipped the script on ${v.o}. The map is mightier than the empire. ` + _suffix(),
  v => `🎬 ${v.v} returns from the ashes. ${v.o}'s pixel reign was short. ` + _suffix(),
  v => `🌅 A new pixel dawn for ${v.v}. ${v.o} retreats to the strategy room. ` + _suffix(),
  v => `🪓 ${v.v} chopped the ${v.o} chain. Freedom isn't free — it costs pixels. ` + _suffix(),
  v => `📜 The chronicles will note: ${v.v} rose. ${v.o} fell. The map turned. ` + _suffix(),
  v => `🛶 ${v.v} sailed out from under ${v.o}. The pixel tide always turns. ` + _suffix(),
  v => `🥁 Drums of war beat for ${v.v}. ${v.o}'s grip slips. Liberation complete. ` + _suffix(),
];

// NUKE variants — {attacker} {target}
const SASS_NUKE = [
  v => `☢️ ${v.a} just nuked ${v.target}. No-paint zone active for 5 minutes. ` + _suffix(),
  v => `💥 ${v.a} chose violence. ${v.target} is a smoking crater. ` + _suffix(),
  v => `🚨 BREAKING: ${v.a} went nuclear on ${v.target}. Literally. ` + _suffix(),
  v => `☢️ Diplomatic resolution attempted via ${v.a}'s nuke at ${v.target}. ` + _suffix(),
  v => `☢️ ${v.a} fired off a nuke at ${v.target}. The 5-minute lockout will give everyone time to reflect. ` + _suffix(),
  // v84 additions ↓
  v => `💀 ${v.a} dropped the big one on ${v.target}. Some pixels you can't unpaint. ` + _suffix(),
  v => `🎆 ${v.a} delivered an unforgettable light show to ${v.target}. RSVP: declined. ` + _suffix(),
  v => `☣️ ${v.a} went thermonuclear at ${v.target}. The cockroaches are taking notes. ` + _suffix(),
  v => `🚀 ${v.a} launched the big payload at ${v.target}. No-paint lockout: 5 minutes of regret. ` + _suffix(),
  v => `🔥 ${v.a} ended the conversation with ${v.target} — using a 50-megapixel exclamation mark. ` + _suffix(),
  v => `📛 ${v.a} solved ${v.target} the old-fashioned way. Loudly. ` + _suffix(),
  v => `🏔️ ${v.a} ended the day with a mushroom cloud over ${v.target}. War room: very loud. ` + _suffix(),
];

// MULTI-ATTACK variants — {n} {defender} {attackers}
const SASS_MULTI = [
  v => `🚨 ${v.n} countries are attacking ${v.d}! (${v.atk}) ` + _suffix(),
  v => `📢 Wow, some countries really don't like ${v.d}! ${v.n} attackers piling on: ${v.atk}. ` + _suffix(),
  v => `🔥 ${v.d} is hosting an uninvited party. ${v.n} RSVPs: ${v.atk}. ` + _suffix(),
  v => `⚠️ Today's group project subject: ${v.d}. ${v.n} contributors: ${v.atk}. ` + _suffix(),
  v => `🚨 ${v.n}-on-1 right now against ${v.d}. (${v.atk}) Reinforcements?? ` + _suffix(),
  // v84 additions ↓
  v => `🚨 ${v.d} is surrounded. ${v.n} attackers closing in: ${v.atk}. Alamo vibes. ` + _suffix(),
  v => `⚔️ ${v.n} flags converged on ${v.d}: ${v.atk}. Sun Tzu probably warned about this. ` + _suffix(),
  v => `🛡️ ${v.d} defending ${v.n} simultaneous fronts (${v.atk}). Hold the line. ` + _suffix(),
  v => `🎯 ${v.d} = today's piñata. ${v.n} swingers: ${v.atk}. ` + _suffix(),
  v => `🌪️ A perfect storm hits ${v.d}: ${v.n} attackers (${v.atk}). Brace for impact. ` + _suffix(),
  v => `📯 ${v.n} horns blow on the borders of ${v.d}. (${v.atk}) The defenders sleep no more. ` + _suffix(),
  v => `🪖 ${v.d} requests reinforcements: ${v.n} attackers (${v.atk}) on the perimeter. ` + _suffix(),
  // v98b additions — defend-or-overthrow framing (operator request)
  v => `🚨 ${v.d} is under attack — will you defend or overthrow?? (${v.atk}) ` + _suffix(),
  v => `⚔️ ${v.d} bleeds on ${v.n} fronts (${v.atk}). Defend it… or finish the job. ` + _suffix(),
];

// ADMIRAL promotion variants — {username} {country?}
const SASS_ADMIRAL = [
  v => `🎖️ ${v.user} has reached ADMIRAL${v.country ? ' (' + v.country + ')' : ''}! Nukes unlocked. ☢️ ` + _suffix(),
  v => `🌟 New Admiral: ${v.user}${v.country ? ' of ' + v.country : ''}. The nuke codes have been handed over. ` + _suffix(),
  v => `⭐ ${v.user} is now ADMIRAL${v.country ? ' (' + v.country + ')' : ''}. May they use the nukes responsibly. (They won't.) ` + _suffix(),
  v => `🚢 Admiral ${v.user}${v.country ? ' of ' + v.country : ''} reporting for duty. The fleet — and the nukes — are theirs. ` + _suffix(),
  v => `🎖️ ${v.user}${v.country ? ' (' + v.country + ')' : ''} just hit ADMIRAL. Salute, then run. ☢️ ` + _suffix(),
];

// DAILY SUMMARY variants — {lines} {conquered}
const SASS_DAILY = [
  v => `🌍 World Snapshot · ${v.lines} · ${v.conquered} countries conquered. ` + _suffix(),
  v => `📊 Daily standings: ${v.lines}. ${v.conquered} countries currently under foreign rule. ` + _suffix(),
  v => `🌍 Today's top dogs: ${v.lines}. ${v.conquered} conquests on the board. ` + _suffix(),
  v => `🗺️ Daily dispatch: ${v.lines}. ${v.conquered} nations have fallen so far. ` + _suffix(),
  v => `📈 Where things stand: ${v.lines}. ${v.conquered} countries flying foreign colours. ` + _suffix(),
];

// COMMUNITY tweet — periodic standalone
const SASS_COMMUNITY = [
  () => `🌍 PixelAnnex is a real-time pixel-conquest world map. 240+ countries, live multiplayer. Join the Discord: ${DISCORD_INVITE} · Play: ${GAME_URL} #PixelAnnex`,
  () => `🚨 Conquering the world, one pixel at a time. Join the Discord for war updates + alliance plays: ${DISCORD_INVITE} · ${GAME_URL} #PixelAnnex`,
  () => `🎖️ Climb the ranks. Drop nukes. Form alliances. PixelAnnex is live: ${GAME_URL} · Community: ${DISCORD_INVITE} #PixelAnnex`,
  () => `🗺️ Today on PixelAnnex: same map, fresh chaos. ${GAME_URL} · ${DISCORD_INVITE} #PixelAnnex`,
  () => `⚔️ Pick a country. Paint the world. Drop a nuke or two. PixelAnnex is live: ${GAME_URL} · ${DISCORD_INVITE} #PixelAnnex`,
];

// WORLD STATUS REPORT — {leader, leaderPx, conquered, allianceLine}
const SASS_STATUS_REPORT = [
  v => `📊 Standings: ${v.leader} leads with ${v.leaderPx.toLocaleString()} pixels · ${v.conquered} countries conquered · ${v.allianceLine}${GAME_URL} #PixelAnnex`,
  v => `🌍 World intel: ${v.leader} on top (${v.leaderPx.toLocaleString()} px). ${v.allianceLine}${v.conquered} nations under occupation. ${GAME_URL} #PixelAnnex`,
  v => `🗺️ Pixel report: ${v.leader} controls the board (${v.leaderPx.toLocaleString()} px). ${v.allianceLine}${v.conquered} countries conquered. ${GAME_URL} #PixelAnnex`,
  v => `📡 Battlefield update: ${v.leader} dominates with ${v.leaderPx.toLocaleString()} px. ${v.allianceLine}${v.conquered} countries occupied. ${GAME_URL} #PixelAnnex`,
  v => `🏴 State of the war: ${v.leader} out front (${v.leaderPx.toLocaleString()} px). ${v.allianceLine}${v.conquered} nations conquered. ${GAME_URL} #PixelAnnex`,
];

// TOP PLAYERS 24H — {lines}
const SASS_TOP_PLAYERS = [
  v => `🏆 Most active players (24h): ${v.lines}. Top spot is up for grabs: ${GAME_URL} #PixelAnnex`,
  v => `🎖️ Pixel warriors (last 24h): ${v.lines}. ${GAME_URL} #PixelAnnex`,
  v => `🔥 24h leaderboard: ${v.lines}. Get in the game: ${GAME_URL} #PixelAnnex`,
  v => `⚡ Top pixel pushers (24h): ${v.lines}. Think you can crack the list? ${GAME_URL} #PixelAnnex`,
  v => `👑 24h MVPs: ${v.lines}. The throne is never safe: ${GAME_URL} #PixelAnnex`,
];

// MOST ACTIVE COUNTRIES 24H — {lines}
const SASS_ACTIVE_COUNTRIES = [
  v => `⚔️ Most active countries (24h): ${v.lines}. Join the fight: ${GAME_URL} #PixelAnnex`,
  v => `🎨 Hottest territories today: ${v.lines}. Where does your country rank? ${GAME_URL} #PixelAnnex`,
  v => `🌍 Activity report: ${v.lines}. ${GAME_URL} #PixelAnnex`,
  v => `🔥 Busiest nations (24h): ${v.lines}. Is yours on the move? ${GAME_URL} #PixelAnnex`,
  v => `📊 Today's frontline movers: ${v.lines}. ${GAME_URL} #PixelAnnex`,
];

// v92r: news is a SIGNAL ONLY. We never quote the raw headline (it carries
// casualties, specific demands, names, etc.). Instead the scraper tells us which
// game countries are in the news + the general vibe (theme), and we emit a light,
// non-specific teaser. Disaster keeps a respectful, solidarity tone (no challenge).
// Keyword buckets — first match wins, checked in this priority order.
const NEWS_THEME_KEYWORDS = {
  conflict:  ['war','warn','invad','attack','strike','missile','troop','military','clash','offensive','shell','airstrike','ceasefire','fighting','combat','drone','nuclear','army','soldier','militant','rebel','tension','border','conflict','threat','armed','frontline','siege'],
  disaster:  ['earthquake','quake','flood','storm','hurricane','wildfire','drought','disaster','cyclone','eruption','volcano','landslide','famine','typhoon','tsunami','mudslide'],
  sport:     ['world cup','olympic','tournament','championship','qualifier',' match','final','medal','fifa','grand prix'],
  politics:  ['election','vote','president','prime minister','parliament','poll','government','referendum','protest','coalition','campaign','minister','impeach'],
  diplomacy: ['talks','summit','meeting','deal','agreement','sanction','diplomat','negotiat','treaty','accord','ties','relations','peace','alliance','envoy'],
  economy:   ['econom','trade','tariff','inflation','currency','market','oil','gas','export','import','debt','gdp','recession','stocks','prices','energy'],
};
function _classifyNewsTheme(title) {
  const lc = ' ' + String(title).toLowerCase() + ' ';
  for (const theme of ['conflict', 'disaster', 'sport', 'politics', 'diplomacy', 'economy']) {
    for (const k of NEWS_THEME_KEYWORDS[theme]) if (lc.includes(k)) return theme;
  }
  return 'general';
}
// Template pools per theme. {a}=primary country, {b}=second (two-country variants).
const NEWS_TEMPLATES = {
  // v115d: disaster theme CULLED — disaster headlines are detected (keywords kept)
  // and SKIPPED entirely at queue time, so we never make a cheeky tweet about a
  // tragedy. No disaster templates exist anymore. Every other pool has 5 variants.
  conflict: {
    two: [
      v => `${v.a} and ${v.b} are dominating the world's headlines today. Think you could settle it faster in pixels? ` + _suffix(),
      v => `Tensions between ${v.a} and ${v.b} are back in the news. On the map, you decide who blinks first. ` + _suffix(),
      v => `${v.a} vs ${v.b} is making headlines again — fancy redrawing that border in pixels? ` + _suffix(),
      v => `${v.a} and ${v.b} are squaring up in the news. The map settles arguments faster. ` + _suffix(),
      v => `${v.a} and ${v.b} dominate the front pages. Take the fight where it actually counts — the map. ` + _suffix(),
    ],
    one: [
      v => `${v.a} is making waves in the world news today. Can you do better on the map? ` + _suffix(),
      v => `${v.a} is in the headlines for all the tense reasons. Show us how it's done in pixels. ` + _suffix(),
      v => `${v.a} is all over the news today. Put them all over the map instead. ` + _suffix(),
      v => `${v.a} is the lead story for the wrong reasons. Rewrite it in pixels. ` + _suffix(),
      v => `${v.a} can't stay out of the news. Can they hold their ground on the map? ` + _suffix(),
    ],
  },
  diplomacy: {
    two: [
      v => `${v.a} and ${v.b} are talking it out in the news. On the map, talk is cheap — claim the ground. ` + _suffix(),
      v => `${v.a} and ${v.b} are at the table today. Settle it in pixels instead? ` + _suffix(),
      v => `${v.a} and ${v.b} are shaking hands in the news. No handshakes on the map — just pixels. ` + _suffix(),
      v => `${v.a} and ${v.b} are negotiating in the headlines. The map doesn't negotiate. ` + _suffix(),
      v => `${v.a} and ${v.b} signed something today. Sign the map in your colour. ` + _suffix(),
    ],
    one: [
      v => `${v.a} is working the diplomatic headlines. Pixels move faster than treaties — prove it. ` + _suffix(),
      v => `${v.a} is busy with diplomacy today. The map needs no envoy — just go. ` + _suffix(),
      v => `${v.a} is all handshakes in the news. The map prefers action. ` + _suffix(),
      v => `${v.a} is talking peace today. Make peace with the map — by taking it. ` + _suffix(),
      v => `${v.a} is the diplomat of the day. Be the conqueror of the map. ` + _suffix(),
    ],
  },
  economy: {
    two: [
      v => `${v.a} and ${v.b} are shaking up the economic headlines. Turn that energy into pixels. ` + _suffix(),
      v => `${v.a} and ${v.b} are battling over markets. The map is a market too — corner it. ` + _suffix(),
      v => `${v.a} and ${v.b} move the markets today. Move the map instead. ` + _suffix(),
      v => `${v.a} and ${v.b} are trading blows over trade. The map is the better exchange. ` + _suffix(),
      v => `${v.a} and ${v.b} top the business pages. Top the leaderboard in pixels. ` + _suffix(),
    ],
    one: [
      v => `${v.a} is moving markets in the news today. Convert the momentum into territory. ` + _suffix(),
      v => `${v.a} is the headline of the trading floor. Trade it for pixels. ` + _suffix(),
      v => `${v.a} is bullish in the news. Be bullish on the map. ` + _suffix(),
      v => `${v.a} owns the business headlines. Go own some territory. ` + _suffix(),
      v => `${v.a} is the economy story today. The map pays better. ` + _suffix(),
    ],
  },
  politics: {
    two: [
      v => `${v.a} and ${v.b} are all over the political headlines. Cast your vote in pixels. ` + _suffix(),
      v => `${v.a} and ${v.b} are locked in a political standoff. The map breaks ties. ` + _suffix(),
      v => `${v.a} and ${v.b} are campaigning in the news. Campaign on the map — votes are pixels. ` + _suffix(),
      v => `${v.a} and ${v.b} are at a political deadlock. The map never deadlocks. ` + _suffix(),
      v => `${v.a} and ${v.b} dominate the debate. Win the only debate that paints — the map. ` + _suffix(),
    ],
    one: [
      v => `${v.a} is in the political spotlight today. The only poll that matters here is painted in pixels. ` + _suffix(),
      v => `${v.a} is dominating the political cycle. Dominate the map cycle too. ` + _suffix(),
      v => `${v.a} is leading the polls in the news. Lead the map too. ` + _suffix(),
      v => `${v.a} runs the political headlines. Run the map while you're at it. ` + _suffix(),
      v => `${v.a} is the candidate of the day. The map elects whoever paints fastest. ` + _suffix(),
    ],
  },
  sport: {
    two: [
      v => `${v.a} vs ${v.b} is lighting up the sports headlines — bring that rivalry to the pixels! ` + _suffix(),
      v => `${v.a} and ${v.b} are battling it out in sport. The rematch is on the map. ` + _suffix(),
      v => `Scoreboard says ${v.a} vs ${v.b}. The map keeps a different score. ` + _suffix(),
      v => `${v.a} and ${v.b} go head to head in sport today. Settle the real one in pixels. ` + _suffix(),
      v => `${v.a} vs ${v.b} sells out the stadium. The map seats unlimited — take a side: ` + _suffix(),
    ],
    one: [
      v => `${v.a} is making sporting headlines today. Take the win in pixels too. ` + _suffix(),
      v => `${v.a} is on a winning streak in sport. Extend it onto the map. ` + _suffix(),
      v => `${v.a} is the talk of the sports world. Be the talk of the map. ` + _suffix(),
      v => `${v.a} is on the podium in the news. Climb the map's podium too. ` + _suffix(),
      v => `${v.a} is today's sporting hero. Be the map's hero. ` + _suffix(),
    ],
  },
  general: {
    two: [
      v => `${v.a} and ${v.b} are both in the headlines today. Will that show up in the pixels? ` + _suffix(),
      v => `${v.a} and ${v.b} are trending in the news. Only one can trend on the map — go claim it. ` + _suffix(),
      v => `The world's watching ${v.a} and ${v.b} today. The map's watching you. ` + _suffix(),
      v => `${v.a} and ${v.b} made the front page. Now make the front of the map. ` + _suffix(),
      v => `Big day for ${v.a} and ${v.b} in the news. Bigger day for whoever paints faster. ` + _suffix(),
    ],
    one: [
      v => `${v.a} is in the headlines today. Will that reflect in the pixels? ` + _suffix(),
      v => `${v.a} is making news today — time to make some pixels. ` + _suffix(),
      v => `${v.a} is everywhere in the news. Make them everywhere on the map too. ` + _suffix(),
      v => `${v.a} grabbed the headlines. Go grab some territory. ` + _suffix(),
      v => `${v.a} is the story today. Write the next chapter in pixels. ` + _suffix(),
    ],
  },
};

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
    () => `🇷🇺 Russia advances on Ukraine — again. Kyiv is typing... ` + _suffix(),
    () => `🚀 Pixel blitzkrieg in Ukraine. Someone call NATO. ` + _suffix(),
    () => `🌻 Eastern Ukraine just turned Russian pixels. The ICC is watching. ` + _suffix(),
    () => `🛡️ Russia pushes to the Dnipro — one pixel at a time. ` + _suffix(),
  ],
  '804:643': [ // Ukraine → Russia
    () => `🇺🇦 Ukraine counter-pixels into Russia! The Kursk offensive: now in 2D. ` + _suffix(),
    () => `⚡ Kyiv pixel update: Ukraine is winning on the map at least. ` + _suffix(),
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
    () => `🇨🇳 China achieves pixel reunification with Taiwan. Beijing counted those pixels twice. ` + _suffix(),
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
    () => `🇰🇵 The North crosses the pixel DMZ! The sirens are very confused. ` + _suffix(),
    () => `💣 DPRK pixel strike on the South. K-pop plays louder in response. ` + _suffix(),
    () => `🪖 North Korea activates the pixel artillery. Seoul: refreshing the PixelAnnex tab anxiously. ` + _suffix(),
  ],
  '410:408': [ // South Korea → North Korea
    () => `🇰🇷 South Korea pixels into the North. Pyongyang is not logging it in state media. ` + _suffix(),
    () => `📺 ROK pushes past the DMZ in 2D. Pyongyang: very displeased. ` + _suffix(),
  ],
  // ── Europe ─────────────────────────────────────────────────────────────
  '792:300': [ // Turkey → Greece
    () => `🇹🇷 Turkey pixels into Greek airspace. Greece calls it a violation. Ankara: "It's fine." ` + _suffix(),
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
    () => `🇻🇪 Venezuela pixels into Colombia. Caracas calls it a "Bolivarian pixel operation." ` + _suffix(),
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
  // v93m: country names rendered as national hashtags (e.g. #USA, #France) for
  // X reach. _natHashtag → short alias (#USA) or stripped name (#SouthAfrica).
  const a = _natHashtag(attackerId);
  const d = _natHashtag(defenderGeoId);
  const contextual = _geoContextSassy(attackerId, defenderGeoId);
  // v114: append the conquered country's GDP ("— $1.7T GDP") when known.
  const gdp = _gdpTag(defenderGeoId);
  if (contextual) return contextual + gdp;
  let conquestsHeld = 0;
  for (const key of conqueredSet) {
    const parts = String(key).split(':');
    if (parts[1] === String(attackerId)) conquestsHeld++;
  }
  return _pickSassy(SASS_CONQUEST)({ a, d, held: conquestsHeld }) + gdp;
}

function tweetForReversal(victimId, oppressorId) {
  return _pickSassy(SASS_REVERSAL)({
    v: _natHashtag(victimId),   // v93m: hashtags for X reach
    o: _natHashtag(oppressorId),
  });
}

function tweetForNuke(attackerId, cx, cy) {
  const i = cy * MAP_W + cx;
  const geoId = (i >= 0 && i < geoAtPixel.length) ? geoAtPixel[i] : -1;
  const targetName = geoId >= 0 ? _natHashtag(String(geoId)) : 'open territory'; // v93m: hashtag
  return _pickSassy(SASS_NUKE)({ a: _natHashtag(attackerId), target: targetName });
}

function tweetForDailySummary() {
  const top = Object.entries(countryPxCount)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  if (!top.length) return null;
  const distinctConquered = new Set();
  for (const key of conqueredSet) distinctConquered.add(String(key).split(':')[0]);
  const lines = top.map(([id, c], i) => `${i + 1}. ${_natHashtag(id)} (${c.toLocaleString()} px)`).join(' · '); // v93m: hashtags
  return _pickSassy(SASS_DAILY)({ lines, conquered: distinctConquered.size });
}

function tweetForAdmiralPromotion(username, countryId) {
  return _pickSassy(SASS_ADMIRAL)({
    user: username,
    country: countryId ? _natHashtag(countryId) : null, // v93m: hashtag
  });
}

// v37/v92r: news templates — theme + 1-2 country names, no raw headline.
function tweetForNews(theme, aName, bName) {
  const pool = NEWS_TEMPLATES[theme] || NEWS_TEMPLATES.general;
  const variant = (bName && pool.two && pool.two.length) ? pool.two : pool.one;
  return _pickSassy(variant)({ a: aName, b: bName || '' });
}
function tweetForCommunity() {
  return _pickSassy(SASS_COMMUNITY)();
}

// Daily summary scheduler — fires once per UTC day at 12:00 UTC
// v93j: now fires every 12h (00:00 + 12:00 UTC) instead of daily, and the Discord
// post (state-of-the-world GIF) goes to #general via a dedicated 'daily_report'
// event rather than #war-room.
function scheduleDailySummary() {
  const now = new Date();
  const next = new Date(now);
  // next 00:00 or 12:00 UTC boundary
  next.setUTCMinutes(0, 0, 0);
  if (next.getUTCHours() < 12) next.setUTCHours(12);
  else { next.setUTCHours(0); next.setUTCDate(next.getUTCDate() + 1); }
  if (next <= now) next.setUTCHours(next.getUTCHours() + 12);
  const msUntil = next - now;
  setTimeout(async () => {
    const text = tweetForDailySummary();
    if (text) {
      // State-of-the-world GIF (last 12h). Falls back to the static world PNG.
      let media = null;
      try { media = await assembleTimelapseGif(); } catch (e) { media = null; }
      if (!media) media = makeWorldShot();
      // v95x: dedupeKey was built from `now` (the SCHEDULE time, not the fire time)
      // and sliced to 13 chars — "Sat, 07 Jun 2" — i.e. DAY granularity with a
      // mangled year, so the 00:00 and 12:00 fires of the same UTC day collided and
      // the second was deduped away (the "no morning post" bug). Use the FIRE time
      // and a real per-12h-slot key: YYYY-MM-DD + AM/PM.
      const fireNow = new Date();
      const slot = fireNow.toISOString().slice(0, 10) + (fireNow.getUTCHours() < 12 ? 'AM' : 'PM');
      pushTweetDraft({
        type:       'daily_summary',
        text,
        dedupeKey: 'daily_summary:' + slot,
        imageUrl:  media || undefined,
      });
      // v93j: dedicated event so the bot posts the snapshot to #general.
      emitBotEvent({
        type:       'daily_report',
        timestamp:  Date.now(),
        text:       '🌍 State of the world — ' + text,
        imageUrl:   media || undefined,
      });
      console.log('[Tweets] 12h summary queued at', new Date().toISOString(),
        media ? ('(media ' + media + ')') : '(no media)');
    }
    scheduleDailySummary(); // schedule next 12h boundary
  }, msUntil);
  console.log('[Tweets] Next world summary at', next.toISOString());
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
const NEWS_SCRAPE_MS   = 12 * 60 * 60 * 1000; // v99b: 24h→12h (operator request; football stays 6h)

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

    // v92r: for each headline, find the game countries it mentions (greedy
    // longest-alias, word-boundary matched so "us" doesn't fire on "business"
    // and "korea" doesn't steal "north korea") + classify the theme. We emit a
    // templated teaser keyed on countries+theme — never the raw headline text.
    const _escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aliasesSorted = [..._newsCountryAliases]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([alias, id]) => [new RegExp('\\b' + _escapeRe(alias) + '\\b', 'i'), id]);
    const matched = [];
    const seenSig = new Set();
    for (const it of items) {
      const ids = [];
      for (const [re, countryId] of aliasesSorted) {
        if (ids.includes(countryId)) continue;
        if (re.test(it.title)) { ids.push(countryId); if (ids.length >= 2) break; }
      }
      if (!ids.length) continue;
      const theme = _classifyNewsTheme(it.title);
      if (theme === 'disaster') continue; // v115d: cull disaster — never tweet about tragedies
      // Dedupe on countries+theme (NOT the headline) so near-duplicate stories
      // about the same pairing don't double-post.
      const sig = ids.slice().sort().join('-') + ':' + theme;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      const aName = _natHashtag(ids[0]); // v93m: national hashtags in news tweets too
      const bName = ids[1] ? _natHashtag(ids[1]) : null;
      matched.push({ ids, theme, aName, bName });
      if (matched.length >= NEWS_MAX_DRAFTS) break;
    }
    console.log('[News] Matched', matched.length, 'country-relevant headlines');
    for (const m of matched) {
      pushTweetDraft({
        type:      'news',
        text:      tweetForNews(m.theme, m.aName, m.bName),
        dedupeKey: 'news:' + m.ids.slice().sort().join('-') + ':' + m.theme,
        countries: m.ids, // v84: notable gate — at least one must be notable
        imageUrl:  _portraitUrlFor(m.ids) || undefined, // v115e: leader portrait
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
// v99b: literal 24h — NEWS_SCRAPE_MS dropped to 12h and community should stay daily.
const COMMUNITY_TWEET_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  pushTweetDraft({
    type:      'community',
    text:      tweetForCommunity(),
    dedupeKey: 'community:' + Math.floor(Date.now() / COMMUNITY_TWEET_MS),
  });
  console.log('[Community] Daily community tweet queued');
}, COMMUNITY_TWEET_MS);
// Also schedule one within 5 minutes of boot
setTimeout(() => {
  pushTweetDraft({
    type:      'community',
    text:      tweetForCommunity(),
    dedupeKey: 'community:boot:' + Math.floor(Date.now() / (60 * 60 * 1000)),
  });
}, 5 * 60 * 1000);

// ── v98b: fallen-country revenge spotlight — every 12h ────────────
// Operator request: mention fallen countries more often to bait revenge runs.
// Picks a random NOTABLE fallen homeland and drafts a patriot-rally tweet
// (manual approve, like everything else). Deduped per 12h slot.
const SASS_FALLEN_SPOTLIGHT = [
  v => `🏴 Reminder: ${v.d} is still under ${v.a}'s rule. Any patriots left out there? ` + _suffix(),
  v => `💔 ${v.d} has fallen to ${v.a} — and nobody's done a thing about it. Yet. ` + _suffix(),
  v => `🕯️ Day after day, the ${v.a} flag flies over ${v.d}. Revenge is one brush away. ` + _suffix(),
  v => `📜 History remembers liberators. ${v.d} waits under ${v.a}'s thumb. ` + _suffix(),
  v => `⛓️ ${v.d} has been ${v.a} territory for too long. Who's brave enough to take it back? ` + _suffix(),
];
function _queueFallenSpotlight() {
  try {
    const fallen = [];
    for (const k of conqueredSet) {
      const p = String(k).split(':');
      if (p[1] === p[0]) continue;
      if (!permanentlyConquered.has(p[0])) continue;     // homeland actually dead
      if (!isNotableCountry(p[0]) && !isNotableCountry(p[1])) continue;
      fallen.push({ geo: p[0], holder: p[1] });
    }
    if (!fallen.length) return;
    const pick = fallen[Math.floor(Math.random() * fallen.length)];
    const slot = new Date().toISOString().slice(0, 10) + (new Date().getUTCHours() < 12 ? 'AM' : 'PM');
    pushTweetDraft({
      type:      'fallen_spotlight',
      text:      _pickSassy(SASS_FALLEN_SPOTLIGHT)({ d: _natHashtag(pick.geo), a: _natHashtag(pick.holder) }) + _gdpTag(pick.geo), // v114: fallen country's GDP
      dedupeKey: 'fallen_spotlight:' + slot,
      countries: [pick.geo, pick.holder],
      imageUrl:  _avatarMediaUrl(pick.geo) || undefined, // v115e: the fallen nation's leader portrait
    });
    console.log('[Tweets] fallen-spotlight queued:', pick.geo, 'held by', pick.holder);
  } catch (e) { console.warn('[Tweets] fallen-spotlight failed:', e.message); }
}
setInterval(_queueFallenSpotlight, 12 * 60 * 60 * 1000);
setTimeout(_queueFallenSpotlight, 10 * 60 * 1000); // one shortly after boot

// ── v98b: football fixture hype — country-vs-country matchups ─────
// Scrapes the public BBC Sport football RSS (no key) for "X v Y" fixture
// headlines where BOTH sides resolve to game countries, then pitches the
// matchup as a pixel showdown. DELIBERATELY no tournament branding in the
// copy ("FIFA"/"World Cup" are trademarks — operator request to avoid them).
// Tweets stay manual-approve like everything else; Discord gets a #general
// card via the 'football_matchup' bot event.
const FOOTBALL_FEED_URLS = [
  'https://feeds.bbci.co.uk/sport/football/rss.xml',
  'https://www.espn.com/espn/rss/soccer/news',
];
const FOOTBALL_MAX_PER_RUN = 2;
const SASS_FOOTBALL = [
  v => `⚽ ${v.a} and ${v.b} face off on the pitch tonight — but which country wins in PIXELS? Settle it on the map: ` + _suffix(),
  v => `⚽ ${v.a} vs ${v.b} on the grass. The REAL territory dispute is on the map. ` + _suffix(),
  v => `⚽ ${v.a} and ${v.b} play 90 minutes. Pixel wars have no final whistle. Pick a side: ` + _suffix(),
  v => `🏟️ Today's grudge match: ${v.a} v ${v.b}. We checked — annexing each other is allowed here. ` + _suffix(),
  v => `⚽ ${v.a} vs ${v.b}: 11 players each on the pitch, unlimited pixels on the map. Bring backup. ` + _suffix(),
  v => `🥅 ${v.a} and ${v.b} fight for goals tonight. Here, you fight for the whole country. ` + _suffix(),
  v => `⚽ Full time won't decide ${v.a} vs ${v.b}. The map will. Kick off: ` + _suffix(),
  v => `🏆 ${v.a} v ${v.b} on the scoreboard — but the league table that matters is painted in pixels. ` + _suffix(),
  v => `⚽ ${v.a} and ${v.b} trade tackles tonight. Trade territory instead — it lasts longer. ` + _suffix(),
];
function _footballMatchFromTitle(title) {
  if (!_newsCountryAliases) _newsCountryAliases = _buildNewsCountryAliases();
  // "Iran v Congo", "Iran vs Congo", "Iran 1-0 Congo" — take the two sides.
  const m = String(title).match(/^([A-Za-z .'-]{3,30})\s+(?:vs?\.?|\d+\s*-\s*\d+)\s+([A-Za-z .'-]{3,30})(?:[:,|–-]|$)/);
  if (!m) return null;
  const a = _newsCountryAliases.get(m[1].trim().toLowerCase());
  const b = _newsCountryAliases.get(m[2].trim().toLowerCase());
  if (!a || !b || a === b) return null;
  return { a, b };
}
async function _scrapeFootballAndQueue() {
  const UA = 'Mozilla/5.0 (compatible; PixelAnnexBot/1.0; +https://pixelannex.com)';
  let items = [];
  for (const url of FOOTBALL_FEED_URLS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8' } });
      if (!res.ok) continue;
      items = _parseRSSItems(await res.text());
      if (items.length) break;
    } catch (e) { /* try next feed */ }
  }
  if (!items.length) { console.log('[Football] no feed items'); return; }
  const day = new Date().toISOString().slice(0, 10);
  let queued = 0;
  const seenPairs = new Set();
  for (const it of items) {
    if (queued >= FOOTBALL_MAX_PER_RUN) break;
    const match = _footballMatchFromTitle(it.title);
    if (!match) continue;
    const pairKey = [match.a, match.b].sort().join(':');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const text = _pickSassy(SASS_FOOTBALL)({ a: _natHashtag(match.a), b: _natHashtag(match.b) });
    pushTweetDraft({
      type:      'football',
      text,
      dedupeKey: 'football:' + pairKey + ':' + day,
      countries: [match.a, match.b],
      imageUrl:  _portraitUrlFor([match.a, match.b]) || undefined, // v115e: leader portrait
    });
    emitBotEvent({
      type:      'football_matchup',
      tier:      3,
      text,
      aId: match.a, bId: match.b,
      aName: _countryName(match.a), bName: _countryName(match.b),
      timestamp: Date.now(),
    });
    queued++;
    console.log('[Football] matchup queued:', _countryName(match.a), 'v', _countryName(match.b));
  }
}
setInterval(_scrapeFootballAndQueue, 6 * 60 * 60 * 1000); // 4x daily — fixtures roll over fast
setTimeout(_scrapeFootballAndQueue, 3 * 60 * 1000);

// ── v99b: draft-freshness watchdog — drafts spread through day/night ──
// The fixed schedules (status 0/6/18 UTC, daily 12 UTC, news 12h, football 6h)
// can still leave long gaps when a generator dedupes or finds nothing (operator
// saw a 10h-old latest draft). Hourly: if the NEWEST draft is older than 3h,
// run the next generator in rotation. Dedupe keys make a redundant fire a
// harmless no-op, and the next hour tries the next generator in the cycle.
const DRAFT_FRESH_MS = 3 * 60 * 60 * 1000;
let _draftRotationIdx = 0;
function _draftFreshnessTick() {
  try {
    const newest = tweetQueue.length ? tweetQueue[0].ts : 0; // unshift → [0] is newest
    if (Date.now() - newest < DRAFT_FRESH_MS) return;
    const rotation = [
      ['status_report',    () => _emitStatusReport()],
      ['active_report',    () => _emitActiveReport()],
      ['fallen_spotlight', () => _queueFallenSpotlight()],
      ['football',         () => _scrapeFootballAndQueue()],
    ];
    const [name, fn] = rotation[_draftRotationIdx % rotation.length];
    _draftRotationIdx++;
    console.log('[Tweets] freshness watchdog: queue stale, running', name);
    fn();
  } catch (e) { console.warn('[Tweets] freshness watchdog failed:', e.message); }
}
setInterval(_draftFreshnessTick, 60 * 60 * 1000);

// ── v99h: AUTOPOST — automated, spread-out posting over the day ──────
// Operator request: posts go out automatically, spaced across 24h, never two
// posts mentioning the same country within 12h. Every 2.5h (≈9 posts/day max)
// the OLDEST eligible pending draft is posted via the X API:
//   - skipped if any of its countries appeared in a tweet POSTED <12h ago
//   - skipped if the draft is >24h old (stale news — left pending for manual)
// Manual review still works: anything you dismiss in /admin/tweets before its
// slot never posts; the postx button still posts immediately.
// Kill switch: X_AUTOPOST=0 in .env (no restart of cadence needed otherwise).
const X_AUTOPOST_INTERVAL_MS = 2.5 * 60 * 60 * 1000;
const X_AUTOPOST_COUNTRY_GAP_MS = 12 * 60 * 60 * 1000;
// v99j: runtime toggle (dashboard "⚡ Auto-fire" button), persisted so it
// survives restarts. Initial default comes from env (X_AUTOPOST=0 → off).
const AUTOPOST_STATE_FILE = path.join(__dirname, 'autopost_state.json');
let _autopostOn = process.env.X_AUTOPOST !== '0';
try {
  const s = JSON.parse(fs.readFileSync(AUTOPOST_STATE_FILE, 'utf8'));
  if (typeof s.on === 'boolean') _autopostOn = s.on;
} catch (e) { /* no state file yet — use the env default */ }
function _setAutopost(on) {
  _autopostOn = !!on;
  try { fs.writeFileSync(AUTOPOST_STATE_FILE, JSON.stringify({ on: _autopostOn })); } catch (e) {}
  console.log('[X] auto-fire ' + (_autopostOn ? 'ENABLED' : 'DISABLED'));
}
// v115c: auto-dismiss pending drafts older than 24h. They're past the autopost
// window (stale = manual-only) and otherwise lingered until they aged off the
// 50-entry cap; now they're dismissed automatically so the queue stays clean.
const DRAFT_STALE_MS = 24 * 60 * 60 * 1000;
function _dismissStaleDrafts() {
  const now = Date.now();
  let n = 0;
  for (const d of tweetQueue) {
    if (d.status === 'pending' && now - d.ts > DRAFT_STALE_MS) {
      d.status = 'dismissed';
      d.autoDismissed = true;
      n++;
    }
  }
  if (n) { saveTweetQueue(); console.log('[Tweets] auto-dismissed', n, 'stale pending draft(s) (>24h old)'); }
}
setInterval(_dismissStaleDrafts, 60 * 60 * 1000); // hourly
setTimeout(_dismissStaleDrafts, 60 * 1000);       // shortly after boot

// v115c: football posts are capped at this many per UTC day (operator request).
const X_FOOTBALL_PER_DAY = 3;
function _sameUTCDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() &&
         da.getUTCMonth()    === db.getUTCMonth()    &&
         da.getUTCDate()     === db.getUTCDate();
}
function _isNotableDraft(t) {
  return Array.isArray(t.countries) && t.countries.some(c => isNotableCountry(String(c)));
}
async function _autoPostTick() {
  try {
    _dismissStaleDrafts(); // v115c: clear >24h pending before selecting
    if (!_autopostOn || !xposter.isXEnabled()) return;
    const now = Date.now();
    const recentPosted = tweetQueue.filter(d => d.status === 'posted' && d.postedAt &&
                                                now - d.postedAt < X_AUTOPOST_COUNTRY_GAP_MS);
    // Eligible = pending, fresh (<24h), and no country posted in the last 12h.
    const eligible = tweetQueue.filter(d => {
      if (d.status !== 'pending') return false;
      if (now - d.ts > 24 * 60 * 60 * 1000) return false; // stale — manual only
      if (Array.isArray(d.countries) && d.countries.length &&
          recentPosted.some(p => Array.isArray(p.countries) &&
                                 p.countries.some(c => d.countries.includes(c)))) return false;
      return true;
    });
    if (!eligible.length) return;
    // v115c: FOOTBALL EMPHASIS — football drafts post first (until the daily cap),
    // with notable-country matchups ahead of the rest. Then notable non-football,
    // then oldest. Football is excluded once X_FOOTBALL_PER_DAY are already up today.
    const footballToday = tweetQueue.filter(d => d.status === 'posted' && d.type === 'football' &&
                                                 d.postedAt && _sameUTCDay(d.postedAt, now)).length;
    const footballOpen = footballToday < X_FOOTBALL_PER_DAY;
    const candidates = eligible.filter(t => !(t.type === 'football' && !footballOpen));
    if (!candidates.length) return;
    const rank = (t) => {
      let r = 0;
      if (t.type === 'football' && footballOpen) r -= 100; // emphasis: football first
      if (_isNotableDraft(t)) r -= 10;                      // notable-country priority
      return r;
    };
    candidates.sort((a, b) => (rank(a) - rank(b)) || (a.ts - b.ts)); // priority, then oldest
    const t = candidates[0];
    const result = await xposter.postToX({ text: t.text, imageUrl: t.imageUrl });
    t.status = 'posted'; t.postedUrl = result.url || null; t.postedAt = Date.now();
    t.autoPosted = true; // visible in the dashboard JSON for auditing
    saveTweetQueue();
    console.log('[X] auto-posted draft', t.id, '(' + t.type + (t.type === 'football' ? ', ' + (footballToday + 1) + '/' + X_FOOTBALL_PER_DAY + ' today' : '') + ')');
  } catch (e) { console.warn('[X] autopost failed:', e && e.message ? e.message : e); }
}
setInterval(_autoPostTick, X_AUTOPOST_INTERVAL_MS);
setTimeout(_autoPostTick, 20 * 60 * 1000); // first slot ~20min after boot



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
  <!-- v99j: auto-fire toggle — controls the v99h autopost scheduler -->
  <button id="autopost-btn" style="margin-left:auto;" title="When ACTIVE, the oldest eligible pending draft is auto-posted to X every 2.5h (12h per-country gap, drafts >24h old skipped). Dismiss a draft to stop it posting.">⚡ Auto-fire: …</button>
</div>

<div id="tweets"></div>

<script>
const KEY = new URLSearchParams(location.search).get('key');
const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': KEY };
let activeFilter = 'pending';
let X_ENABLED = false;
let AUTOPOST_ON = false; // v99j: auto-fire status, set from /api/tweets
function renderAutopostBtn() {
  const b = document.getElementById('autopost-btn');
  if (!b) return;
  b.textContent = '⚡ Auto-fire: ' + (AUTOPOST_ON ? 'ACTIVE' : 'OFF');
  b.style.background  = AUTOPOST_ON ? '#14532d' : '#1e293b';
  b.style.borderColor = AUTOPOST_ON ? '#22c55e' : '#334155';
  b.style.color       = AUTOPOST_ON ? '#86efac' : '#94a3b8';
  b.style.display     = X_ENABLED ? '' : 'none'; // pointless without X creds
}
document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'autopost-btn') {
    const next = !AUTOPOST_ON;
    if (!confirm(next
      ? 'Enable auto-fire? Pending drafts will be posted to X automatically (one every 2.5h).'
      : 'Disable auto-fire? Posting goes back to manual-only.')) return;
    const r = await fetch('/api/tweets/autopost?key=' + KEY, {
      method: 'POST', headers, body: JSON.stringify({ on: next }),
    });
    const d = await r.json();
    AUTOPOST_ON = !!d.autopost;
    renderAutopostBtn();
  }
}); // v93l: set from /api/tweets — gates the real "Post to X" button

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
  X_ENABLED = !!d.xEnabled;
  AUTOPOST_ON = !!d.autopost; // v99j
  renderAutopostBtn();
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
      \${t.imageUrl ? \`
      <div class="media">
        <img src="\${t.imageUrl}" alt="attached media" loading="lazy"
             onclick="window.open('\${t.imageUrl}','_blank')"
             style="max-width:260px;max-height:200px;border-radius:6px;border:1px solid #1e293b;display:block;margin:8px 0;cursor:zoom-in" />
        <a class="btn-dl" href="\${t.imageUrl}" download
           style="font-size:12px;color:#38bdf8;text-decoration:none">⬇ Download media (attach when posting)</a>
      </div>\` : ''}
      \${t.status === 'posted' && t.postedUrl ? \`<div class="posted-link"><a href="\${t.postedUrl}" target="_blank" style="color:#22c55e;font-size:12px;text-decoration:none">✓ View on X ↗</a></div>\` : ''}
      <div class="actions">
        <span class="count \${t.text.length > 280 ? 'over' : ''}">\${t.text.length}/280</span>
        \${t.status === 'pending' ? \`
          <button class="btn-edit"   data-act="edit">Edit</button>
          <button class="btn-copy"   data-act="copy">Copy</button>
          \${t.imageUrl ? '<button class="btn-copy" data-act="copy-img">Copy image</button>' : ''}
          \${X_ENABLED ? '<button class="btn-post" data-act="postx">🚀 Post to X</button>' : ''}
          <button class="btn-post"   data-act="post-on-x">Open on X ↗</button>
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
  if (act === 'copy-img') {
    // PNG screenshots can go straight to the clipboard for paste into the X
    // composer. GIFs aren't writable to the clipboard in browsers, so fall
    // back to opening the file (then drag/attach, or use Download).
    const imgEl = tweetEl.querySelector('.media img');
    if (!imgEl) return;
    try {
      const resp = await fetch(imgEl.src);
      const blob = await resp.blob();
      if (blob.type === 'image/png' && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        btn.textContent = 'Copied!';
      } else {
        window.open(imgEl.src, '_blank'); // GIF / unsupported: open to save
        btn.textContent = 'Opened';
      }
    } catch (err) {
      window.open(imgEl.src, '_blank');
      btn.textContent = 'Opened';
    }
    setTimeout(() => btn.textContent = 'Copy image', 1500);
    return;
  }
  if (act === 'post-on-x') {
    const url = 'https://x.com/intent/post?text=' + encodeURIComponent(textEl.textContent);
    window.open(url, '_blank');
    return;
  }
  if (act === 'postx') {
    // Real post via the X API (uploads media + tweets). Confirm first since
    // this is irreversible and public.
    if (!confirm('Post this to X now? This is public and cannot be undone.')) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Posting…';
    try {
      const resp = await fetch('/api/tweets/' + id + '/postx?key=' + KEY, {
        method: 'POST', headers,
        body: JSON.stringify({ text: textEl.textContent }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
      btn.textContent = 'Posted ✓';
      load();
    } catch (err) {
      alert('Post to X failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = orig;
    }
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
// v93o: also persist the board on shutdown so deploys/restarts resume the world.
// saveBoardSnapshot is a hoisted fn defined later; sync=true for a clean exit.
process.on('SIGTERM', () => { saveProfiles(); saveBoardSnapshot(true); _saveSessionState(true); });
process.on('SIGINT',  () => { saveProfiles(); saveBoardSnapshot(true); _saveSessionState(true); process.exit(0); });
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
  // v113: aligned to the client RANKS pixel scale (XP == pixels placed) so the
  // Discord ranks match the in-game ranks. Admiral is 3000 (operator request).
  { name: 'Soldier',    min: 0    },
  { name: 'Lieutenant', min: 250  },
  { name: 'Captain',    min: 750  },
  { name: 'General',    min: 1500 },
  { name: 'Admiral',    min: 3000 },
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
// v94a: don't re-announce "Under Siege" to Discord for the same geo within this
// window (a country hovering around 50% would otherwise flap start/end repeatedly).
// The in-game siege broadcast to clients still fires every time — only the Discord
// post is throttled.
const SIEGE_ANNOUNCE_COOLDOWN_MS = 15 * 60 * 1000;
const _siegeAnnouncedAt = new Map(); // geoIdx → last announce ts

function checkSiegeState(geoIdx) {
  const total = geoTotal[geoIdx] || 0;
  if (!total) return;
  // v97d: the country being DEFENDED is the current holder if the native has fallen,
  // else the native. Exclude BOTH the native and that owner from the attacker calc,
  // so a conquered country's own holder isn't mistaken for the besieger (which gave
  // bogus "Brazil has 100% of USA" posts). A siege now means a THIRD party is
  // attacking the current owner.
  const nativeId = geoToId(geoIdx);
  const ownerId  = _foreignHolderOf(geoIdx) || nativeId; // holder if conquered, else native
  let dominantEnemy = null;
  let maxEnemy = 0;
  if (geoClaimCnt[geoIdx]) {
    for (const [cId, cnt] of Object.entries(geoClaimCnt[geoIdx])) {
      if (cId === nativeId || cId === String(ownerId)) continue; // skip native + current owner
      if (cnt > maxEnemy) { maxEnemy = cnt; dominantEnemy = cId; }
    }
  }
  const ratio = maxEnemy / total;
  const wasSieged = siegedSet.has(geoIdx);

  if (ratio >= SIEGE_THRESHOLD && !wasSieged) {
    siegedSet.add(geoIdx);
    const _nowS = Date.now();
    // v94a: throttle the Discord announce per geo (anti-flap); always broadcast
    // to game clients below so the in-game siege flash stays responsive.
    if (_nowS - (_siegeAnnouncedAt.get(geoIdx) || 0) > SIEGE_ANNOUNCE_COOLDOWN_MS) {
      _siegeAnnouncedAt.set(geoIdx, _nowS);
      emitBotEvent({
        type:        'war_siege_start',
        tier:        2,
        attackerId:  dominantEnemy,
        defenderId:  nativeId,
        // v97d: only override the name when conquered (else bot.js keeps the native's
        // role-mention/ping); "Holder (formerly Native)" when a holder exists.
        defenderName: (String(ownerId) !== String(nativeId)) ? _geoDefenderName(nativeId) : undefined,
        ratio:       Math.round(ratio * 100),
        timestamp:   Date.now(),
      });
    }
    // v92w: also tell game CLIENTS so the in-game siege flash + "under attack"
    // alert are server-authoritative (independent of viewport delta filtering,
    // which otherwise starves the client's geoClaimCnt/geoLossLog heuristic).
    broadcast(JSON.stringify({ type: 'siege', countryId: geoToId(geoIdx), attackerId: dominantEnemy, active: true }));
  } else if (ratio < SIEGE_THRESHOLD && wasSieged) {
    siegedSet.delete(geoIdx);
    emitBotEvent({
      type:        'war_siege_end',
      tier:        1,
      defenderId:  geoToId(geoIdx),
      timestamp:   Date.now(),
    });
    broadcast(JSON.stringify({ type: 'siege', countryId: geoToId(geoIdx), active: false }));
  }
}



// ── v34: Multi-attacker detection ────────────────────────────────
// When 5+ distinct attacker countries paint into the same defender geo AND
// they've collectively painted ≥200 pixels in a rolling 5-minute window,
// emit a 'war_multi_attack' event once per defender per 5-minute cooldown.
//
// v84: rewrote rate-limit. Was: 5 attackers in 60s + ≥5% of territory claimed.
// That fired on transient swarms even when they barely painted anything.
// Now: 5 attackers in 5min + ≥200 pixels painted in window — proves it's a
// sustained assault, not a flyby. Cuts notification noise dramatically.
// v94a: slowed for "major events only" — multi-attack was still too frequent.
// Require more attackers (6) and a much longer per-defender cooldown (30 min) so
// the SAME defender doesn't re-announce every 5 minutes.
const MULTI_ATTACK_THRESHOLD    = 12;            // v99a: 10→12 distinct attackers (sustained-only tuning)
const MULTI_ATTACK_WINDOW_MS    = 5 * 60 * 1000; // was 60s
const MULTI_ATTACK_MIN_PIXELS   = 400;            // v99a: 200→400 — total px painted by all attackers in window
const MULTI_ATTACK_COOLDOWN_MS  = 60 * 60 * 1000; // v95p: 30→60 min per defender (≤1/hr each)
// v99a: SUSTAINED-only — an attacker must have been hitting this defender for at
// least this long (firstTs) to count toward the headcount. A burst that appears
// and vanishes inside 3 minutes never announces, however many countries join.
const MULTI_ATTACK_MIN_SUSTAIN_MS = 3 * 60 * 1000;
// v92k (#5): size-relative pixel floor. 200px is a huge deal for a micro-state but
// trivial for Russia (91k px). The effective floor scales with the defender's land
// area: floor = clamp(land * FRAC, MIN_PIXELS, MAX_PIXELS). So a multi-attack means
// the same proportional pressure regardless of country size. Resulting floors:
//   micro/median (<2.5k land) → 200 (absolute floor dominates)
//   Brazil (22k)  → ~1.8k   |  USA/China/Canada/Russia → 2500 (ceiling)
// FRAC/MAX are the dials — raise to make big-country attacks even harder to flag.
const MULTI_ATTACK_MIN_FRAC     = 0.08;           // 8% of defender land...
const MULTI_ATTACK_MAX_PIXELS   = 2500;           // ...but never demand more than this
// v92k (#6): minimum pixels a single country must paint to COUNT as an attacker.
// Stops "4 one-pixel flybys + 1 real attacker" from tripping the 5-country headcount.
const MULTI_ATTACK_MIN_PIXELS_PER_ATTACKER = 50; // v99a: 25→50
// defenderGeoIdx → { attackers: Map(attackerId → { lastTs, pixels }), lastNotifyAt }
const _multiAttackTracker = new Map();

// v87: per-player rally-call cooldown tracker (pid → last rally timestamp).
let _rallyLastByPid = new Map();

function trackAttackerOnDefender(attackerCountryId, defenderGeoIdx) {
  // Skip self-paint (resident bot painting own country)
  if (String(attackerCountryId) === String(geoToId(defenderGeoIdx))) return;
  const now = Date.now();
  let entry = _multiAttackTracker.get(defenderGeoIdx);
  if (!entry) {
    entry = { attackers: new Map(), lastNotifyAt: 0 };
    _multiAttackTracker.set(defenderGeoIdx, entry);
  }
  // Prune expired (v84: by lastTs)
  for (const [aid, info] of entry.attackers) {
    if (now - info.lastTs > MULTI_ATTACK_WINDOW_MS) entry.attackers.delete(aid);
  }
  // Update attacker's pixel count + lastTs (each call = 1 pixel painted)
  const aidStr = String(attackerCountryId);
  let info = entry.attackers.get(aidStr);
  if (!info) {
    info = { firstTs: now, lastTs: now, pixels: 1 }; // v99a: firstTs for the sustain check
    entry.attackers.set(aidStr, info);
  } else {
    info.lastTs = now;
    info.pixels++;
  }
  // Eligibility (v92k): enough QUALIFYING attackers AND enough total pixels (size-scaled).
  if (now - entry.lastNotifyAt > MULTI_ATTACK_COOLDOWN_MS) {
    // #6: only attackers who each cleared the per-attacker floor count toward the
    // 5-country headcount; flybys still add to totalPixels but not to the count.
    let totalPixels = 0;
    const attackerIds = [];
    for (const [aid, info] of entry.attackers) {
      totalPixels += info.pixels;
      // v99a: sustained-only — must clear the pixel floor AND have been attacking
      // for ≥3min (firstTs may be missing on entries from before this deploy).
      if (info.pixels >= MULTI_ATTACK_MIN_PIXELS_PER_ATTACKER &&
          (now - (info.firstTs || info.lastTs)) >= MULTI_ATTACK_MIN_SUSTAIN_MS) attackerIds.push(aid);
    }
    if (attackerIds.length < MULTI_ATTACK_THRESHOLD) return;
    // #5: total-pixel floor scales with the defender's land area.
    const defenderLand = geoTotal[defenderGeoIdx] || 0;
    const effectiveFloor = Math.min(
      MULTI_ATTACK_MAX_PIXELS,
      Math.max(MULTI_ATTACK_MIN_PIXELS, Math.round(defenderLand * MULTI_ATTACK_MIN_FRAC)));
    if (totalPixels < effectiveFloor) return;
    const defenderId = geoToId(defenderGeoIdx);
    // v92f: only announce a multi-attack if the defender or some attacker is
    // notable (same gate as conquests — kills tiny-island spam, keeps the relay
    // budget for events worth seeing).
    if (!isNotableCountry(defenderId) && !attackerIds.some(a => isNotableCountry(a))) return;
    entry.lastNotifyAt = now;
    const _sassyMulti = _pickSassy(SASS_MULTI)({
      n:   attackerIds.length,
      d:   _geoDefenderName(defenderId), // v97d: name the current holder if conquered
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
      // v93m: country names as national hashtags inline (defender + attackers).
      // v97d: defender tag names the current holder if the native has fallen.
      const defName = _geoDefenderTag(defenderId);
      const attNames = attackerIds.slice(0, 3).map(id => _natHashtag(id)).join(', ');
      const more = attackerIds.length > 3 ? ' +' + (attackerIds.length - 3) + ' more' : '';
      const sassyMulti = _pickSassy(SASS_MULTI)({
        n: attackerIds.length,
        d: defName,
        atk: attNames + more,
      });
      pushTweetDraft({
        type:        'multi_attack',
        // Defender is already a hashtag inline now, so the old trailing
        // flag+hashtag tag is dropped to avoid duplication.
        // v114: append the defender's GDP when known (single clear subject).
        text:        (sassyMulti + _gdpTag(defenderId)).slice(0, 279),
        dedupeKey:   'multi_attack:' + defenderId + ':' + Math.floor(now / 60000),
        throttleKey: 'multi_attack_def:' + defenderId,
        countries:   [defenderId, ...attackerIds], // v84: notable if defender OR any attacker is notable
        imageUrl:    makeCountryShot(defenderId, _foreignHolderOf(defenderId) || defenderId) || undefined, // v88/v97d: holder's flag if conquered
      });
    } catch (e) { /* ignore */ }
  }
}
// Periodic cleanup (v84: uses new attacker shape { lastTs, pixels })
setInterval(() => {
  const now = Date.now();
  for (const [defId, entry] of _multiAttackTracker) {
    for (const [aid, info] of entry.attackers) {
      if (now - info.lastTs > MULTI_ATTACK_WINDOW_MS) entry.attackers.delete(aid);
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
let _worldWinnerName = null; // v100: winning bloc name for the win screen

// ── v97: per-player SESSION stats + the "war" (game) counter ──────
// SESSION = the CURRENT GAME, i.e. until the world is conquered (v97h). It now
// PERSISTS to disk so a server restart mid-game keeps the running tally; it is
// cleared ONLY on _resetWorld (world conquered), which also bumps the war number.
// All-time stats live in the persisted profile (cumulative across all games).
const SESSION_FILE = path.join(__dirname, 'session_state.json');
let _warNumber = 1;                 // v97h: which PixelAnnex War (game #) this is
let _sessionStartMs = Date.now();
const _sessionStats = new Map(); // discordId → { discordId, username, avatar, country, pixels, conquests }
let _sessionDirty = false;
function _recordSession(discordId, username, avatar, country, dPixels, dConquests) {
  if (!discordId) return;
  let s = _sessionStats.get(discordId);
  if (!s) { s = { discordId, username, avatar, country, pixels: 0, conquests: 0 }; _sessionStats.set(discordId, s); }
  if (username) s.username = username;
  if (avatar)   s.avatar   = avatar;
  if (country)  s.country  = country;
  s.pixels    += dPixels    || 0;
  s.conquests += dConquests || 0;
  _sessionDirty = true;
}
function _sessionLeaderboard(limit) {
  return [..._sessionStats.values()]
    .filter(s => s.username && (s.pixels > 0 || s.conquests > 0))
    .sort((a, b) => (b.pixels - a.pixels) || (b.conquests - a.conquests))
    .slice(0, limit || 20);
}
function _saveSessionState(sync) {
  try {
    const data = JSON.stringify({ warNumber: _warNumber, startMs: _sessionStartMs, stats: [..._sessionStats.values()] });
    const tmp = SESSION_FILE + '.tmp';
    if (sync) { fs.writeFileSync(tmp, data); fs.renameSync(tmp, SESSION_FILE); }
    else { fs.writeFile(tmp, data, e => { if (!e) fs.rename(tmp, SESSION_FILE, () => {}); }); }
    _sessionDirty = false;
  } catch (e) { console.warn('[Session] save failed:', e.message); }
}
function _loadSessionState() {
  try {
    if (!fs.existsSync(SESSION_FILE)) { console.log('[Session] none on disk — War #1, fresh tally'); return; }
    const d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (d && typeof d.warNumber === 'number') _warNumber = d.warNumber;
    if (d && typeof d.startMs === 'number') _sessionStartMs = d.startMs;
    if (d && Array.isArray(d.stats)) for (const s of d.stats) if (s && s.discordId) _sessionStats.set(String(s.discordId), s);
    console.log('[Session] restored War #' + _warNumber + ',', _sessionStats.size, 'players this game');
  } catch (e) { console.warn('[Session] load failed:', e.message); }
}
_loadSessionState();
setInterval(() => { if (_sessionDirty) _saveSessionState(false); }, 30 * 1000); // persist running tally

function _countDistinctConquered() {
  const set = new Set();
  for (const key of conqueredSet) set.add(String(key).split(':')[0]);
  return set.size;
}
function _totalCountries() {
  return Object.keys(countryNames || {}).length || 240;
}
// v97c: counts of REAL playable nations (excludes Natural Earth artifacts: unnamed
// "Country NNN" / "Disputed Territory" features and landless geos). standing = not
// yet conquered; fallen = homeland permanentlyConquered. standing+fallen = total.
function _playableCountryStats() {
  let total = 0, fallen = 0;
  for (const id of Object.keys(countryNames || {})) {
    if (!_isPlayableNation(id)) continue; // v101a: excludes micro countries (Vatican etc.) too
    total++;
    if (permanentlyConquered.has(String(id))) fallen++;
  }
  return { total, fallen, standing: Math.max(0, total - fallen) };
}
function _isPaintLocked() { return _worldConquestActive; }

// v138a: cached playable-nation list for the instant welcome picker (/api/playable).
let _playableListCache = null, _playableListAt = 0;

// ── v100 (Phase 2B): endgame — sudden death + new win condition ──────────────
// Win = a BLOC (an alliance counts as one, else a solo country) controls
// >=65% of playable countries AND >=65% of total land pixels. Sudden death (2x
// regen) + the endgame panel kick in at <=5 standing countries.
const SUDDEN_DEATH_STANDING = 5;
const WIN_COUNTRIES_FRAC    = 0.65;
const WIN_PIXELS_FRAC       = 0.65;
let _suddenDeath   = false;   // mirrored to clients (regen x2) + drives the panel
let _suddenDeathTweeted = false; // v105: fire the sudden-death tweet once per game
let _endgamePayload = null;   // last _computeEndgame() result (served + broadcast)

// v105: playable nations whose homeland still stands (not permanentlyConquered).
function _standingNations() {
  const out = [];
  for (const id of Object.keys(countryNames || {})) {
    if (!_isPlayableNation(id)) continue;
    if (permanentlyConquered.has(String(id))) continue;
    out.push(_countryName(id));
  }
  return out;
}
// v105: fire an IMMEDIATE tweet (bypass the manual-approve queue) with a fresh
// full-world snapshot. Falls back to a queued draft if X is disabled or the post
// fails. Used for the two endgame triggers (world conquest + sudden death).
async function _fireEndgameTweet(text, dedupeKey) {
  let imageUrl = null;
  try { imageUrl = makeWorldShot(); } catch (e) {}
  if (xposter.isXEnabled()) {
    try {
      const r = await xposter.postToX({ text, imageUrl });
      console.log('[Tweet] endgame posted immediately:', (r && r.url) || '(posted)');
      return;
    } catch (e) { console.warn('[Tweet] endgame immediate post failed, queuing draft:', e.message); }
  }
  try { pushTweetDraft({ type: 'endgame', text, imageUrl, dedupeKey }); } catch (e) {}
}
function _fireSuddenDeathTweet() {
  try {
    const standing = _standingNations();
    const topP = _sessionLeaderboard(3).map(s => s.username).filter(Boolean).join(', ');
    const text = '⚔️ SUDDEN DEATH on PixelAnnex — only ' + standing.length + ' nations remain: ' +
      standing.join(', ') + '. Regen is DOUBLED — the endgame is here.' +
      (topP ? ' Top players: ' + topP : '') + ' ' + GAME_URL + ' #PixelAnnex';
    _fireEndgameTweet(text, 'sudden_death:' + _warNumber);
  } catch (e) { console.warn('[Tweet] sudden death tweet failed:', e.message); }
}

// Is a country a real playable nation? (matches the engine's _isPlayableCountry
// gate). v101a: must clear MIN_PLAYABLE_PX_SRV — the old `> 0` check let micro
// countries (Vatican etc., a few residual px, no bot, unselectable) show up as
// standing endgame contenders.
function _isPlayableNation(id) {
  const sid = String(id);
  if (NON_PLAYABLE_IDS.has(sid)) return false;
  if ((geoTotal[id] || 0) < MIN_PLAYABLE_PX_SRV) return false;
  const nm = countryNames[id];
  if (!nm || /^Country \d+$/.test(nm) || nm === 'Disputed Territory') return false;
  return true;
}

// Compute per-bloc control of countries + pixels and the sudden-death flag.
function _computeEndgame() {
  if (totalLandPxCached <= 0) recomputeTotalLand();
  // Who currently HOLDS each fallen geo (geo:holder)? last writer wins (1 holder).
  const holderOf = {};
  for (const k of conqueredSet) {
    const p = String(k).split(':');
    if (p[0] && p[1] && p[0] !== p[1]) holderOf[p[0]] = p[1];
  }
  const blocs = new Map(); // blocKey -> { key, name, members:Set, countriesHeld, pixels }
  const blocFor = (cid) => {
    const ally = getAllianceForCountry(String(cid));
    const key  = ally ? ('ally:' + ally.key) : ('solo:' + cid);
    if (!blocs.has(key)) {
      blocs.set(key, {
        key,
        name: ally ? (ally.name || 'Alliance') : _countryName(cid),
        members: ally ? new Set(ally.countries.map(String)) : new Set([String(cid)]),
        countriesHeld: 0, pixels: 0,
      });
    }
    return blocs.get(key);
  };
  let total = 0, fallen = 0;
  for (const id of Object.keys(countryNames || {})) {
    if (!_isPlayableNation(id)) continue;
    total++;
    const sid = String(id);
    let controller = null;
    if (!permanentlyConquered.has(sid)) controller = sid;        // standing: holds itself
    else { fallen++; controller = holderOf[sid] || null; }       // fallen: current holder or neutral
    if (controller) blocFor(controller).countriesHeld++;
  }
  for (const b of blocs.values()) {
    let px = 0;
    for (const m of b.members) px += countryPxCount[m] || 0;
    b.pixels = px;
  }
  const standing = Math.max(0, total - fallen);
  _suddenDeath = standing > 0 && standing <= SUDDEN_DEATH_STANDING;
  const denomC = total || 1;
  const denomP = totalLandPxCached || 1;
  const contenders = [...blocs.values()]
    .map(b => ({
      key: b.key, name: b.name,
      countriesHeld: b.countriesHeld,
      countriesFrac: b.countriesHeld / denomC,
      pixelsFrac: b.pixels / denomP,
    }))
    .sort((a, b) => Math.min(b.countriesFrac, b.pixelsFrac) - Math.min(a.countriesFrac, a.pixelsFrac));
  return {
    suddenDeath: _suddenDeath, standing, total,
    winCountriesFrac: WIN_COUNTRIES_FRAC, winPixelsFrac: WIN_PIXELS_FRAC,
    contenders: contenders.slice(0, 8),
  };
}

// Broadcast the endgame state (panel + sudden-death flag) to all clients.
function _broadcastEndgame(eg) {
  _endgamePayload = eg;
  broadcast(JSON.stringify({ type: 'endgame', ...eg }));
}

function _checkWorldConquest() {
  if (_worldConquestActive) return;
  const eg = _computeEndgame();
  _broadcastEndgame(eg); // keep clients' sudden-death + panel current
  // v105: fire the sudden-death tweet ONCE, on the rising edge into sudden death.
  if (eg.suddenDeath && !_suddenDeathTweeted) { _suddenDeathTweeted = true; _fireSuddenDeathTweet(); }
  // v100: win = a bloc holds >=65% of countries AND >=65% of land pixels.
  const winner = eg.contenders.find(c =>
    c.countriesFrac >= WIN_COUNTRIES_FRAC && c.pixelsFrac >= WIN_PIXELS_FRAC);
  if (!winner) return;
  const total = eg.total;
  const conquered = _countDistinctConquered();
  _worldConquestActive = true;
  _worldWinnerName = winner.name; // v100: surfaced on the win screen
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
  // v97: this round's top contributors (session pixels + conquests).
  const topContributors = _sessionLeaderboard(5).map(s => ({
    username: s.username, avatar: s.avatar, pixels: s.pixels, conquests: s.conquests, country: s.country,
  }));
  console.log('[v100] WORLD WON by ' + winner.name + '! countries=' + (winner.countriesFrac*100).toFixed(1) + '% pixels=' + (winner.pixelsFrac*100).toFixed(1) + '%');
  // v61: store payload so late-joiners and refreshers get the same screen
  _worldConquestPayload = { type: 'world_conquest', conquered, total, topCountries, topPlayers, topContributors, resetAt: _worldResetAt,
    winnerName: winner.name, winnerCountriesFrac: winner.countriesFrac, winnerPixelsFrac: winner.pixelsFrac }; // v100
  broadcast(JSON.stringify(_worldConquestPayload));
  emitBotEvent({
    type:        'world_conquest',
    tier:        3,
    conquered, total, topCountries, topPlayers,
    timestamp:   Date.now(),
    sassyText:   '🌍 THE WORLD HAS BEEN CONQUERED! ' + conquered + '/' + total + ' countries claimed. Top conqueror: ' + (topCountries[0] && topCountries[0].name || '??') + ' with ' + (topCountries[0] && topCountries[0].conquests || 0) + '. Resetting in 5 minutes.',
  });
  // v105: world conquest fires an IMMEDIATE tweet (bypasses the manual queue) with
  // a fresh world snapshot + the last nations standing + top players.
  try {
    const standing = _standingNations();
    const finalNations = (standing.length ? standing.slice(0, 2) : [winner.name]).join(' & ');
    const topP = (topContributors.length ? topContributors : topPlayers)
      .slice(0, 3).map(p => p.username).filter(Boolean).join(', ');
    const wc = Math.round(winner.countriesFrac * 100), wp = Math.round(winner.pixelsFrac * 100);
    const text = '🌍 THE WORLD HAS BEEN CONQUERED! ' + winner.name + ' wins — ' + wc +
      '% of countries & ' + wp + '% of the map. Last standing: ' + finalNations +
      (topP ? '. Top players: ' + topP : '') + '. ' + GAME_URL + ' #PixelAnnex';
    _fireEndgameTweet(text, 'world_conquest:' + Math.floor(_worldResetAt / 1000));
  } catch(e) { console.warn('[Tweet] world conquest tweet failed:', e.message); }
  setTimeout(_resetWorld, WORLD_RESET_COUNTDOWN_MS);
}

function _resetWorld() {
  console.log('[v38] Resetting world state…');
  for (let i = 0; i < claimByPixel.length; i++) claimByPixel[i] = -1;
  conqueredSet.clear();
  permanentlyConquered.clear();
  exiledSet.clear(); // v97e
  _emoteByGeo.clear(); // v113: drop all conquest emotes on world reset
  for (const k of Object.keys(geoClaimCnt)) delete geoClaimCnt[k];
  for (const k of Object.keys(countryPxCount)) countryPxCount[k] = 0;
  for (const k of Object.keys(ownerPixels)) ownerPixels[k] = new Set();
  if (typeof _nukeZones !== 'undefined') _nukeZones.length = 0;
  _worldConquestActive = false;
  _worldResetAt = 0;
  _worldConquestPayload = null; // v61: clear so new sessions don't see stale overlay
  _suddenDeath = false; _suddenDeathTweeted = false; // v105: re-arm endgame tweet for the new game
  // v97h: a finished game → next War. Bump the counter, wipe the session tally
  // (all-time profiles persist), persist immediately.
  _warNumber += 1;
  _sessionStats.clear(); _sessionStartMs = Date.now();
  _saveSessionState(true);
  console.log('[Session] world reset → now PixelAnnex War #' + _warNumber);
  _timelapseRoundStart = Date.now(); // v95x: fresh timelapse window after a reset
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

// v95v: admin auth — reuse the tweet-panel secret. key via ?key= or x-admin-key header.
// v98b hardening: timing-safe compare + HttpOnly cookie support so the secret
// doesn't have to live in the URL (history/logs/Referer leak). The HTML pages
// set the cookie on a valid ?key= load and redirect to a clean URL.
function _secretEquals(given, expected) {
  try {
    const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function _adminCookieKey(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)pa_admin=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function _adminOK(url, req) {
  const expected = process.env.TWEETS_ADMIN_SECRET;
  if (!expected) return false;
  // Any valid source wins — dashboard JS may send a stale/empty ?key= ("null")
  // after the cookie redirect, which must not shadow a valid cookie.
  return [url.searchParams.get('key'), req.headers['x-admin-key'], _adminCookieKey(req)]
    .some(k => k && _secretEquals(k, expected));
}
// Set the admin cookie + strip ?key= from the address bar. Returns true if a
// redirect was issued (caller should stop).
function _adminCookieRedirect(url, req, res) {
  if (!url.searchParams.get('key')) return false;
  res.writeHead(302, {
    'Set-Cookie': 'pa_admin=' + encodeURIComponent(url.searchParams.get('key')) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400',
    'Location': url.pathname,
  });
  res.end();
  return true;
}

// v95v: operator dashboard — live KPIs + safe world controls. Served at /admin
// (gated by TWEETS_ADMIN_SECRET via ?key=). Talks to /api/admin/metrics + /control.
const ADMIN_DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PixelAnnex — Admin</title><style>
  body{margin:0;background:#0a0e17;color:#cbd5e1;font:13px/1.5 system-ui,sans-serif;padding:16px;max-width:920px;margin:0 auto}
  h1{font-size:18px;color:#fff;margin:0 0 4px}.sub{color:#64748b;font-size:11px;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
  .card{background:#111827;border:1px solid #1e293b;border-radius:8px;padding:12px}
  .card .v{font-size:22px;font-weight:700;color:#fff}.card .l{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
  .sec{background:#111827;border:1px solid #1e293b;border-radius:8px;padding:14px;margin-bottom:14px}
  .sec h2{font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px}
  button{background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin:0 6px 6px 0}
  button:hover{background:#334155}button.danger{border-color:#7f1d1d;color:#fca5a5}button.danger:hover{background:#3b1010}
  input{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px;border-radius:6px;font-size:12px;width:300px;max-width:60%}
  #msg{margin-left:8px;color:#4ade80;font-size:11px}
  table{width:100%;border-collapse:collapse;font-size:12px}td{padding:3px 6px;border-bottom:1px solid #1e293b}
  .pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px}
  .on{background:#052e16;color:#4ade80}.off{background:#3b1010;color:#fca5a5}
</style></head><body>
<h1>PixelAnnex — Admin</h1><div class="sub" id="ver">loading…</div>
<div class="grid" id="kpis"></div>
<div class="sec"><h2>Top conquerors</h2><table id="conq"><tr><td>—</td></tr></table></div>
<div class="sec"><h2>World controls</h2>
  <button id="btn-bots">Toggle bots</button>
  <button onclick="ctl('monster','&type=ufo')">Spawn UFO</button>
  <button onclick="ctl('monster','&type=kraken')">Spawn Kraken</button>
  <button onclick="ctl('monster','&type=godzilla')">Spawn Godzilla</button>
  <button class="danger" onclick="if(confirm('Reset the entire world? This wipes all pixels + conquests.'))ctl('reset','')">Reset world</button>
  <div style="margin-top:10px"><input id="bc" placeholder="Broadcast message to all players…" maxlength="200">
  <button onclick="bcast()">Send</button></div>
  <span id="msg"></span>
</div>
<script>
  var KEY=new URLSearchParams(location.search).get('key')||'';
  function q(p){return p+(p.indexOf('?')<0?'?':'&')+'key='+encodeURIComponent(KEY)}
  function note(t){var m=document.getElementById('msg');m.textContent=t;setTimeout(function(){m.textContent=''},3000)}
  function ctl(action,extra){fetch(q('/api/admin/control?action='+action+(extra||'')),{method:'POST'}).then(r=>r.json()).then(j=>{note(JSON.stringify(j));refresh()}).catch(e=>note('err'))}
  function bcast(){var t=document.getElementById('bc').value.trim();if(!t)return;fetch(q('/api/admin/control?action=broadcast&text='+encodeURIComponent(t)),{method:'POST'}).then(r=>r.json()).then(j=>{document.getElementById('bc').value='';note('sent')})}
  document.getElementById('btn-bots').onclick=function(){var off=window._m&&window._m.botsDisabled;ctl('bots','&disabled='+(off?'0':'1'))};
  function kpi(v,l){return '<div class="card"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>'}
  function refresh(){fetch(q('/api/admin/metrics')).then(r=>r.json()).then(function(m){
    window._m=m;
    document.getElementById('ver').textContent='v'+m.serverVersion+' · up '+Math.floor(m.uptimeSec/3600)+'h'+Math.floor(m.uptimeSec%3600/60)+'m · '+m.memRssMB+'MB · bots <span class="pill '+(m.botsDisabled?'off':'on')+'">'+(m.botsDisabled?'OFF':'ON')+'</span>';
    document.getElementById('kpis').innerHTML=
      kpi(m.humanPlayers,'Humans online')+kpi(m.signedInPlayers+' ('+m.signInRatePct+'%)','Signed-in online')+
      kpi(m.activeBots,'Active bots')+kpi(m.conquests+' / '+m.totalCountries,'Conquered')+
      kpi(m.paintedPixels.toLocaleString(),'Painted px')+kpi(m.profilesTotal,'Registered users');
    var rows=(m.topConquerors||[]).map(c=>'<tr><td>'+c.country+'</td><td style="text-align:right;color:#fbbf24">'+c.conquests+'</td></tr>').join('')||'<tr><td>none yet</td></tr>';
    document.getElementById('conq').innerHTML=rows;
    document.getElementById('btn-bots').textContent=m.botsDisabled?'Enable bots':'Disable bots';
  }).catch(e=>document.getElementById('ver').textContent='metrics error (check ?key=)')}
  refresh();setInterval(refresh,5000);
</script></body></html>`;



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

const MONSTER_DEBUG = false; // v93j: was true (2-min spam). Production cadence.

// Production intervals — v93j: widened so the COMBINED spawn rate across all three
// monster types is ~1 every 15 min (operator request), not the old ~1/5min.
//   Kraken ~35m + Godzilla ~40m + UFO ~65m  ->  ~1 monster / ~14 min.
const UFO_PROD_MIN_MS      = 50 * 60 * 1000;
const UFO_PROD_MAX_MS      = 80 * 60 * 1000;
const KRAKEN_PROD_MIN_MS   = 25 * 60 * 1000;
const KRAKEN_PROD_MAX_MS   = 45 * 60 * 1000;
const GODZILLA_PROD_MIN_MS = 30 * 60 * 1000;
const GODZILLA_PROD_MAX_MS = 50 * 60 * 1000;
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
      // v91: use size-scaled reversal threshold (hysteresis below conquest)
      if (getAllyOwnedCount(geo, ownerId) / total < reversalThreshold(total)) {
        conqueredSet.delete(key);
        _clearPermanentIfFree(geo); // v93u (Fix B): unlock if no longer held
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

// v86: alliances now require 10+ members (was 3). Discourages tiny clique-
// alliances and means alliances only form when there's real shared interest.
// v93c: env-configurable so the formation flow can be staged-tested by lowering
// it via PM2 (ALLIANCE_MIN_MEMBERS=3 pm2 restart ... --update-env) without a code
// deploy. Defaults to 10. NOTE: not present in .env, so dotenv override:true
// leaves a PM2-injected value intact.
const ALLIANCE_MIN_MEMBERS = parseInt(process.env.ALLIANCE_MIN_MEMBERS, 10) || 10;
const ALLIANCE_RECOMPUTE_MS = 30000;

// Active alliances: alliance_key (sorted country IDs joined by '-') → { countries:[], members:[discordIds] }
const alliances = new Map();
// v92u (Phase 1A): nascent clusters — real coalitions forming but not yet at
// ALLIANCE_MIN_MEMBERS. key → { countries:[], memberCount }. Drives the Discord
// #alliance-radar progress cards via 'alliance_progress' events.
const NASCENT_MIN_MEMBERS = 2;
const nascentAlliances = new Map();

function recomputeAlliances() {
  // v92u: was `< ALLIANCE_MIN_MEMBERS` — lowered so nascent clusters are tracked
  // (radar progress) well before the 10-member lock-in. Union-find is cheap.
  if (profiles.size < NASCENT_MIN_MEMBERS) return;

  // Build: country_id → Set<discordId> who have this country in a COALITION slot.
  // v92z: coalition membership uses the B/C slots only. Homeland (countryMain)
  // still fights + counts for conquest, but does NOT auto-enroll you in an
  // alliance — so the Leave button can fully remove you, and your nation isn't
  // dragged into a bloc just because someone else allied with it.
  const countryMembership = new Map();
  for (const [discordId, profile] of profiles) {
    const countries = [profile.countryB, profile.countryC].filter(Boolean);
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

  // For each player, union their COALITION countries together (B/C only — v92z).
  for (const profile of profiles.values()) {
    const cs = [profile.countryB, profile.countryC].filter(Boolean);
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
        // v93: Phase 2 — combined held territory + a multi-country footprint shot
        strength:  alliance.countries.reduce((s, c) => s + (countryPxCount[c] || 0), 0),
        imageUrl:  makeAllianceShot(alliance.countries) || undefined,
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

  // v92u (Phase 1A): nascent clusters (2..MIN-1 members, >=2 countries). Emit
  // 'alliance_progress' on new/changed, and a {gone:true} when a cluster leaves
  // the nascent band (promoted to a full alliance, or fell apart) so the radar
  // card is removed. recompute runs every 30s, so this is naturally throttled.
  const newNascent = new Map();
  for (const cluster of Object.values(clusters)) {
    const mc = cluster.members.size;
    if (cluster.countries.size < 2) continue;
    if (mc < NASCENT_MIN_MEMBERS || mc >= ALLIANCE_MIN_MEMBERS) continue;
    const key = [...cluster.countries].sort((a, b) => +a - +b).join('-');
    newNascent.set(key, { countries: [...cluster.countries].sort((a, b) => +a - +b), memberCount: mc, members: [...cluster.members] });
  }
  for (const [key, n] of newNascent) {
    const prev = nascentAlliances.get(key);
    if (!prev || prev.memberCount !== n.memberCount) {
      emitBotEvent({
        type:        'alliance_progress',
        key,
        countries:   n.countries,
        memberCount: n.memberCount,
        needed:      ALLIANCE_MIN_MEMBERS - n.memberCount,
      });
    }
  }
  for (const key of nascentAlliances.keys()) {
    if (!newNascent.has(key)) emitBotEvent({ type: 'alliance_progress', key, gone: true });
  }
  nascentAlliances.clear();
  for (const [k, v] of newNascent) nascentAlliances.set(k, v);
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

// ── v93g (Phase 3B): Alliance Vaults + Allied Surge ──────────────────────────
// Vault = persisted per-alliance war-chest that accrues 5% of online allied
// humans' passive regen. Allied Surge = leader-only, once/24h/alliance, gives
// online members +50% stroke-bucket refill for 5 min. ALL enforcement is
// server-side (cooldown via timestamp, leader check, eligibility).
const ALLIANCE_STATE_FILE = path.join(__dirname, 'alliance_state.json');
let _allianceVaults    = {}; // key -> accrued px
let _allianceLastSurge = {}; // key -> last surge start ts
const _surgeUntil      = new Map(); // pid -> surge-active-until ts (in-memory; surge is short)
const VAULT_ACCRUAL_MS   = 30000;
const VAULT_REGEN_FRAC   = 0.05;
const SURGE_MS           = 5 * 60 * 1000;
const SURGE_COOLDOWN_MS  = 24 * 60 * 60 * 1000;
const SURGE_REFILL_MULT  = 1.5;
const _RANK_INDEX = { Soldier: 0, Lieutenant: 1, Captain: 2, General: 3, Admiral: 4 };

function loadAllianceState() {
  try {
    if (fs.existsSync(ALLIANCE_STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(ALLIANCE_STATE_FILE, 'utf8'));
      _allianceVaults    = d.vaults || {};
      _allianceLastSurge = d.lastSurge || {};
    }
  } catch (e) { console.warn('[Alliance] state load failed:', e.message); }
}
let _allianceStateDirty = false;
function _markAllianceStateDirty() { _allianceStateDirty = true; }
setInterval(() => {
  if (!_allianceStateDirty) return;
  _allianceStateDirty = false;
  try { fs.writeFileSync(ALLIANCE_STATE_FILE, JSON.stringify({ vaults: _allianceVaults, lastSurge: _allianceLastSurge })); }
  catch (e) { console.warn('[Alliance] state save failed:', e.message); }
}, 15000);
loadAllianceState();

// Which alliance does a linked human belong to?
function getAllianceForDiscord(discordId) {
  if (!discordId) return null;
  for (const [key, a] of alliances) if (a.members.includes(discordId)) return { key, ...a };
  return null;
}
// Leader = highest game-rank linked member; ties broken deterministically (lowest discordId).
function getAllianceLeader(alliance) {
  let best = null, bestRank = -1;
  for (const did of alliance.members) {
    const pr = profiles.get(did);
    const r = _RANK_INDEX[(pr && pr.rank) || 'Soldier'] || 0;
    if (r > bestRank || (r === bestRank && (best === null || did < best))) { bestRank = r; best = did; }
  }
  return best;
}

// Vault accrual: every 30s, online allied humans contribute 5% of base passive
// regen to their alliance's vault. Bots and offline players excluded.
setInterval(() => {
  let any = false;
  for (const [, p] of players) {
    if (p.isBot || !p.discordId || !p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    const al = getAllianceForDiscord(p.discordId);
    if (!al) continue;
    _allianceVaults[al.key] = (_allianceVaults[al.key] || 0) + STROKE_REFILL_RATE_PS * VAULT_REGEN_FRAC * (VAULT_ACCRUAL_MS / 1000);
    any = true;
  }
  if (any) _markAllianceStateDirty();
}, VAULT_ACCRUAL_MS);

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
// v88: country colours (numeric country id → '#rrggbb'), sent by client at join.
// Used by the tweet-screenshot renderer to colour owned pixels authentically.
const geoColorsById = {};
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
// v113: conquest emotes — the conqueror of a country can float ONE emoji above its
// flag globally for 5 minutes. Keyed by geo country id → { emoji, countryId, until }.
// The server relays the emote and re-sends still-valid ones to late-joiners; an
// emote is only re-sent while its setter still holds the geo (so a re-conquest
// drops it). The client clears it live on the re-conquest broadcast.
const EMOTE_SET = new Set(['Laugh','Cool','Clown','Kiss','Eyes','Cry','Angry','Death','XEyes','Cross','Tick','Fire']); // v114: pixel-art PNG names (public/emoji/)
const EMOTE_TTL_MS = 5 * 60 * 1000;
const _emoteByGeo = new Map(); // String(geoId) → { emoji, countryId, until }
function _buildActiveEmotes() {
  const now = Date.now();
  const out = [];
  for (const [geoId, e] of _emoteByGeo) {
    if (e.until <= now) { _emoteByGeo.delete(geoId); continue; }
    // Only surface an emote while its setter still holds the geo (drops on re-conquest).
    if (!conqueredSet.has(geoId + ':' + e.countryId)) { _emoteByGeo.delete(geoId); continue; }
    out.push({ geoIdx: geoId, emoji: e.emoji, until: e.until });
  }
  return out;
}
// Once a territory is conquered this game cycle it stays locked even after
// pixel reversals (monsters / nukes can drop it below threshold). Cleared only
// on world reset so the conquest is a lasting consequence.
const permanentlyConquered = new Set(); // geoToId values
// v97e: OUTPOST MODE — a country whose homeland falls while it still holds conquered
// outposts is EXILED (alive, fighting from its outposts) rather than dead. Exiles
// are NOT in permanentlyConquered (so they can still conquer + aren't liquidated);
// they suffer a flat 0.5x regen debuff until they reclaim their homeland. If an
// exile loses all its outposts too, it finally dies (→ permanentlyConquered).
const exiledSet = new Set(); // geoToId values — homeland fallen but surviving via outposts

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

// v95m: NO-OP. Under the "homeland fall = death for the round" model, a conquered
// native NEVER revives — even when its territory is freed/wiped it becomes a neutral
// "Fallen" zone (dead native, no holder, reconquerable by OTHERS), not a playable
// native again. (Was v93u Fix B, which dropped the permanent lock when a geo became
// unheld; that contradicts the new model where fallen zones must stay dead.)
function _clearPermanentIfFree(geo) { /* intentionally no-op (v95m: dead for the round) */ }

// v93q (#3): geos a country currently holds as outposts (conquered elsewhere).
function _countryOutposts(countryId) {
  const id = String(countryId), out = [];
  for (const k of conqueredSet) {            // keys: "geo:conqueror"
    const p = String(k).split(':');
    if (p[1] === id && p[0] !== id) out.push(p[0]);
  }
  return out;
}
// The outpost where this country holds the most pixels — its relocation capital.
function _largestOutpost(countryId) {
  const id = String(countryId);
  let best = null, bestCnt = -1;
  for (const g of _countryOutposts(countryId)) {
    const cnt = (geoClaimCnt[parseInt(g, 10)] && geoClaimCnt[parseInt(g, 10)][id]) || 0;
    if (cnt > bestCnt) { bestCnt = cnt; best = g; }
  }
  return best;
}

// Called (deferred) when a country's homeland is conquered. v95m: the country DIES
// (no more empire-continuity survival). Liquidate everything it held OUTSIDE its
// now-lost homeland:
//   • Alliance partner alive  → hand it all to them (foreign pixels + its conquered
//     outposts, flags and all).
//   • No alliance partner     → CLEAR those pixels (revert to neutral) and drop its
//     outpost conquests → those countries become "Fallen" (dead native, no holder,
//     blank) until someone reconquers them.
// Then migrate/retire the defeated bot.
function _onCountryConquered(conqueredGeoId) {
  conqueredGeoId = String(conqueredGeoId);
  const homeGeoIdx    = parseInt(conqueredGeoId, 10); // numeric ISO stored in geoAtPixel
  const conqueredCidx = getIdx(conqueredGeoId);
  const outposts      = _countryOutposts(conqueredGeoId); // geos this country had conquered

  // Pick a living alliance partner to inherit (strongest by pixels), if any.
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

  // This country's pixels OUTSIDE its homeland (the homeland itself went to the
  // conqueror via finisherFill).
  // v95z: scan claimByPixel DIRECTLY (the source of truth) instead of ownerPixels.
  // ownerPixels can drift from claimByPixel (a partial liquidation once left a dead
  // Guinea-Bissau still "holding" 98% of China), and a full scan guarantees every
  // pixel the board says it owns gets cleared. Death is rare, so the 2M scan is fine.
  const foreign = [];
  for (let i = 0; i < MAP_PX; i++) {
    if (claimByPixel[i] === conqueredCidx && geoAtPixel[i] !== homeGeoIdx) foreign.push(i);
  }

  if (transferTo) {
    // ── Hand the foreign empire to the ally ──
    const newCidx = getIdx(transferTo);
    const changed = [];
    for (const i of foreign) {
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
    if (changed.length) queueDelta(changed);
    // Hand over its conquered outposts (flag ownership) to the ally.
    for (const Y of outposts) {
      conqueredSet.delete(Y + ':' + conqueredGeoId);
      conqueredSet.add(Y + ':' + transferTo);
      broadcast(JSON.stringify({ type: 'reversal', geoIdx: parseInt(Y, 10), countryId: conqueredGeoId, reason: 'inherited' }));
      broadcast(JSON.stringify({ type: 'conquest', geoIdx: parseInt(Y, 10), countryId: transferTo, perm: true }));
    }
    console.log(`[Conquest] ${conqueredGeoId} died — empire (${changed.length}px, ${outposts.length} outposts) → ally ${transferTo}`);
  } else {
    // ── No heir: clear the foreign pixels (revert to neutral) ──
    const changed = [];
    for (const i of foreign) {
      const geo = geoAtPixel[i];
      countryPxCount[conqueredGeoId] = Math.max(0, (countryPxCount[conqueredGeoId] || 1) - 1);
      if (geo >= 0 && geoClaimCnt[geo]?.[conqueredGeoId]) {
        geoClaimCnt[geo][conqueredGeoId] = Math.max(0, geoClaimCnt[geo][conqueredGeoId] - 1);
      }
      updateOwnerIndex(i, conqueredCidx, -1);
      claimByPixel[i] = -1;
      changed.push({ x: i % MAP_W, y: (i / MAP_W) | 0, owner: null });
    }
    if (changed.length) queueDelta(changed);
    // Its conquered outposts become FALLEN (dead native, no holder) — do NOT
    // clear permanentlyConquered, so they stay dead until someone reconquers.
    for (const Y of outposts) {
      conqueredSet.delete(Y + ':' + conqueredGeoId);
      broadcast(JSON.stringify({ type: 'reversal', geoIdx: parseInt(Y, 10), countryId: conqueredGeoId, reason: 'fallen' }));
    }
    // v130: tell EVERY client to wipe this dead country's foreign pixels locally.
    // The per-pixel clears above are viewport-filtered, so an off-screen client would
    // keep showing the dead country's stray pixels until it panned there. This global
    // broadcast guarantees the wipe everywhere immediately.
    broadcast(JSON.stringify({ type: 'country_liquidated', countryId: conqueredGeoId }));
    console.log(`[Conquest] ${conqueredGeoId} died with no heir — ${changed.length}px cleared, ${outposts.length} outposts now Fallen`);
  }

  // v95z: authoritatively reconcile — a dead country owns nothing now. Guarantees
  // the periodic dead-country cleanup terminates even if countryPxCount had drifted
  // positive (else it would re-liquidate every tick).
  countryPxCount[conqueredGeoId] = 0;

  // ── Bot redistribution (v100 Phase 2A) ───────────────────────
  // The fallen country's bot units move to active countries (cap BOT_UNITS_MAX
  // each) so total painting activity is preserved as the field shrinks — the
  // alliance heir gets priority, then the countries that need help most. The
  // fallen bot + its player slot retire (its ticker already no-ops once
  // permanentlyConquered, and units now live on the survivors).
  const fallenBot   = bots.get(conqueredGeoId);
  const unitsToMove = fallenBot ? (fallenBot.units || 1) : 1;
  _redistributeBotUnits(conqueredGeoId, unitsToMove, transferTo || _pickBotMigrationTarget(conqueredGeoId));
  if (fallenBot) bots.delete(conqueredGeoId);
  for (const [pid, p] of players) {
    if (p.isBot && String(p.countryId) === conqueredGeoId) { players.delete(pid); break; }
  }
  broadcastPlayers();
}

// ── Bomb cooldown — anti-spam ────────────────────────────────────
const BOMB_COOLDOWN_MS = 30_000;
const _lastBombAt = new Map(); // discordId or countryId → timestamp

// ── Conquest immunity — anti instant-trade-back ──────────────────
const CONQUEST_IMMUNITY_MS = 60_000;  // v98: 60s invincibility after a flip (was 20s) — client shows countdown under the flag
const _conquestImmunity = new Map(); // geoCountryId → expiresAt

// ── Nuke lockout zones — server authoritative ─────────────────────
// On Nuke detonation, server: (1) clears all pixels in radius (sets to unclaimed),
// (2) creates a 2-minute lockout zone, (3) rejects any paint inside the zone.
const NUKE_LOCKOUT_MS = 5 * 60 * 1000; // v98: 5 minute no-paint lockout (was 2min) — client draws countdown above the zone
const _nukeZones = []; // { cx, cy, radius, expiresAt }

// Run nuke zone expiry every 1s — guarantees timely cleanup even with no traffic
setInterval(() => { _pruneServerNukeZones(); }, 1000);


function _pruneServerNukeZones() {
  const now = Date.now();
  for (let i = _nukeZones.length - 1; i >= 0; i--) {
    const z = _nukeZones[i];
    if (z.expiresAt <= now) {
      // Defensive final clear — guarantees no leftover pixels at expiry
      const changed = clearPixelsInRadius(z.cx, z.cy, z.radius, z.geo);
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
// v97: restrictGeo (optional) = a country id; when set, only pixels inside that
// nation's territory are cleared, so a nuke is contained to the single nation it
// lands on and doesn't bleed into neighbours.
function clearPixelsInRadius(cx, cy, radius, restrictGeo) {
  const r2 = radius * radius;
  const restrict = (restrictGeo !== undefined && restrictGeo !== null && restrictGeo >= 0);
  const changed = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx*dx + dy*dy > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) continue;
      const i = y * MAP_W + x;
      if (restrict && geoAtPixel[i] !== restrictGeo) continue; // v97: stay within one nation

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

// v94b: after a nuke (or any radius clear) wipes a conquered geo's pixels, the
// conqueror may no longer hold it — reverse the conquest so the flag disappears
// (the normal paint/bomb path does this via applyPixels; the nuke path didn't).
function _reverseConquestsForGeo(geo) {
  const total = geoTotal[geo] || 0;
  if (!total) return;
  const gidStr = geoToId(geo);
  for (const key of [...conqueredSet]) {
    const parts = String(key).split(':');
    if (parts[0] !== String(geo) || parts[1] === gidStr) continue;
    const cId = parts[1];
    if (getAllyOwnedCount(geo, cId) / total < reversalThreshold(total)) {
      conqueredSet.delete(key);
      _clearPermanentIfFree(geo);
      broadcast(JSON.stringify({ type: 'reversal', geoIdx: geo, countryId: cId, reason: 'nuke' }));
      try {
        pushTweetDraft({
          type: 'reversal',
          text: tweetForReversal(gidStr, cId),
          dedupeKey: 'reversal:' + gidStr + ':' + cId,
          throttleKey: 'reversal_geo:' + gidStr,
          countries: [gidStr, cId],
        });
      } catch (e) {}
    }
  }
}

// Cleanup stale conquest immunity entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of _conquestImmunity) if (t < now) _conquestImmunity.delete(k);
}, 60_000);

// v94b / v95d: periodic conquest-ownership reconciliation (every 60s).
// Two jobs, both for an already-conquered geo (foreign holder, never native):
//   1. GHOST cleanup (v94b): if NO foreign country holds a single pixel anymore
//      (e.g. a nuke wiped the whole country), reverse the conquest so the flag
//      clears — a conquest normally only re-checks on a paint, so a wiped+idle
//      country would otherwise linger forever.
//   2. OWNER TRANSFER (v95d): conquered land is permanently foreign, but its
//      OWNER follows the dominant holder. If another foreign country now
//      decisively out-holds the recorded owner, transfer the conquest to them
//      and FLOOD-FILL the whole country to the new owner (server state here;
//      every client floods locally via the 'conquest' event). This stops the
//      "Portugal still holds USA at <10% while 70 invaders carve it up" state —
//      ownership consolidates to whoever actually leads.
// Hysteresis (TRANSFER_MARGIN) + a per-geo cooldown + conquest immunity keep the
// colour from flickering: right after a flood the new owner holds ~100%, so no
// one can out-hold them for a long time.
const _lastTransferAt   = new Map();   // geo → ts of last ownership transfer
const TRANSFER_COOLDOWN_MS = 120_000;  // min 2 min between transfers of one geo
const TRANSFER_MARGIN      = 1.25;     // challenger must out-hold owner by 25%+
// Each transfer flood-fills a whole country and broadcasts a 'conquest' that
// makes every client finisher-fill that geo. Cap how many fire per sweep so a
// backlog (e.g. first run after deploy) can't stampede the client paint queue
// (the same overflow that produced the v95b diagonal artifact). Ghost cleanups
// are cheap (no flood) and stay uncapped. Backlog drains over subsequent ticks.
const MAX_TRANSFERS_PER_TICK = 3;
setInterval(() => {
  const now = Date.now();
  let _transfersThisTick = 0;
  const _deadLiquidatedThisTick = new Set(); // v95z: liquidate each dead holder once
  for (const key of [...conqueredSet]) {
    const parts = String(key).split(':');
    if (parts.length !== 2) continue;
    const geo = parseInt(parts[0], 10), curId = parts[1];
    if (!Number.isFinite(geo) || curId === geoToId(geo)) continue;
    const total = geoTotal[geo] || 0;
    if (!(total > 0)) continue;
    const _gid = geoToId(geo);
    // v95z: a DEAD country (homeland permanently conquered) must never hold an
    // outpost. Backstop for the finisherFill/ownerPixels desync that left China
    // owned by an already-conquered Guinea-Bissau: liquidate the dead country's
    // whole empire once (ally heir, else clear to Fallen). After a restart this
    // works because the board restore rebuilds ownerPixels from claimByPixel.
    // v97b: also liquidate LANDLESS phantom holders (geoTotal 0 — Natural Earth
    // artifacts like "Country 167" that conquered a real geo and blocked the real
    // attacker). Treated exactly like a dead holder.
    if (String(curId) !== _gid && (permanentlyConquered.has(String(curId)) || _isLandlessCountry(curId))) {
      if (!_deadLiquidatedThisTick.has(String(curId))) {
        _deadLiquidatedThisTick.add(String(curId));
        console.log('[Conquest] phantom/dead holder', curId, 'still held', _gid, '— liquidating its empire');
        _onCountryConquered(String(curId));
      }
      continue;
    }
    // v95i: BACKSTOP for the live conquest loop, which only re-evaluates a geo
    // when it's painted. Same threshold rule (_evaluateConqueror) so the periodic
    // pass and the live pass agree. (1) If a different country now qualifies →
    // transfer. (2) Else if the holder is wiped to 0 px → ghost-clear the flag.
    const newOwner = _evaluateConqueror(geo, total, true, curId, true); // v98: championOnly
    if (newOwner && String(newOwner) !== String(curId) && !NON_PLAYABLE_IDS.has(String(newOwner))) {
      if (_transfersThisTick >= MAX_TRANSFERS_PER_TICK) continue;      // smooth client flood load
      const imm = _conquestImmunity.get(_gid);
      if (imm && now < imm) continue;                                 // settling after a recent flip
      if (now - (_lastTransferAt.get(geo) || 0) < TRANSFER_COOLDOWN_MS) continue;
      _transfersThisTick++;
      _lastTransferAt.set(geo, now);
      const _conqs = [], _chg = [];
      _conquerGeo(geo, newOwner, _conqs, _chg);   // drops old holder + floods + broadcasts old-flag reversal
      _conqs.forEach(c => broadcast(JSON.stringify({ type: 'conquest', ...c }))); // v98: keep perm + immunityMs
      // clients flood locally via the 'conquest' event — no need to ship the flood pixels
      console.log('[Conquest] periodic transfer:', _gid, curId, '->', newOwner);
    } else if (getAllyOwnedCount(geo, curId) <= 0) {
      conqueredSet.delete(key);
      _clearPermanentIfFree(geo);
      broadcast(JSON.stringify({ type: 'reversal', geoIdx: geo, countryId: curId, reason: 'empty' }));
      console.log('[Conquest] ghost flag cleared:', curId, 'held 0 px of', _gid);
    }
  }
  // v95z: a DEAD country must own ZERO pixels (homeland → conqueror, empire → ally
  // or cleared). Catch remnants the conqueredSet pass misses — e.g. a dead country
  // still holding land with NO conqueredSet entry (a partial-liquidation leftover,
  // the "China conquered:false but 98% Guinea-Bissau" state). Re-liquidate once.
  for (const deadId of permanentlyConquered) {
    if (_deadLiquidatedThisTick.has(String(deadId))) continue;
    if ((countryPxCount[deadId] || 0) > 0) {
      _deadLiquidatedThisTick.add(String(deadId));
      console.log('[Conquest] dead country', deadId, 'still owns', countryPxCount[deadId], 'px — clearing');
      _onCountryConquered(String(deadId));
    }
  }
  // v97e: EXILE resolution. (1) Reclaimed — homeland is native-held again → lift the
  // exile + debuff. (2) Wiped out — homeland still lost AND no outposts left → the
  // exile finally dies (forced re-pick).
  for (const exId of [...exiledSet]) {
    if (_foreignHolderOf(exId) === null) {
      exiledSet.delete(exId);
      console.log('[Exile]', exId, 'reclaimed its homeland — debuff lifted');
      for (const [, pp] of players) {
        if (!pp.isBot && pp.ws && String(pp.countryId) === String(exId)) {
          try { pp.ws.send(JSON.stringify({ type: 'homeland_reclaimed', countryId: String(exId) })); } catch (e) {}
        }
      }
    } else if (_countryOutposts(exId).length === 0) {
      // Lost the homeland AND every outpost → truly dead now.
      exiledSet.delete(exId);
      permanentlyConquered.add(String(exId));
      console.log('[Exile]', exId, 'lost all outposts — final death');
      for (const [, pp] of players) {
        if (!pp.isBot && pp.ws && String(pp.countryId) === String(exId)) {
          const _prof = pp.discordId ? profiles.get(pp.discordId) : null;
          try {
            pp.ws.send(JSON.stringify({
              type: 'your_country_lost', lostCountryId: String(exId), attackerId: null, mercenaryBonus: 50,
              keep: _prof ? { conquests: _prof.conquestsMade || 0, rank: _prof.rank || 'Soldier', points: _prof.points || 0 } : null,
            }));
          } catch (e) {}
        }
      }
      _onCountryConquered(String(exId)); // clear any stray pixels
    }
  }
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
  // v98: world share = the LARGER of native homeland size and CURRENT pixels
  // held anywhere (countryPxCount). A small country that conquers a big empire
  // sheds its underdog buff as it grows (operator request: adjust with total
  // pixels, re-evaluated as conquests land); a big country that gets wiped
  // stays Goliath (max() means you can't farm the David buff by losing land).
  // Recomputed live — countryPxCount moves with every conquest/clear, and the
  // david snapshot rebroadcasts ~5s. Replaces the v97e leader tax entirely.
  if (totalLandPxCached <= 0) return 0;
  const geoIdx = parseInt(countryId, 10);
  const territory = geoTotal[geoIdx] || 0;
  const held = countryPxCount[String(countryId)] || 0;
  return Math.max(territory, held) / totalLandPxCached;
}
// v97e: David↔Goliath is now a CONTINUOUS curve (was 5 hard tiers) with a wider
// spread — tiny homelands get up to 7x, fading to 1x at >=5% world share. share is
// STATIC (homeland size), so this is the inherent-underdog buff; the dynamic
// balancing is the leader tax below (based on CURRENT holdings).
const DAVID_FLAT_SHARE = 0.05; // >= this world share → no David bonus
const DAVID_MAX = 7;
function _davidMult(share) {
  const t = Math.max(0, Math.min(1, share / DAVID_FLAT_SHARE)); // 0 (tiny) .. 1 (big)
  return 1 + (DAVID_MAX - 1) * Math.pow(1 - t, 3);              // 7 .. 1
}
function getRegenMultiplier(countryId) { return _davidMult(getWorldShare(countryId)); }

// v97e: alliance regen bonus, UNDERDOG-SCALED + additive. A small allied member
// gets up to +2; a large allied member only +0.5 (so alliances help the weak gang
// up without supercharging a dominant member). 0 if not in an alliance.
function _allianceRegenAdd(countryId) {
  const ally = getAllianceForCountry(countryId);
  if (!ally) return 0;
  const t = Math.max(0, Math.min(1, getWorldShare(countryId) / DAVID_FLAT_SHARE));
  return 0.5 + 1.5 * (1 - t); // 2.0 (tiny) .. 0.5 (>=5%)
}

// v98: the v97e leader tax is REMOVED — the David curve itself is now dynamic
// (getWorldShare uses current holdings), which is the same rubber-band without
// a second knob fighting the first.

// v114: regen is an absolute RATE in pixels/SECOND (not a multiplier). Baseline
// 0.5px/s, additive SIZE (David) + ENCIRCLE bonuses, hard cap 4px/s. Mirrors the
// client getRegenMult. Used for bot bucket regen. Alliance/leader-tax dropped.
const REGEN_BASE_PXS = 0.5;
const REGEN_CAP_PXS  = 4;
function _serverRegen(countryId) {
  const enc    = getEncircleMultiplier(countryId);
  const encAdd = enc > 1 ? Math.min(2, (enc - 2) * 0.5) : 0; // +0.5 .. +2 px/s
  const sdAdd  = _suddenDeath ? 1.5 : 0;
  if (exiledSet.has(String(countryId))) {
    return Math.max(REGEN_BASE_PXS, Math.min(REGEN_CAP_PXS, REGEN_BASE_PXS + encAdd + sdAdd));
  }
  const david   = _davidMult(getWorldShare(countryId)); // 1 (Goliath) .. 7 (tiny David)
  const sizeAdd = Math.max(0, david - 1) * ((REGEN_CAP_PXS - REGEN_BASE_PXS) / 6);
  return Math.max(REGEN_BASE_PXS, Math.min(REGEN_CAP_PXS, REGEN_BASE_PXS + sizeAdd + encAdd + sdAdd));
}

// Build a snapshot of world shares + multipliers for the client to display.
// Sent every ~5s as part of the players broadcast.
function buildDavidSnapshot() {
  if (totalLandPxCached <= 0) recomputeTotalLand();
  const out = {};
  for (const geoIdx of Object.keys(geoTotal)) {
    const cid   = String(geoIdx);
    const share = getWorldShare(cid); // v98: dynamic (max of homeland, current holdings)
    const mult  = getRegenMultiplier(cid);
    out[cid] = { share, mult };
    // v97e: extra fields so the client can mirror the exact regen formula.
    const allyAdd = _allianceRegenAdd(cid);
    if (allyAdd > 0) out[cid].allyAdd = allyAdd;
    if (exiledSet.has(cid)) out[cid].exiled = true;
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

const countryNames   = {}; // countryId → display name (v98b: loaded from TopoJSON at boot)

// v98b: country names come from countries-10m.json ON THE SERVER, at boot.
// Previously they were wiped + wholesale replaced by whatever the next joining
// client sent in `geoNames` — which (a) left every name blank between a restart
// and the first join, so anything generated in that window (news-scrape tweets,
// rivalry lines) fell back to "Country 710" [= South Africa], and (b) let ANY
// client rename every country in tweets/Discord (content injection into the
// public X account). Mirrors the client's v97k parse exactly: id = parsed
// numeric id, no-id features get synthetic 9000+index, unnamed features fall
// back to "Disputed Territory".
// v115b: rough size proxy for a geometry = total number of arc references (a
// mainland country's MultiPolygon has far more than a tiny island's single Polygon).
function _arcRefCount(arcs) {
  if (!Array.isArray(arcs)) return 0;
  let c = 0;
  for (const a of arcs) c += Array.isArray(a) ? _arcRefCount(a) : 1;
  return c;
}
function loadCountryNamesFromDisk() {
  try {
    const topo = JSON.parse(fs.readFileSync(path.join(__dirname, 'countries-10m.json'), 'utf8'));
    const geoms = topo && topo.objects && topo.objects.countries && topo.objects.countries.geometries;
    if (!Array.isArray(geoms)) { console.warn('[Names] countries-10m.json: unexpected shape'); return; }
    let n = 0;
    // v115b: multiple geometries can share an ISO id (e.g. id 036 = both "Australia"
    // and the tiny "Ashmore and Cartier Is." territory). Last-write-wins used to let
    // the tiny one overwrite the real country, so notifications said "Ashmore and
    // Cartier Is." instead of "Australia". Keep the name of the LARGEST feature per id.
    const _nameWeight = {};
    geoms.forEach((g, gi) => {
      const s = String(g.id ?? '');
      const parsed = parseInt(s, 10);
      let id = (parsed >= 0 && String(parsed)) ? String(parsed) : s;
      if (!id) id = String(9000 + gi); // v97k synthetic ids — keep in sync with the client
      const name = (g.properties && g.properties.name) || 'Disputed Territory';
      const w = _arcRefCount(g.arcs);
      if (countryNames[id] === undefined || w > (_nameWeight[id] || 0)) {
        countryNames[id] = name;
        _nameWeight[id] = w;
        n++;
      }
    });
    console.log('[Names] loaded ' + n + ' country names from countries-10m.json (largest-feature-wins)');
  } catch (e) {
    console.warn('[Names] failed to load countries-10m.json:', e.message);
  }
}
loadCountryNamesFromDisk();
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

// ── v92: binary delta encoder ─────────────────────────────────────
// Layout: [uint8 tag=1][u32le seq][ repeating 6-byte records: x u16le, y u16le, owner u16le ]
// owner sentinel 0xFFFF = cleared pixel (JSON had owner:null). Country IDs fit
// u16 (max ISO numeric 894); x<=2047, y<=1023 also fit. ~6 bytes/pixel vs ~30
// in JSON, and the client skips JSON.parse entirely on the hot path.
// v130 (sync B): each frame carries a GLOBAL monotonic seq. Every client receives
// exactly one frame per broadcast tick (windowed clients with no in-view change get
// a 0-record keepalive), so the per-client seq stream is contiguous — a jump means a
// genuinely dropped frame and the client requests a region re-snapshot.
const DELTA_CLEAR_OWNER = 0xFFFF;
function encodeDelta(pixels, seq) {
  const buf = Buffer.allocUnsafe(5 + pixels.length * 6);
  buf.writeUInt8(1, 0); // message-type tag: 1 = binary delta
  buf.writeUInt32LE((seq >>> 0), 1); // v130: global broadcast sequence number
  let off = 5;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    buf.writeUInt16LE(p.x & 0xFFFF, off); off += 2;
    buf.writeUInt16LE(p.y & 0xFFFF, off); off += 2;
    // owner is a country-ID string|number, or null for a clear
    let o = DELTA_CLEAR_OWNER;
    if (p.owner !== null && p.owner !== undefined) {
      const n = typeof p.owner === 'number' ? p.owner : parseInt(p.owner, 10);
      o = (Number.isFinite(n) && n >= 0 && n < DELTA_CLEAR_OWNER) ? n : DELTA_CLEAR_OWNER;
    }
    buf.writeUInt16LE(o, off); off += 2;
  }
  return buf;
}

// v92p: region snapshot — current ownership of a rect, sent to a client that just
// panned/zoomed into a (possibly stale) area while under viewport filtering.
// Layout: [uint8 tag=2][minX,minY,maxX,maxY u16le][ x,y,ownerId u16le ]* (owned only).
// The client reconciles: set these owners, clear any pixel it still shows as
// foreign that isn't in this list.
function encodeRegionSnapshot(minX, minY, maxX, maxY) {
  const owned = [];
  for (let y = minY; y <= maxY; y++) {
    const base = y * MAP_W;
    for (let x = minX; x <= maxX; x++) {
      const idx = claimByPixel[base + x];
      if (idx >= 0) {
        const id = idxToId[idx];
        if (id !== undefined) {
          const n = typeof id === 'number' ? id : parseInt(id, 10);
          if (Number.isFinite(n) && n >= 0 && n < DELTA_CLEAR_OWNER) owned.push(x, y, n);
        }
      }
    }
  }
  const buf = Buffer.allocUnsafe(9 + (owned.length / 3) * 6);
  buf.writeUInt8(2, 0);
  buf.writeUInt16LE(minX, 1); buf.writeUInt16LE(minY, 3);
  buf.writeUInt16LE(maxX, 5); buf.writeUInt16LE(maxY, 7);
  let off = 9;
  for (let i = 0; i < owned.length; i += 3) {
    buf.writeUInt16LE(owned[i], off);     off += 2;
    buf.writeUInt16LE(owned[i + 1], off); off += 2;
    buf.writeUInt16LE(owned[i + 2], off); off += 2;
  }
  return buf;
}
function sendRegionSnapshot(p, minX, minY, maxX, maxY) {
  if (!p || !p.ws || p.ws.readyState !== WebSocket.OPEN) return;
  try { p.ws.send(encodeRegionSnapshot(minX, minY, maxX, maxY)); } catch (e) {}
}

// v92s: binary initial-snapshot runs. Replaces the big JSON `state.runs` array in
// the welcome message (~3x smaller, no JSON.parse of a huge array on connect).
// Layout: [u8 tag=3][u32 count][ s u32le, l u32le, o u16le ]*  (o 0xFFFF = skip).
function encodeSnapshotRuns(runs) {
  const buf = Buffer.allocUnsafe(5 + runs.length * 10);
  buf.writeUInt8(3, 0);
  buf.writeUInt32LE(runs.length, 1);
  let off = 5;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    buf.writeUInt32LE(r.s >>> 0, off); off += 4;
    buf.writeUInt32LE(r.l >>> 0, off); off += 4;
    const n = typeof r.o === 'number' ? r.o : parseInt(r.o, 10);
    buf.writeUInt16LE((Number.isFinite(n) && n >= 0 && n < 0xFFFF) ? n : 0xFFFF, off); off += 2;
  }
  return buf;
}

let _deltaStatLast = 0, _deltaStatBytes = 0, _deltaStatPx = 0, _deltaStatCount = 0;
let _deltaSeq = 0; // v130 (sync B): global monotonic broadcast sequence number
function flushDelta() {
  deltaTimer = null;
  const pending = pendingDelta;
  if (!pending.length) return;
  pendingDelta = [];
  const pxCount = pending.length;
  // v130 (sync B): bump the global broadcast seq once per flushed tick.
  const seq = (_deltaSeq = (_deltaSeq + 1) >>> 0);
  // v92: binary delta. Buffer.send sets the WS frame opcode to binary; the
  // client branches on ArrayBuffer vs string to route here vs the JSON path.
  const fullBuf = encodeDelta(pending, seq);

  // v92p: per-client viewport filtering. "Full" clients (or all clients when the
  // filter is disabled) get the shared buffer; windowed clients get only the
  // deltas inside their rect. v130: windowed clients with NO in-view change still
  // get a 0-record keepalive so their seq stream stays contiguous (no false gaps).
  let nFull = 0, nWindowed = 0;
  if (!VIEWPORT_FILTER_ENABLED) {
    broadcast(fullBuf);
  } else {
    let emptyBuf = null; // lazily-built shared keepalive (tag+seq, no records)
    for (const [, p] of players) {
      if (p.isBot || !p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
      const vp = p.viewport;
      if (!vp) { p.ws.send(fullBuf); nFull++; continue; }
      nWindowed++;
      let sub = null;
      for (let i = 0; i < pending.length; i++) {
        const px = pending[i];
        if (px.x >= vp.minX && px.x <= vp.maxX && px.y >= vp.minY && px.y <= vp.maxY) {
          (sub || (sub = [])).push(px);
        }
      }
      if (sub) p.ws.send(encodeDelta(sub, seq));
      else { if (!emptyBuf) emptyBuf = encodeDelta([], seq); p.ws.send(emptyBuf); }
    }
  }
  // v78-debug: summary every 10s to confirm deltas are flowing
  _deltaStatBytes += fullBuf.length;
  _deltaStatPx    += pxCount;
  _deltaStatCount += 1;
  const now = Date.now();
  if (now - _deltaStatLast > 10000) {
    if (_deltaStatLast > 0) {
      console.log('[Delta] ' + _deltaStatCount + ' broadcasts in 10s, ' + _deltaStatPx + ' pixels, ' +
        (_deltaStatBytes/1024).toFixed(1) + ' KB full-equiv; clients full=' + nFull + ' windowed=' + nWindowed);
    }
    _deltaStatLast = now;
    _deltaStatBytes = 0; _deltaStatPx = 0; _deltaStatCount = 0;
  }
}

// broadcast accepts a string (JSON) OR a Buffer (binary delta). ws.send handles
// both; Buffers are framed as binary, strings as text.
function broadcast(msg, excludePid = -1) {
  for (const [pid, p] of players) {
    if (pid === excludePid || p.isBot) continue;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function broadcastPlayers() {
  _rebuildHumansByCountry(); // v100 (Phase 2A): keep per-country human counts fresh
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
    permanentlyConquered: [...permanentlyConquered], // v95m: dead natives → client "Fallen" rendering
    sieged: [...siegedSet].map(g => geoToId(g)), // v92w: current sieges for late-joiners
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
    // v93g: Allied Surge gives +50% refill while active (O(1) lookup; surge map
    // is tiny and only populated during the 5-min window).
    const su = _surgeUntil.get(pid);
    const rate = (su && now < su) ? STROKE_REFILL_RATE_PS * SURGE_REFILL_MULT : STROKE_REFILL_RATE_PS;
    const refill = (elapsedMs / 1000) * rate;
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

// v97b: a country with NO homeland land (geoTotal 0) is a Natural Earth artifact
// (unnamed disputed/buffer features, e.g. "Country 167"). It must never act as a
// player: it can't be selected as a conqueror, and any real geo it "holds" gets
// liquidated like a dead country. Without this, a landless phantom that had
// conquered New Zealand stayed its majority holder and blocked the real attacker
// from ever taking it.
function _isLandlessCountry(id) { return !((geoTotal[String(id)] || 0) > 0); }

// v95i: the foreign country currently holding a conquered geo (or null). One
// holder per geo; transfers keep it that way.
function _foreignHolderOf(geo) {
  const gid = geoToId(geo);
  for (const k of conqueredSet) {
    const p = String(k).split(':');
    if (p[0] === String(geo) && p[1] !== gid) return p[1];
  }
  return null;
}

// v95i: evaluate who (if anyone) should own this geo right now. Used for BOTH a
// virgin fall and the re-conquest/transfer of an already-conquered country, so a
// conquered country behaves like a normal one. Two ways to win (operator design):
//   (a) CHAMPION — a single country (+allies) reaches the size-scaled threshold
//       (~70-75%; + empire-defense bonus unless dropped for conquered geos).
//   (b) CONTESTED — foreigners collectively dominate the PAINTED area
//       (>= CONTEST_MAJORITY, ~85%) → the single LARGEST holder (raw pixels) takes
//       it, even below the champion bar.
// `excludeId` (the current holder) is skipped for the champion test so an
// alliance that already holds the geo doesn't perpetually "win" the evaluation
// and block a new raw-pixel leader from taking it via the contested path.
// Returns the winner's country id, or null.
// v98: `championOnly` — for RE-conquest of an already-held geo. The contested
// path (b) was trivially satisfied there (the dead native holds ~0, so
// foreigners always dominate the painted area) → any >50% raw holder flipped
// it. With championOnly a challenger must reach the SAME size-scaled threshold
// (~70-75%) as a virgin conquest.
function _evaluateConqueror(geo, total, dropEmpireBonus, excludeId, championOnly) {
  if (!total) return null;
  const _geoId = geoToId(geo);
  const claims = geoClaimCnt[geo] || {};
  const _eb = dropEmpireBonus ? 0 : empireDefenseBonus(_geoId);
  const effThresh = Math.min(EMPIRE_DEF_CEIL, conquestThreshold(total) + _eb);
  // (a) champion — strongest single country (ally-combined), not the current holder.
  let champId = null, champOwned = 0;
  for (const cId in claims) {
    if (cId === _geoId) continue;
    if (excludeId != null && String(cId) === String(excludeId)) continue;
    if (permanentlyConquered.has(String(cId))) continue; // v95z: dead countries can't conquer
    if (_isLandlessCountry(cId)) continue; // v97b: landless phantom features can't conquer
    const o = getAllyOwnedCount(geo, cId);
    if (o > champOwned) { champOwned = o; champId = cId; }
  }
  if (champId && champOwned / total >= effThresh) return champId;
  if (championOnly) return null; // v98: re-conquest needs the full champion bar
  // (b) contested — largest RAW holder when foreigners dominate the painted area.
  const nativeOwned = claims[_geoId] || 0;
  let topId = null, topCnt = 0, foreignSum = 0;
  for (const [cId, cnt] of Object.entries(claims)) {
    if (cId === _geoId || cnt <= 0) continue;
    if (permanentlyConquered.has(String(cId))) continue; // v95z: dead countries can't conquer
    if (_isLandlessCountry(cId)) continue; // v97b: landless phantom features can't conquer
    foreignSum += cnt;
    if (cnt > topCnt) { topCnt = cnt; topId = cId; }
  }
  const painted = foreignSum + nativeOwned;
  // v95n: painted-relative leniency only for genuinely large countries; everyone
  // else must reach the total-based bar (decisiveCoverage) so a sparsely-painted
  // small country can't be taken at ~45%.
  const contestedMajority = total > CONTEST_LARGE_MIN && painted > 0 && (painted / total) >= CONTEST_FLOOR && (foreignSum / painted) >= Math.min(0.98, CONTEST_MAJORITY + _eb);
  const decisiveCoverage  = (foreignSum / total) >= Math.min(0.98, CONTEST_TOTAL_FRAC + _eb);
  if (topId && topCnt > nativeOwned && (contestedMajority || decisiveCoverage)) return topId;
  return null;
}

// ── v91: shared conquest performer (definition was lost in the v91 edit;
// restored in v91a). Marks the geo conquered by conquerorId, runs finisherFill,
// fires war event + player notifications + tweet draft. Pushes into the
// caller's conquests[] and changed[] arrays.
// v95i: also handles TRANSFERS — if the geo is already held by a different
// foreign country, it drops that holder, floods to the new one, and skips the
// native-death + Discord/tweet reporting (the native already fell on the first
// conquest, and we don't want transfer spam).
function _conquerGeo(geo, conquerorId, conquests, changed) {
  const geoId = geoToId(geo);
  // v95i: TRANSFER detection — geo already held by a different foreign country?
  let _priorHolder = null;
  for (const k of conqueredSet) {
    const p = String(k).split(':');
    if (p[0] === String(geo) && p[1] !== geoId && p[1] !== String(conquerorId)) { _priorHolder = p[1]; break; }
  }
  const _isTransfer = _priorHolder !== null;
  _conquestImmunity.set(geoId, Date.now() + CONQUEST_IMMUNITY_MS);
  if (_isTransfer) {
    // Drop the old owner + tell clients to erase its flag; the new owner's
    // 'conquest' (pushed below) re-flags + floods.
    conqueredSet.delete(geo + ':' + _priorHolder);
    broadcast(JSON.stringify({ type: 'reversal', geoIdx: geo, countryId: _priorHolder, reason: 'transfer' }));
  }
  conqueredSet.add(geo + ':' + conquerorId);
  const _isSelf   = String(conquerorId) === String(geoId);
  // v95m: empire-continuity (survivor/relocation) ROLLED BACK. A homeland fall is
  // now ALWAYS death — no surviving via outposts. A FRESH KILL = a living country's
  // homeland falling for the first time (not a transfer between invaders, not a
  // re-conquest of an already-dead "Fallen" zone, not a self-conquest).
  const _alreadyDead = permanentlyConquered.has(geoId);
  const _isExile     = exiledSet.has(geoId); // already exiled (homeland re-lost)
  const _freshKill = !_isTransfer && !_alreadyDead && !_isSelf;
  // v97e: OUTPOST MODE — a fresh homeland fall is EXILE (survive via outposts) if the
  // country still holds any conquered outpost; otherwise it's a true DEATH.
  let _exiledNow = false;
  if (_freshKill) {
    if (siegedSet.has(geo)) {        // a fallen homeland leaves the siege system
      siegedSet.delete(geo);
      broadcast(JSON.stringify({ type: 'siege', countryId: geoId, active: false }));
    }
    if (!_isExile && _countryOutposts(geoId).length > 0) {
      // EXILE: alive via outposts, -50% regen until the homeland is reclaimed.
      // NOT added to permanentlyConquered → can still conquer + isn't liquidated.
      _exiledNow = true;
      exiledSet.add(geoId);
    } else {
      // DEATH: no outposts to retreat to (or an exile whose homeland re-fell).
      permanentlyConquered.add(geoId);
      exiledSet.delete(geoId);
      setTimeout(() => _onCountryConquered(geoId), 0); // liquidate its empire (ally or clear)
    }
  }
  // perm flag → client marks the geo's native as dead (drives "Fallen" rendering).
  // An exile is NOT dead, so perm stays false (homeland is a normal conquest).
  conquests.push({ geoIdx: geo, countryId: conquerorId, perm: permanentlyConquered.has(geoId),
                   immunityMs: CONQUEST_IMMUNITY_MS }); // v98: client shows shield countdown under the flag
  changed.push(...finisherFill(geo, conquerorId));
  // Only a FRESH kill notifies the falling country's players + Discord. Transfers,
  // self-conquest, and re-takes of already-fallen zones are silent (anti-spam).
  if (!_freshKill) return;

  // Notify the falling country's players: exile (keep playing, debuffed) or death
  // (forced re-pick + revenge bonus).
  for (const [, pp] of players) {
    if (pp.isBot || !pp.ws || String(pp.countryId) !== String(geoId)) continue;
    const _prof = pp.discordId ? profiles.get(pp.discordId) : null;
    if (_prof) _prof.countriesLost = (_prof.countriesLost || 0) + 1;
    try {
      if (_exiledNow) {
        // v97e: homeland fell but you survive via outposts.
        pp.ws.send(JSON.stringify({ type: 'homeland_exiled', lostCountryId: geoId, attackerId: conquerorId }));
      } else {
        pp.ws.send(JSON.stringify({
          type: 'your_country_lost', lostCountryId: geoId, attackerId: conquerorId,
          mercenaryBonus: 50,
          keep: _prof ? { conquests: _prof.conquestsMade || 0, rank: _prof.rank || 'Soldier', points: _prof.points || 0 } : null,
        }));
      }
    } catch (e) {}
  }
  // v92f: only REPORT (Discord war event + screenshot + tweet) conquests that
  // involve a notable country. With the v92a lowered fall threshold, conquests
  // now fire in continuous waves — reporting them all (a) flooded the bot's
  // 5-per-batch relay so notable conquests like USA→Denmark got truncated, and
  // (b) filled the feed with tiny flip-floppy islands (Puerto Rico↔Dominican
  // Republic) that re-conquer constantly. The conquest itself still happens for
  // every country (state above is unconditional); only the *announcement* is
  // gated. ~90% volume cut → notable conquests now reliably get through.
  if (!isNotableCountry(conquerorId) && !isNotableCountry(geoId)) return;
  const _sassyConq = (_geoContextSassy(conquerorId, geoId) || _pickSassy(SASS_CONQUEST)({
    a: _countryName(conquerorId),
    d: _countryName(geoId),
    held: Array.from(conqueredSet).filter(k => String(k).split(':')[1] === String(conquerorId)).length,
  })) + _gdpTag(geoId); // v114: conquered country's GDP in the Discord war report too
  const _conqShot = makeCountryShot(geoId, conquerorId); // v88 screenshot, v92m conqueror flag
  emitBotEvent({
    type:        'war_conquest',
    tier:        2,
    attackerId:  conquerorId,
    defenderId:  geoId,
    timestamp:   Date.now(),
    sassyText:   _sassyConq,
    imageUrl:    _conqShot || undefined,
  });
  try {
    pushTweetDraft({
      type:        'conquest',
      text:        tweetForConquest(conquerorId, geoId),
      dedupeKey:   'conquest:' + conquerorId + ':' + geoId,
      throttleKey: 'conquest_attacker:' + conquerorId,
      countries:   [conquerorId, geoId],
      imageUrl:    _conqShot || undefined,
    });
  } catch (e) { console.warn('[Tweets] conquest draft failed:', e.message); }
}

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
    const _geoId = geoToId(geo);
    // v92q: once a country has FALLEN it is permanently out of the war machinery
    // for the rest of the round — no re-conquest, no reversal/"liberation", and no
    // siege start/break. This ends the take/retake loop and the nonsensical
    // "North Korea regained enough ground to break the siege" post (a conquered
    // country can't break a siege — what really happened was its foreign occupiers
    // fragmenting so no single one held >50%). Its bot is already stopped and its
    // players are forced to re-pick, so the territory simply belongs to its
    // conqueror until world reset. (CONQUEST_IMMUNITY only paused this for 20s,
    // after which the churn resumed — this makes it final.)
    // Conquest immunity — don't allow flips within IMMUNITY_MS of last (re)conquest
    const immuneUntil = _conquestImmunity.get(_geoId);
    if (immuneUntil && Date.now() < immuneUntil) {
      continue; // territory is still settling after a recent flip
    }
    // v95i: ALREADY-CONQUERED country — treat its TERRITORY like a normal country:
    // invaders chip away and it TRANSFERS to a new dominant holder (champion >=
    // threshold OR contested ~85% painted → largest raw holder). The dead native
    // never reclaims, the empire-defense bonus is dropped (operator decision), and
    // it skips the virgin paths + native reversal below. Replaces the old v92q
    // permanent lock (which froze ownership forever).
    const _curHolder = _foreignHolderOf(geo);
    if (_curHolder !== null) {
      const _newOwner = _evaluateConqueror(geo, total, true, _curHolder, true); // v98: championOnly
      if (_newOwner && String(_newOwner) !== String(_curHolder)) {
        _conquerGeo(geo, _newOwner, conquests, changed); // transfer (drops old holder inside)
      }
      continue;
    }
    // v92h FIX: evaluate conquest for the STRONGEST FOREIGN CLAIMANT of this geo,
    // not just the painter (countries used to sit un-conquered at e.g. 81% — the
    // Kosovo/Serbia bug). The empire-defense bonus applies on a VIRGIN homeland.
    let champId = null, champOwned = 0;
    const _claims = geoClaimCnt[geo] || {};
    for (const cId in _claims) {
      if (cId === _geoId) continue;                 // skip native — can't self-conquer
      if (permanentlyConquered.has(String(cId))) continue; // v95z: dead countries can't conquer
      if (_isLandlessCountry(cId)) continue; // v97b: landless phantom features can't conquer
      const o = getAllyOwnedCount(geo, cId);        // combined alliance credit
      if (o > champOwned) { champOwned = o; champId = cId; }
    }
    const key = champId != null ? (geo + ':' + champId) : null;
    // v93p (#1): effective threshold = base size-scaled threshold + the
    // defender's empire-defense bonus (more outposts → harder homeland).
    const _effThresh = Math.min(EMPIRE_DEF_CEIL, conquestThreshold(total) + empireDefenseBonus(_geoId));
    if (champId != null && !conqueredSet.has(key) && champOwned / total >= _effThresh) {
      _conquerGeo(geo, champId, conquests, changed);
    } else {
      // v93h: contested-territory fall vs PAINTED land (big countries have huge
      // unpainted interiors) — falls to the largest foreign holder when foreigners
      // dominate the painted area AND out-hold the native.
      const claims = geoClaimCnt[geo] || {};
      const nativeOwned = claims[_geoId] || 0;
      let topId = null, topCnt = 0, foreignSum = 0;
      for (const [cId, cnt] of Object.entries(claims)) {
        if (cId === _geoId || cnt <= 0) continue;  // skip native
        if (permanentlyConquered.has(String(cId))) continue; // v95z: dead countries can't conquer
        if (_isLandlessCountry(cId)) continue; // v97b: landless phantom features can't conquer
        foreignSum += cnt;
        if (cnt > topCnt) { topCnt = cnt; topId = cId; }
      }
      const painted = foreignSum + nativeOwned;
      const _eb = empireDefenseBonus(_geoId);
      // v95n: painted-relative leniency only for genuinely large countries.
      const contestedMajority = total > CONTEST_LARGE_MIN && painted > 0 && (painted / total) >= CONTEST_FLOOR && (foreignSum / painted) >= Math.min(0.98, CONTEST_MAJORITY + _eb);
      const decisiveCoverage  = (foreignSum / total) >= Math.min(0.98, CONTEST_TOTAL_FRAC + _eb);
      if (topId && topCnt > nativeOwned && !conqueredSet.has(geo + ':' + topId) && (contestedMajority || decisiveCoverage)) {
        _conquerGeo(geo, topId, conquests, changed);
      }
    }
    for (const [cId, cnt] of Object.entries(geoClaimCnt[geo] || {})) {
      const rk = geo + ':' + cId;
      // v64: use combined alliance count for reversal — conquest only breaks when
      // the whole alliance drops below the threshold, not just one member.
      if (cId !== countryId && conqueredSet.has(rk) && getAllyOwnedCount(geo, cId) / total < reversalThreshold(total)) {
        conqueredSet.delete(rk);
        _clearPermanentIfFree(geo); // v93u (Fix B): unlock if no longer held
        reversals.push({ geoIdx: geo, countryId: cId });
        // Queue a tweet draft for the reversal (liberation)
        try {
          pushTweetDraft({
            type:        'reversal',
            text:        tweetForReversal(geoToId(geo), cId),
            dedupeKey:   'reversal:' + geoToId(geo) + ':' + cId,
            throttleKey: 'reversal_geo:' + geoToId(geo),
            countries:   [geoToId(geo), cId], // v84
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
const ENCIRCLE_MIN_PX      = 15;    // v97j: lowered 50→15 — reward small encirclements too
const ENCIRCLE_MAX_PX      = 10000; // v98: 500→10000, matches client MAX_FILL_PX (500 caused top-slice half-fills)
const ENCIRCLE_BBOX_PAD    = 160;   // v98: padding around the STROKE bbox (was 8 around own-pixel bbox)
const ENCIRCLE_BBOX_PAD_MIN = 8;    // v98: fallback pad when the generous pad blows the area cap
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

// v98 REWRITE — fixes three field bugs:
//  (a) RETRIGGER: the old pass counted EVERY non-own pixel sealed inside the
//      player's cumulative walls, so any stroke-end re-detected old pockets
//      (bots chipping your interior re-armed it constantly) and reset the 60s
//      timer. Now we run a second BFS with the new stroke pixels OPENED
//      (changedSet = pixels this stroke actually flipped to own) and award only
//      regions that are sealed WITH the stroke but reachable WITHOUT it — i.e.
//      regions this stroke genuinely closed. Repainting your own wall flips
//      nothing (changedSet empty) so it can never re-fire.
//  (b) NO-TRIGGER: the bbox came from ALL own pixels in the geo — a player with
//      scattered pixels across a big country blew ENCIRCLE_MAX_BBOX_AREA and
//      detection silently bailed. The bbox now comes from the STROKE (+pad).
//  (c) HALF-FILL: enclosed collection truncated at 500px in row-major order
//      (top slice only) and only the single largest geo was awarded (a circle
//      spanning a border filled one side). Cap is now 10k = client MAX_FILL_PX
//      (over-cap regions are skipped whole, never truncated) and ALL geos
//      inside the ring are collected in one pass.
// changedSet: Set of pixel indices this stroke actually flipped to own
// (accumulated in the 'stroke' handler, cleared at stroke-end).
// v128: feat-index Set of the countries allied to `countryId` (same alliance),
// used as encircle walls so a ring can be closed against a teammate's border.
// Returns null when the country has no alliance.
function _alliedIdxSet(countryId){
  const cid = String(countryId);
  for (const [, a] of alliances){
    if (a.countries && a.countries.map(String).includes(cid)){
      const s = new Set();
      for (const c of a.countries){ if (String(c) !== cid){ const ai = getIdx(c); if (ai >= 0) s.add(ai); } }
      return s.size ? s : null;
    }
  }
  return null;
}
function detectEncirclement(strokePixels, countryId, changedSet) {
  if (!strokePixels || strokePixels.length < 1) return null;
  const cidx = getIdx(countryId);

  // 1. Stroke bounding box + Bresenham-interpolated stroke wall (seals
  //    fast-drag gaps; interpolated pixels are NOT in claimByPixel but must
  //    block the pass-A BFS).
  const strokeWallMap = new Set();
  let sMinX = MAP_W, sMinY = MAP_H, sMaxX = 0, sMaxY = 0;
  for (let s = 0; s < strokePixels.length; s++) {
    const p = strokePixels[s];
    if (p.x < 0 || p.x >= MAP_W || p.y < 0 || p.y >= MAP_H) continue;
    strokeWallMap.add(p.y * MAP_W + p.x);
    if (p.x < sMinX) sMinX = p.x; if (p.x > sMaxX) sMaxX = p.x;
    if (p.y < sMinY) sMinY = p.y; if (p.y > sMaxY) sMaxY = p.y;
    if (s > 0) {
      const prev = strokePixels[s - 1];
      const dx = Math.abs(p.x - prev.x), dy = Math.abs(p.y - prev.y);
      if ((dx > 1 || dy > 1) && dx <= 30 && dy <= 30) {
        for (const pt of _bresenhamLine(prev.x, prev.y, p.x, p.y))
          strokeWallMap.add(pt.y * MAP_W + pt.x);
      }
    }
  }
  if (sMinX > sMaxX) return null; // no in-bounds stroke pixels

  // 2. Pad the stroke bbox. Generous pad covers multi-stroke rings whose final
  //    closing stroke is small; fall back to a tight pad before giving up.
  let pad = ENCIRCLE_BBOX_PAD;
  let minX, minY, maxX, maxY, bw, bh;
  for (;;) {
    minX = Math.max(0, sMinX - pad); minY = Math.max(0, sMinY - pad);
    maxX = Math.min(MAP_W - 1, sMaxX + pad); maxY = Math.min(MAP_H - 1, sMaxY + pad);
    bw = maxX - minX + 1; bh = maxY - minY + 1;
    if (bw * bh <= ENCIRCLE_MAX_BBOX_AREA) break;
    if (pad <= ENCIRCLE_BBOX_PAD_MIN) return null; // stroke itself too large
    pad = ENCIRCLE_BBOX_PAD_MIN;
  }

  // v128: allied (friendly) countries' pixels also seal the encirclement, so a
  // player can close a ring against a teammate's border. Mirrors the client's
  // _encircleAllyFi. Built once per call (the BFS calls the predicate per-cell).
  const _allyIdx = _alliedIdxSet(countryId);
  const _isAlly = _allyIdx ? (gi) => _allyIdx.has(claimByPixel[gi]) : () => false;

  // 3. Two wall predicates.
  //    A (with stroke):   own + allied pixels + stroke/Bresenham pixels — current state.
  //    B (without stroke): own + allied pixels MINUS the ones this stroke just flipped —
  //    the pre-stroke state. Regions enclosed in A but reachable in B were
  //    closed by THIS stroke.
  const isWallA = (gi) => strokeWallMap.has(gi) || claimByPixel[gi] === cidx || _isAlly(gi);
  const isWallB = (gi) => (claimByPixel[gi] === cidx && !(changedSet && changedSet.has(gi))) || _isAlly(gi);

  const cells = bw * bh;
  const visitedA = new Uint8Array(cells);
  const visitedB = new Uint8Array(cells);
  const queue    = new Int32Array(cells);

  const flood = (visited, isWall) => {
    let head = 0, tail = 0;
    const seed = (lx, ly) => {
      const li = ly * bw + lx;
      if (visited[li]) return;
      if (isWall((minY + ly) * MAP_W + (minX + lx))) return;
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
        if (isWall((minY + ny) * MAP_W + (minX + nx))) continue;
        visited[nli] = 1; queue[tail++] = nli;
      }
    }
  };
  flood(visitedA, isWallA);
  flood(visitedB, isWallB);

  // 4. Collect NEWLY enclosed: land, in a geo, not own, sealed in A (not
  //    reachable from bbox edge) but reachable in B (so this stroke closed it).
  //    No geo restriction — a ring spanning a border claims both sides
  //    (applyPixels handles per-geo conquest accounting).
  const enclosed = [];
  let tooLarge = false;
  for (let ly = 0; ly < bh && !tooLarge; ly++) {
    for (let lx = 0; lx < bw; lx++) {
      const li = ly * bw + lx;
      if (visitedA[li] || !visitedB[li]) continue; // reachable now / old pocket
      const gx = minX + lx, gy = minY + ly;
      const gi = gy * MAP_W + gx;
      if (!landMask[gi]) continue;
      if (geoAtPixel[gi] < 0) continue;            // unattributed land — skip
      if (claimByPixel[gi] === cidx) continue;     // own pixels
      if (strokeWallMap.has(gi)) continue;         // Bresenham wall pixels
      enclosed.push({ x: gx, y: gy });
      if (enclosed.length > ENCIRCLE_MAX_PX) { tooLarge = true; break; }
    }
  }
  // Over-cap → no award at all (matches the client's skip — never half-fill).
  if (tooLarge || enclosed.length < ENCIRCLE_MIN_PX) return null;

  let sumX = 0, sumY = 0;
  for (const p of enclosed) { sumX += p.x; sumY += p.y; }
  return {
    enclosed, count: enclosed.length,
    centerX: Math.round(sumX / enclosed.length),
    centerY: Math.round(sumY / enclosed.length),
  };
}

// Map enclosed pixel count → regen multiplier and duration
function getEncircleBonus(count) {
  // v96: encircle bonus 3x–6x, ADDS on top of the passive bonus.
  // v97j: tiers shifted down so small encirclements still feel rewarding.
  //   15–49    → 3× for 60s   (Nice!)
  //   50–149   → 4× for 60s   (Amazing!)
  //   150–299  → 5× for 60s   (Outstanding!)
  //   300+     → 6× for 60s   (Legendary!)
  let mult = 3;
  if (count >= 300) mult = 6;
  else if (count >= 150) mult = 5;
  else if (count >= 50) mult = 4;
  else                    mult = 3;
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
    // v95z: keep ownerPixels in sync. finisherFill used to write claimByPixel +
    // geoClaimCnt directly and skip this, so conquered land was MISSING from
    // ownerPixels[conqueror]. _onCountryConquered liquidates a dead country by
    // iterating ownerPixels — so it never cleared land taken via finisherFill
    // (the "dead Guinea-Bissau still holds 100% of China" bug). The normal paint
    // path already does this via updateOwnerIndex; finisherFill must too.
    updateOwnerIndex(i, prev, cidx);
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

// ── v93o: board persistence (pixel map survives restarts/deploys) ──────────
// The painted board (claimByPixel) + conquests live only in memory; a PM2
// restart or deploy used to wipe the whole world. We snapshot to disk on a
// cadence + on graceful shutdown, and restore on boot.
//
// IMPORTANT: claimByPixel stores getIdx() indices, which are assigned in order
// of first appearance and are therefore NOT stable across runs. So the board is
// persisted as ID-based run-length runs ([start, len, countryId]) and the IDs
// are remapped to fresh indices via getIdx() on restore. countryPxCount and
// ownerPixels are derived from the restored board (guaranteed consistent).
const BOARD_FILE        = path.join(__dirname, 'board_state.json');
const BOARD_SNAPSHOT_MS = parseInt(process.env.BOARD_SNAPSHOT_MS || '30000', 10);

function _serializeBoard() {
  const runs = [];
  let rs = -1, ro = -99;
  for (let i = 0; i <= MAP_PX; i++) {
    const o = i < MAP_PX ? claimByPixel[i] : -999;
    if (o !== ro) {
      if (ro >= 0 && rs >= 0) runs.push([rs, i - rs, idxToId[ro]]); // [start, len, countryId]
      rs = i; ro = o;
    }
  }
  return JSON.stringify({
    v: 1,
    savedAt: Date.now(),
    runs,
    conquered: [...conqueredSet],
    permanentlyConquered: [...permanentlyConquered],
  });
}

function _writeBoard(json, sync) {
  const tmp = BOARD_FILE + '.tmp';
  if (sync) {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, BOARD_FILE);          // atomic replace
  } else {
    fs.writeFile(tmp, json, err => {
      if (err) { console.error('[Board] write failed:', err.message); return; }
      fs.rename(tmp, BOARD_FILE, e2 => { if (e2) console.error('[Board] rename failed:', e2.message); });
    });
  }
}

let _boardSaving = false;
function saveBoardSnapshot(sync) {
  // Only persist once map geography is loaded — otherwise there is no live
  // world to save and we'd risk clobbering the file we just restored on boot.
  if (!mapReady) return;
  if (_boardSaving && !sync) return; // skip if an async write is still in flight
  try {
    _boardSaving = true;
    _writeBoard(_serializeBoard(), !!sync);
  } catch (e) {
    console.error('[Board] snapshot failed:', (e && e.message) ? e.message : e);
  } finally {
    _boardSaving = false;
  }
}

function loadBoardSnapshot() {
  try {
    if (!fs.existsSync(BOARD_FILE)) { console.log('[Board] no snapshot found — starting a fresh world'); return; }
    const data = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    if (!data || !Array.isArray(data.runs)) { console.warn('[Board] snapshot malformed — ignoring'); return; }
    claimByPixel.fill(-1);
    for (const r of data.runs) {
      const s = r[0] | 0, l = r[1] | 0, id = String(r[2]);
      const idx = getIdx(id);
      const end = Math.min(s + l, MAP_PX);
      for (let i = s; i < end; i++) claimByPixel[i] = idx;
    }
    // Derive ownerPixels + countryPxCount from the restored board.
    for (const k of Object.keys(ownerPixels))   delete ownerPixels[k];
    for (const k of Object.keys(countryPxCount)) delete countryPxCount[k];
    let painted = 0;
    for (let i = 0; i < MAP_PX; i++) {
      const o = claimByPixel[i];
      if (o < 0) continue;
      (ownerPixels[o] || (ownerPixels[o] = new Set())).add(i);
      const id = idxToId[o];
      countryPxCount[id] = (countryPxCount[id] || 0) + 1;
      painted++;
    }
    conqueredSet.clear();
    for (const k of (data.conquered || [])) conqueredSet.add(k);
    permanentlyConquered.clear();
    for (const k of (data.permanentlyConquered || [])) permanentlyConquered.add(String(k));
    // v95m: do NOT un-stick unheld permanent locks anymore. Under the "dead for the
    // round" model, a permanentlyConquered native that's no longer held is a neutral
    // "Fallen" zone (reconquerable by OTHERS), and must stay dead — not revive.
    console.log('[Board] restored', painted, 'painted pixels,', conqueredSet.size, 'conquests (saved',
      data.savedAt ? new Date(data.savedAt).toISOString() : '?', ')');
    // v93x: claimByPixel is restored but geoClaimCnt (read by the conquest check)
    // needs the geography map (geoAtPixel), which only arrives at the first client
    // join. Defer the rebuild until then.
    if (painted > 0) _boardRestoredPendingRebuild = true;
  } catch (e) {
    console.error('[Board] load failed — starting fresh:', (e && e.message) ? e.message : e);
  }
}

// v93x: rebuild geoClaimCnt[geoCountryId][ownerCountryId] from the restored
// claimByPixel + geoAtPixel. Without this, board-persistence restores the visible
// board but the conquest check (which reads geoClaimCnt) sees stale/empty counts,
// so restored occupation never triggers a fall (e.g. Italy 98% foreign on the map
// but the check saw ~7%). Run once after the first join provides geoAtPixel.
let _boardRestoredPendingRebuild = false;
function _rebuildGeoClaimCnt() {
  for (const k of Object.keys(geoClaimCnt)) delete geoClaimCnt[k];
  let n = 0;
  for (let i = 0; i < MAP_PX; i++) {
    const owner = claimByPixel[i];
    if (owner < 0) continue;
    const geo = geoAtPixel[i];
    if (geo < 0) continue;
    const ownerId = idxToId[owner];
    if (ownerId === undefined) continue;
    (geoClaimCnt[geo] ??= {});
    geoClaimCnt[geo][ownerId] = (geoClaimCnt[geo][ownerId] || 0) + 1;
    n++;
  }
  console.log('[Board] rebuilt geoClaimCnt from restored board:', n, 'claimed pixels across', Object.keys(geoClaimCnt).length, 'geos');
}

loadBoardSnapshot();
setInterval(() => saveBoardSnapshot(false), BOARD_SNAPSHOT_MS);
console.log('[Board] snapshot cadence', (BOARD_SNAPSHOT_MS / 1000) + 's →', BOARD_FILE);

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

// v80: bot personality tunables — bumped aggression vs random exploration.
// All three knobs make bots conquer-focused instead of wandering home-builders.
const BOT_SCOUT_CHANCE      = 0;      // v114: NO random distant scouting — it was the main source of "scatter-shot" bots painting all over the map. Bots now only expand into their homeland + attack the single best adjacent target (focused conquering).
const BOT_HOMESTABLE_THRESH = 0.25;   // was 0.40 — attack while home is still 25% secured (was 40%)
const BOT_DEFEND_THRESHOLD  = 8;      // require at least this many sampled-invaded pixels before dropping attacks to defend (was: defend always wins)
// v114/v115: per-bot paint-rate cap that SCALES WITH SCARCITY — the fewer countries
// remain, the more intense the surviving bots get (operator: "more intense activity
// the less countries remain"). Early game (full roster) = calm gap; late game = frenzy.
const BOT_GAP_CALM_MS      = 3000;  // gap when ~all countries stand (early — deliberate but visibly active)
const BOT_GAP_FRENZY_MS    = 500;   // gap when almost none remain (late — intense)
const BOT_DEFEND_RATE_FRAC = 0.08;  // homeland >= this foreign-held → "defending"
const BOT_DEFEND_CHANCE    = 0.45;  // v115: defend only SPORADICALLY — otherwise keep pushing the offensive
const BOT_STICKY_BONUS     = 6;     // v115: score bonus for the country a bot is already invading (commit, don't flip-flop)
const BOT_STANDING_BONUS   = 12;    // v115a: score bonus for a STANDING (not fallen) neighbour — bots chase fresh conquests first, but fallen land stays a fallback so they never idle
// v140: COMMITTED RANDOM-COUNTRY CAMPAIGNS — bots periodically pick a random country
// ANYWHERE on the map (not just a neighbour) and push to take it over, so fighting spreads
// across the whole world (lots of visible back-and-forth) instead of only along borders.
const BOT_CAMPAIGN_CHANCE  = 0.5;    // chance to START a new campaign when none active/expired
const BOT_CAMPAIGN_MS      = 40000;  // how long a bot commits to one random-country campaign
const BOT_CAMPAIGN_PURSUE  = 0.55;   // per-tick chance to push the campaign vs. do local defend/attack
// v140: bots occasionally draw a RING around a pocket of land and capture the interior
// (encirclement), like a player drawing a circle.
const BOT_ENCIRCLE_CHANCE  = 0.03;   // per-eligible-tick chance to attempt an encircle maneuver
let   _botRosterPeak       = 0;     // captured at roster build; denominator for scarcity
// Fraction of the original roster still standing: 1 (early/calm) .. ~0 (late/frenzy).
function _botScarcityFrac() {
  if (_botRosterPeak <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - permanentlyConquered.size / _botRosterPeak));
}
// Per-bot minimum gap between paints. Shrinks as the world consolidates; a defending
// bot paints ~3x faster than its current gap.
function _botPaintGap(defending) {
  const frac = _botScarcityFrac();
  let gap = BOT_GAP_FRENZY_MS + (BOT_GAP_CALM_MS - BOT_GAP_FRENZY_MS) * frac;
  if (defending) gap = Math.max(400, gap / 3);
  return gap;
}

// v86: Random rotating rivalries. Every ~3 days the server picks a fresh set
// of country-vs-country rivalries from the notable-countries pool. Bots whose
// home country is on either side of a rivalry get a strong attack bias toward
// the rival's territory. Makes the world feel "topical" without scraping news
// (avoids the political-sensitivity pitfalls discussed in v84).
//
// Deterministic per 3-day window using a seeded RNG, so the rivalry roster is
// stable for ~3 days and identical across all bot ticks within that window.
const RIVALRY_REFRESH_MS = 3 * 24 * 3600 * 1000; // 3 days
const RIVALRY_COUNT      = 8;                      // pairs to keep active
const RIVALRY_BIAS_SCORE = 12;                     // score boost when target is a rival (huge — outranks contested+size)

const RIVALRY_POOL = [
  // Curated apolitical-leaning pairs that have well-known geographic friction
  // but aren't tied to a specific active hot conflict. Server picks RIVALRY_COUNT
  // of these per 3-day window.
  ['840', '156'], // USA vs China (the classic)
  ['840', '643'], // USA vs Russia (cold war energy)
  ['156', '356'], // China vs India
  ['356', '586'], // India vs Pakistan
  ['410', '408'], // South Korea vs North Korea
  ['376', '364'], // Israel vs Iran
  ['792', '300'], // Turkey vs Greece
  ['724', '826'], // Spain vs UK (Gibraltar etc.)
  ['484', '840'], // Mexico vs USA
  ['076', '032'], // Brazil vs Argentina
  ['250', '826'], // France vs UK
  ['392', '410'], // Japan vs South Korea
  ['392', '156'], // Japan vs China
  ['276', '250'], // Germany vs France (friendly)
  ['158', '156'], // Taiwan vs China
  ['804', '643'], // Ukraine vs Russia (current real conflict — included by user mandate)
  ['682', '364'], // Saudi Arabia vs Iran (regional)
  ['566', '710'], // Nigeria vs South Africa (continental)
];

function _activeRivalries() {
  const windowKey = Math.floor(Date.now() / RIVALRY_REFRESH_MS);
  // Deterministic shuffle seeded by windowKey
  const shuffled = RIVALRY_POOL.slice();
  let seed = (windowKey * 2654435761) >>> 0;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, RIVALRY_COUNT);
}
// Build per-countryId Set<rivalCountryId> for O(1) lookup in getBotTargets.
let _rivalryByCountry = new Map();
let _rivalryWindow = -1;
function _refreshRivalryIndex() {
  const windowKey = Math.floor(Date.now() / RIVALRY_REFRESH_MS);
  if (windowKey === _rivalryWindow) return _rivalryByCountry;
  _rivalryWindow = windowKey;
  _rivalryByCountry = new Map();
  for (const [a, b] of _activeRivalries()) {
    if (!_rivalryByCountry.has(a)) _rivalryByCountry.set(a, new Set());
    if (!_rivalryByCountry.has(b)) _rivalryByCountry.set(b, new Set());
    _rivalryByCountry.get(a).add(b);
    _rivalryByCountry.get(b).add(a);
  }
  const names = _activeRivalries().map(([a,b]) => _countryName(a) + ' vs ' + _countryName(b)).join(' · ');
  console.log('[Rivalry] Active for window ' + windowKey + ': ' + names);
  return _rivalryByCountry;
}
function _isRival(countryId, targetCountryId) {
  _refreshRivalryIndex();
  const set = _rivalryByCountry.get(String(countryId));
  return set ? set.has(String(targetCountryId)) : false;
}

// v140: pick a random country anywhere on the map for a takeover campaign. Samples
// random geos and scores them (prefer standing, contested, big, rivals) so targets vary.
function _pickCampaignTarget(countryId, ownGeoIdx) {
  const keys = Object.keys(geoPixels);
  if (!keys.length) return null;
  let bestGeo = -1, bestScore = -1;
  for (let a = 0; a < 25; a++) {
    const g = parseInt(keys[Math.floor(Math.random() * keys.length)], 10);
    if (g === ownGeoIdx) continue;
    const homeId = geoToId(g);
    if (!_isPlayableNation(homeId)) continue;
    if (conqueredSet.has(String(homeId) + ':' + String(countryId))) continue; // already ours
    const total   = geoTotal[g] || 1;
    const claims  = geoClaimCnt[g] || {};
    const foreign = Object.entries(claims).filter(([c]) => c !== homeId).reduce((s, [, v]) => s + v, 0);
    let score = 1 + Math.random() * 3;                              // jitter → varied targets
    if (!permanentlyConquered.has(String(homeId))) score += 4;      // prefer fresh (standing) conquests
    score += getWorldShare(homeId) * 8;                            // prefer bigger / more visible
    if (foreign / total >= 0.1) score += 3;                         // pile onto contested
    if (_isRival(countryId, homeId)) score += 4;
    if (score > bestScore) { bestScore = score; bestGeo = g; }
  }
  return bestGeo >= 0 ? bestGeo : null;
}
// v140: pixels to paint for the active campaign — grow from any foothold the bot has in
// the target, else seed a cluster near the target's centre.
function _campaignPixels(geo, cidx, limit) {
  const px = geoPixels[geo]; if (!px || !px.length) return [];
  const step = Math.max(1, Math.floor(px.length / 400));
  const out = [];
  for (let s = 0; s < px.length && out.length < limit; s += step) {  // grow from a foothold
    const i = px[s]; if (claimByPixel[i] !== cidx) continue;
    const x = i % MAP_W, y = (i / MAP_W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d], ny = y + DY4[d];
      if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
      const ni = ny * MAP_W + nx;
      if (geoAtPixel[ni] !== geo || !landMask[ni] || claimByPixel[ni] === cidx) continue;
      out.push({ x: nx, y: ny }); if (out.length >= limit) break;
    }
  }
  if (out.length) return out;
  const bb = geoBbox[geo];                                            // no foothold → seed near centre
  const ccx = bb ? ((bb.minX + bb.maxX) / 2) | 0 : 0, ccy = bb ? ((bb.minY + bb.maxY) / 2) | 0 : 0;
  const cand = [];
  for (let s = 0; s < px.length; s += step) {
    const i = px[s]; if (claimByPixel[i] === cidx) continue;
    const x = i % MAP_W, y = (i / MAP_W) | 0;
    cand.push({ x, y, d: (x - ccx) * (x - ccx) + (y - ccy) * (y - ccy) });
  }
  cand.sort((a, b) => a.d - b.d);
  return cand.slice(0, limit).map(p => ({ x: p.x, y: p.y }));
}
// v140: ENCIRCLE maneuver — draw a ring around the campaign target's centre and capture
// the enclosed interior (the same detectEncirclement the player path uses). Returns true
// if it painted anything. Aborts if the ring would cross ocean (it couldn't seal).
// v145a: Bresenham line between two ring sample points so a WOBBLY outline has no
// 1px gaps (gaps would break the encirclement seal). Pushes onto `out`.
function _lineP(x0, y0, x1, y1, out) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
  for (;;) {
    out.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 <  dx) { err += dx; y0 += sy; }
  }
}
// v145a: organic splotch — a small irregular blob grown by a short random walk from a
// seed (with a little +-neighbour spread), clipped to the target geo's land. Pushes
// in-geo land pixels onto `out`. Makes bot paint look hand-drawn, not geometric.
function _splotchPixels(sx, sy, geo, size, out) {
  let x = sx, y = sy;
  for (let s = 0; s < size; s++) {
    if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H) {
      const i = y * MAP_W + x;
      if (landMask[i] && geoAtPixel[i] === geo) {
        out.push({ x, y });
        // small cross spread for blobbiness
        for (let d = 0; d < 4; d++) {
          const nx = x + DX4[d], ny = y + DY4[d];
          if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
          const ni = ny * MAP_W + nx;
          if (landMask[ni] && geoAtPixel[ni] === geo && Math.random() < 0.5) out.push({ x: nx, y: ny });
        }
      }
    }
    const d = Math.floor(Math.random() * 4);
    x += DX4[d]; y += DY4[d];
  }
}
// v145a: scatter `n` organic splotches over random land pixels of the campaign geo.
function _scatterSplotches(gpx, geo, n, out) {
  for (let b = 0; b < n; b++) {
    const p = gpx[Math.floor(Math.random() * gpx.length)];
    _splotchPixels(p % MAP_W, (p / MAP_W) | 0, geo, 5 + Math.floor(Math.random() * 9), out);
  }
}
function _botEncircleManeuver(countryId) {
  const cidx = getIdx(countryId);
  const bot  = bots.get(String(countryId));
  if (!bot || bot.campaignGeo == null) return false;
  const geo = bot.campaignGeo;
  // v140a: centre on a RANDOM land pixel of the target (not the fixed bbox centre) so bots
  // don't keep re-drawing the same circle in the exact same spot.
  const gpx = geoPixels[geo]; if (!gpx || !gpx.length) return false;

  // v145a: ORGANIC maneuvers. ~35% of the time paint pure random splotches (no sealing
  // ring) so the map shows hand-drawn blobs, not just clean circles; the rest draw a
  // WOBBLY (sine-perturbed) ring — connected via Bresenham so it still seals — often
  // with a few splotches sprinkled alongside for texture.
  if (Math.random() < 0.35) {
    const out = [];
    _scatterSplotches(gpx, geo, 2 + Math.floor(Math.random() * 4), out);
    if (!out.length) return false;
    const res = applyPixels(out, countryId);
    if (res.changed.length) { queueDelta(res.changed); _botPaintsSinceWatch += res.changed.length; }
    res.conquests.forEach(c => broadcast(JSON.stringify({ type: 'conquest', ...c })));
    res.reversals.forEach(r => broadcast(JSON.stringify({ type: 'reversal', ...r })));
    return res.changed.length > 0;
  }

  const ctr = gpx[Math.floor(Math.random() * gpx.length)];
  const cx = ctr % MAP_W, cy = (ctr / MAP_W) | 0;
  if (!landMask[cy * MAP_W + cx]) return false;
  const R = 5 + Math.floor(Math.random() * 4);                        // 5..8
  const steps = Math.max(40, Math.round(2 * Math.PI * R * 1.4));
  // wobble: 1-2 sine harmonics with a random phase + amplitude → irregular outline
  const ph = Math.random() * 6.283, amp = 1 + Math.random() * 2.2, harm = 2 + Math.floor(Math.random() * 3);
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const ang = (k / steps) * 2 * Math.PI;
    const rr = R + amp * Math.sin(harm * ang + ph);
    const x = Math.round(cx + rr * Math.cos(ang)), y = Math.round(cy + rr * Math.sin(ang));
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return false;
    if (!landMask[y * MAP_W + x]) return false;                       // ocean gap → can't seal
    pts.push({ x, y });
  }
  const ring = [];
  for (let k = 0; k < pts.length - 1; k++) _lineP(pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y, ring);
  // v145a: sprinkle a couple of splotches alongside the ring half the time (organic texture,
  // doesn't affect the seal — extra interior/edge paint).
  if (Math.random() < 0.5) _scatterSplotches(gpx, geo, 1 + Math.floor(Math.random() * 2), ring);
  const ringRes = applyPixels(ring, countryId);
  if (ringRes.changed.length) { queueDelta(ringRes.changed); _botPaintsSinceWatch += ringRes.changed.length; }
  const changedSet = new Set();
  for (const p of ring) { const i = p.y * MAP_W + p.x; if (claimByPixel[i] === cidx) changedSet.add(i); }
  const enc = detectEncirclement(ring, countryId, changedSet);
  if (!enc || !enc.enclosed.length) return ringRes.changed.length > 0;
  const fill = applyPixels(enc.enclosed, countryId);
  if (fill.changed.length) { queueDelta(fill.changed); _botPaintsSinceWatch += fill.changed.length; }
  fill.conquests.forEach(c => broadcast(JSON.stringify({ type: 'conquest', ...c })));
  fill.reversals.forEach(r => broadcast(JSON.stringify({ type: 'reversal', ...r })));
  return true;
}

function getBotTargets(countryId, limit) {
  const cidx       = getIdx(countryId);
  const geoIdx     = getGeoForCountry(countryId);
  const homePixels = geoPixels[geoIdx];
  if (!homePixels || homePixels.length === 0) return [];

  // ── 0. v140: COMMITTED RANDOM-COUNTRY CAMPAIGN ─────────────────────────────
  // Periodically push a takeover of a random country anywhere on the map (not just a
  // neighbour) so the whole world sees back-and-forth fighting. The bot commits to one
  // target for BOT_CAMPAIGN_MS, then picks a fresh one. Pursued only part of the time so
  // it still defends/attacks locally the rest.
  {
    const _cbot = bots.get(String(countryId));
    if (_cbot) {
      const now = Date.now();
      const valid = (g) => g != null && geoPixels[g]
        && geoToId(g) !== String(countryId)
        && !conqueredSet.has(String(geoToId(g)) + ':' + String(countryId)); // not already ours
      if (!valid(_cbot.campaignGeo) || now > (_cbot.campaignUntil || 0)) {
        _cbot.campaignGeo  = (Math.random() < BOT_CAMPAIGN_CHANCE) ? _pickCampaignTarget(countryId, geoIdx) : null;
        _cbot.campaignUntil = now + BOT_CAMPAIGN_MS;
      }
      if (valid(_cbot.campaignGeo) && Math.random() < BOT_CAMPAIGN_PURSUE) {
        const pts = _campaignPixels(_cbot.campaignGeo, cidx, limit);
        if (pts.length) return pts;
      }
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

  // v80: defend only when truly invaded (was: any defend.length > 0 wins).
  // v115: and even then, defend only SPORADICALLY (BOT_DEFEND_CHANCE) — most of the
  // time the bot ignores skirmishes and keeps pressing the offensive (expansionist).
  if (defend.length >= BOT_DEFEND_THRESHOLD && Math.random() < BOT_DEFEND_CHANCE) {
    for (let i = defend.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [defend[i], defend[j]] = [defend[j], defend[i]];
    }
    return defend.slice(0, limit);
  }

  // ── 2. Strategic attack — score all neighbouring geos ────────
  const homeStable = homeOwned / homeSampleSize >= BOT_HOMESTABLE_THRESH;
  if (homeStable && ownerPixels[cidx]) {
    const geoScores    = new Map(); // targetGeoIdx → score
    const geoCandidates = new Map(); // targetGeoIdx → [{x,y}]
    const myShare      = getWorldShare(countryId);
    const ally         = getAllianceForCountry(String(countryId));
    // v115: target stickiness — keep hammering the same country until it falls,
    // then move on to a fresh one (focused/expansionist instead of flip-flopping).
    const _bot = bots.get(String(countryId));
    const _stickyGeo = (_bot && typeof _bot.attackGeo === 'number') ? _bot.attackGeo : -1;

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
        // v115a: don't pointlessly re-hit land THIS bot already holds (its own
        // outpost). Standing nations are strongly PREFERRED via the score bonus
        // below, but fallen land is NOT excluded — excluding it stranded bots with
        // no reachable target in a heavily-fallen map (the "no activity" regression).
        if (conqueredSet.has(String(geoToId(ngeo)) + ':' + String(countryId))) continue;

        if (!geoScores.has(ngeo)) {
          let score = 1;
          const nTotal   = geoTotal[ngeo] || 1;
          const nHomeId  = geoToId(ngeo);
          const nClaims  = geoClaimCnt[ngeo] || {};
          // v115a: strongly prefer STANDING nations (fresh conquests) — bots chase
          // new countries first and only fall back to fallen land when nothing else
          // is adjacent, so they stay active instead of idling.
          if (!permanentlyConquered.has(String(nHomeId))) score += BOT_STANDING_BONUS;

          // Opportunistic: pile on contested territories
          // v80: bumped tiers + added lowest bracket — bots pounce on even
          // lightly-contested neighbours instead of waiting for big openings.
          const foreign = Object.entries(nClaims)
            .filter(([c]) => c !== nHomeId).reduce((s, [, v]) => s + v, 0);
          const contested = foreign / nTotal;
          if      (contested >= 0.40) score += 7;
          else if (contested >= 0.20) score += 5;
          else if (contested >= 0.05) score += 3;
          else if (contested >= 0.01) score += 1;

          // v86: rivalry bias — if this neighbour is one of our current
          // 3-day rivals, score it WAY up. This is what makes the world feel
          // "live" with rotating tensions, without scraping real news.
          if (_isRival(countryId, nHomeId)) score += RIVALRY_BIAS_SCORE;

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

          // v115: stickiness — strongly prefer the country we're already invading so
          // the bot commits to a conquest instead of flip-flopping between targets.
          if (ngeo === _stickyGeo) score += BOT_STICKY_BONUS;

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
        if (_bot) _bot.attackGeo = bestGeo; // v115: remember target for stickiness
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
  const bot = { countryId, bucket: BOT_BUCKET_MAX, geoIdx: getGeoForCountry(countryId), units: 1 }; // v100: units
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

// v86: bot alliance availability — only 5-15% of bots set countryMain (and
// hence participate in alliance formation). The available fraction varies
// daily based on the UTC date so the world feels organic. This shrinks bot-
// driven alliances significantly while leaving the alliance system intact
// for human players.
//
// Combined with ALLIANCE_MIN_MEMBERS = 10, this means bots almost never form
// alliances by themselves; alliances mostly form when real players coordinate.
function _isBotAllianceEligibleToday(countryId) {
  // Daily-seeded RNG so the eligible set is stable for the calendar day (UTC)
  const dayKey = Math.floor(Date.now() / (24 * 3600 * 1000));
  // Pick a daily fraction in [0.05, 0.15]
  const dailyFrac = 0.05 + (((dayKey * 2654435761) >>> 0) % 1000) / 1000 * 0.10;
  // Per-bot stable hash combined with day
  let h = 2166136261;
  const s = String(countryId) + ':' + dayKey;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619 >>> 0;
  return (h % 1000) / 1000 < dailyFrac;
}

// v36/v86: bot profile bootstrap. Most bots now get null countryMain (no
// alliance participation); only the daily-eligible subset gets a random ally.
function _initBotProfile(countryId) {
  const synthId = 'bot:' + countryId;
  if (profiles.has(synthId)) return;
  const allIds = [...bots.keys()];
  if (allIds.length < 4) return;
  let pick = null;
  if (_isBotAllianceEligibleToday(countryId)) {
    const others = allIds.filter(id => id !== countryId);
    pick = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : null;
  }
  profiles.set(synthId, {
    discordId:   synthId,
    username:    'Bot ' + (countryNames[countryId] || countryId),
    rank:        'Soldier',
    points:      0,
    xp:          0,
    countryMain: pick,  // null = no alliance participation today
    countryB:    null,
    countryC:    null,
    joinedAt:    Date.now(),
    isBot:       true,
  });
}
// v86: re-evaluate alliance eligibility on day rollover. Bots that lose
// eligibility have their countryMain cleared; newly-eligible bots get one.
setInterval(() => {
  for (const countryId of bots.keys()) {
    const synthId = 'bot:' + countryId;
    let p = profiles.get(synthId);
    if (!p) { _initBotProfile(countryId); continue; }
    const eligible = _isBotAllianceEligibleToday(countryId);
    if (eligible && !p.countryMain) {
      // Newly eligible — pick a random ally
      const allIds = [...bots.keys()].filter(id => id !== countryId);
      if (allIds.length > 0) p.countryMain = allIds[Math.floor(Math.random() * allIds.length)];
    } else if (!eligible && p.countryMain) {
      p.countryMain = null;  // drop out for the day
    }
  }
}, 60 * 1000);

// Stagger bot ticks so they don't all fire simultaneously.
// Tickers are self-terminating: if the bot disappears from the map, the ticker stops.
// v128: HARDENED against the recurring "no bot activity" stall. The previous
// ticker called botTickSingle() bare, then reschedule. If botTickSingle THREW,
// (a) the reschedule line never ran → that bot's loop died permanently, and
// (b) with no uncaughtException handler the throw could crash the whole process.
// Now the call is wrapped in try/catch and the reschedule is GUARANTEED, plus a
// watchdog (below) restarts every ticker if the loop is ever found dead.
let _tickersStarted = false;
let _botTicksSinceWatch = 0;   // liveness counter — bumped on every tick attempt
let _botTickErrLogged = false; // throttle error spam to a single line per window
let _botPaintsSinceWatch = 0;  // v130: actual bot paints this window (catches "ticking but not painting")
let _botZeroPaintWindows = 0;  // v130: consecutive 20s windows with zero bot paints
function _botTickLoop(countryId) {
  if (!bots.has(countryId)) return; // bot was removed — stop this ticker
  _botTicksSinceWatch++;
  try {
    botTickSingle(countryId);
  } catch (e) {
    if (!_botTickErrLogged) { console.error('[Bot] tick error for', countryId, (e && e.stack) || e); _botTickErrLogged = true; }
  }
  setTimeout(() => _botTickLoop(countryId), BOT_TICK_MS); // ALWAYS reschedule
}
function startBotTickers() {
  if (_tickersStarted) return; // already running — no need to start more
  _tickersStarted = true;
  let i = 0;
  for (const [countryId] of bots) {
    const delay = (i % 20) * (BOT_TICK_MS / 20); // spread across tick window
    setTimeout(() => _botTickLoop(countryId), delay);
    i++;
  }
  console.log(`[Bot] ${bots.size} bot tickers started (staggered)`);
}

// When new bots are added later, start their tickers individually
function startTickerFor(countryId) {
  setTimeout(() => _botTickLoop(countryId), Math.random() * BOT_TICK_MS);
}

// v128: bot-activity watchdog. If the tickers ever stop (zero tick ATTEMPTS in a
// 20s window while bots exist and the map is ready), restart them all — self-heals
// the recurring "no bot activity" with no manual pm2 restart. Only fires when the
// counter is 0 (loop confirmed dead) so it can never double-up live tickers.
setInterval(() => {
  if (_BOTS_DISABLED || !mapReady) { _botTicksSinceWatch = 0; _botPaintsSinceWatch = 0; _botZeroPaintWindows = 0; return; }
  if (bots.size > 0 && _botTicksSinceWatch === 0) {
    console.warn('[Bot] WATCHDOG: 0 tick attempts in 20s — restarting all tickers');
    _tickersStarted = false;
    startBotTickers();
  }
  // v130: paint-liveness diagnostic. Tickers can be ALIVE (attempts > 0) yet paint
  // nothing (all gated/surrendered/bucket-starved). Restarting LIVE loops would DOUBLE
  // them (the chains reschedule themselves), so this is LOG-ONLY — it surfaces a real
  // "bots inactive" condition for the operator to act on (DISABLE_BOTS env, regen, etc.).
  if (bots.size > 0 && _botTicksSinceWatch > 0) {
    if (_botPaintsSinceWatch === 0) {
      _botZeroPaintWindows++;
      if (_botZeroPaintWindows >= 3) {
        console.warn('[Bot] WATCHDOG: 0 bot paints in ' + (_botZeroPaintWindows * 20) +
          's despite ' + bots.size + ' bots (tickers alive) — check DISABLE_BOTS env / bucket regen / all-surrendered');
      }
    } else {
      _botZeroPaintWindows = 0;
    }
  }
  _botTickErrLogged = false; // allow one fresh error line next window
  _botTicksSinceWatch = 0;
  _botPaintsSinceWatch = 0;
}, 20000);

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
// country's home territory the defending bot stands down completely. This lets
// the attacker accumulate pixels unopposed until applyPixels fires formal
// conquest at conquestThreshold() (v91: size-scaled 70–90%). Surrender stays
// well below conquest so the attacker can grind up to the (now higher) bar,
// and reversalThreshold() sits 15 pts under conquest so a fresh conquest
// isn't immediately undone.
const BOT_SURRENDER_THRESHOLD = 0.50;

// v75-debug: hard kill-switch for bot activity to isolate stall causes.
// Set DISABLE_BOTS=1 in env to keep all bots dormant (no painting, no migration,
// no _tickBotActivity drift). They still exist in players list for UI counts.
let _BOTS_DISABLED = process.env.DISABLE_BOTS === '1' || process.env.DISABLE_BOTS === 'true'; // v95v: `let` so /admin can toggle live
if (_BOTS_DISABLED) console.log('[Bot] *** BOTS DISABLED via DISABLE_BOTS env var ***');

function botTickSingle(countryId) {
  if (_BOTS_DISABLED) return;
  if (!mapReady) return;
  // Once permanently conquered this cycle the bot never resumes — even if a
  // monster/nuke reversal temporarily drops the attacker below the threshold.
  if (permanentlyConquered.has(countryId)) return;
  // Active conquest gate (redundant with permanentlyConquered, but kept for
  // clarity and to block mid-conquest activity before the set is populated).
  if (_isCountryConquered(countryId)) return;
  // v100 (Phase 2A): humans replace bot units 1:1. (humanClaimedCountries is dead
  // code — .add is never called anywhere — so the old all-or-nothing gate was a
  // no-op; replaced by the per-unit human reduction below.)
  const bot = bots.get(countryId);
  if (!bot) return;
  const effUnits = _effectiveBotUnits(bot);
  if (effUnits <= 0) return; // live humans cover this country
  // v56: bot stands down when overwhelmed so the attacker can reach the formal
  // conquest threshold (60%) without constant reclaim interference.
  const _homeGeoIdx = getGeoForCountry(countryId);
  const _homeTotal  = geoTotal[_homeGeoIdx] || 0;
  // v114: also measure how invaded the homeland is — drives the "defending" paint
  // rate below (a bot under real attack paints faster to hold its ground).
  let _foreignHome = 0;
  if (_homeTotal > 0) {
    const _claims = geoClaimCnt[_homeGeoIdx];
    if (_claims) {
      for (const [cId, cnt] of Object.entries(_claims)) {
        if (cId === countryId) continue;
        _foreignHome += cnt;
        if (cnt / _homeTotal >= BOT_SURRENDER_THRESHOLD) {
          return; // overwhelmed — stand down, let applyPixels fire formal conquest
        }
      }
    }
  }
  // v34: only active bots paint
  if (!_isBotActive(countryId)) return;
  if (bot.bucket < BOT_PIXELS_PER_TICK) return;

  // v114/v115: per-bot paint-rate cap that scales with scarcity (calm early, frenzy
  // late) so activity intensifies as the world shrinks. Units no longer multiply the
  // paint count (was the main source of scatter). A bot defends its homeland only
  // SPORADICALLY (BOT_DEFEND_CHANCE) — otherwise it keeps pressing the offensive.
  const _defending = _homeTotal > 0 && (_foreignHome / _homeTotal) >= BOT_DEFEND_RATE_FRAC;
  const _minGap = _botPaintGap(_defending);
  const _now = Date.now();
  if (_now - (bot.lastPaintAt || 0) < _minGap) return;

  // v140: occasional ENCIRCLE maneuver — draw a ring around the campaign target and
  // capture the interior (like a player drawing a circle). Offensive ticks only.
  if (!_defending && bot.campaignGeo != null && Math.random() < BOT_ENCIRCLE_CHANCE) {
    try { if (_botEncircleManeuver(countryId)) { bot.lastPaintAt = _now; return; } } catch (e) {}
  }

  const budget = Math.min(BOT_PIXELS_PER_TICK, Math.floor(bot.bucket)); // capped at 1px/paint
  const targets = getBotTargets(countryId, budget);
  if (targets.length === 0) return;

  bot.bucket -= Math.min(budget, targets.length);
  bot.lastPaintAt = _now; // v114: stamp for the paint-rate throttle
  const { changed, conquests, reversals } = applyPixels(targets, countryId);
  if (changed.length) { queueDelta(changed); _botPaintsSinceWatch += changed.length; } // v130: paint-liveness
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
  // v97e: bot regen via the unified _serverRegen (David curve + encircle + leader
  // tax + exile debuff; bots have no alliance/rank). Mirrors client getRegenMult.
  for (const bot of bots.values()) {
    const cap = BOT_BUCKET_MAX * (bot.units || 1); // v100: capacity scales with units
    if (bot.bucket >= cap) continue;
    // v114: _serverRegen now returns px/SECOND — credit rate * elapsed seconds.
    const add = _serverRegen(bot.countryId) * (BOT_REGEN_MS / 1000) * (bot.units || 1);
    bot.bucket = Math.min(cap, bot.bucket + add);
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
  // OR is non-playable (v95g — e.g. Antarctica, whose 10-px sliver kept spawning
  // a bot that painted + conquered).
  const validCountries = new Set(Object.keys(geoPixels).map(String));
  let removed = 0;
  for (const countryId of [...bots.keys()]) {
    if (!validCountries.has(countryId) || !_isPlayableCountry(countryId)) { // v98b: size+name floor too
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

  // Spawn bots for any country missing one (skip non-playable — v95g)
  let added = 0;
  for (const geoIdx of Object.keys(geoPixels)) {
    const countryId = String(geoIdx);
    if (!_isPlayableCountry(countryId)) continue; // v98b: was NON_PLAYABLE_IDS only
    if (!bots.has(countryId)) {
      botInit(countryId);
      added++;
      if (wasReady) startTickerFor(countryId); // start ticker individually after initial batch
    }
  }

  // v95g: reverse any conquest that a non-playable country still holds (or any
  // conquest OF a non-playable geo) so its flags/conqueredSet entries clear —
  // covers state left over from before this guard, or persisted in board_state.
  for (const key of [...conqueredSet]) {
    const parts = String(key).split(':');
    if (parts.length !== 2) continue;
    const geo = parseInt(parts[0], 10), holder = parts[1];
    if (!_isPlayableCountry(geo) || !_isPlayableCountry(holder)) { // v98b: also unnamed/micro features
      conqueredSet.delete(key);
      _clearPermanentIfFree(geo);
      broadcast(JSON.stringify({ type: 'reversal', geoIdx: geo, countryId: holder, reason: 'non-playable' }));
      console.log('[Conquest] cleared non-playable conquest:', key);
    }
  }

  _botRosterPeak = Math.max(_botRosterPeak, bots.size); // v115: scarcity denominator (peak roster)
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
    // Whitelist: [a-z]{2}.png country flags + the special Fallen.png marker (v134).
    const m = url.pathname.match(/^\/flags\/([a-z]{2}|Fallen)\.png$/);
    if (!m) {
      res.writeHead(400);
      res.end('invalid flag path');
      return;
    }
    const name = m[1];
    const f = path.join(__dirname, 'public', 'flags', name + '.png');
    if (!fs.existsSync(f)) {
      res.writeHead(404);
      res.end('flag not found: ' + name);
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

  // ── v102 (Phase 2C): leader portraits at /portraits/{countryId}.png ──
  // Operator-supplied 64x64 PNGs in public/portraits/, named by numeric country
  // id (e.g. 840.png = USA; synthetic 9000+ ids allowed). 404 → client falls
  // back to the flag.
  if (url.pathname.startsWith('/portraits/') && url.pathname.endsWith('.png')) {
    const m = url.pathname.match(/^\/portraits\/(\d{1,5})\.png$/);
    if (!m) { res.writeHead(400); res.end('invalid portrait path'); return; }
    const f = path.join(__dirname, 'public', 'portraits', m[1] + '.png');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('portrait not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // ── v106: leader/monster/generic avatars at /Avatars/{name}.png ──
  if (url.pathname.startsWith('/Avatars/') && url.pathname.endsWith('.png')) {
    const m = url.pathname.match(/^\/Avatars\/([A-Za-z0-9_-]+\.png)$/);
    if (!m) { res.writeHead(400); res.end('invalid avatar path'); return; }
    const f = path.join(__dirname, 'public', 'Avatars', m[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('avatar not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // ── v114: conquest emote PNGs at /emoji/{Name}.png ───────────────
  if (url.pathname.startsWith('/emoji/') && url.pathname.endsWith('.png')) {
    const m = url.pathname.match(/^\/emoji\/([A-Za-z0-9_-]+\.png)$/);
    if (!m) { res.writeHead(400); res.end('invalid emoji path'); return; }
    const f = path.join(__dirname, 'public', 'emoji', m[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('emoji not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // ── v106: hero banner for the welcome / FTUE screens ─────────────
  if (url.pathname === '/PixelAnnexHero.jpg') {
    const f = path.join(__dirname, 'public', 'PixelAnnexHero.jpg');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('hero not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // ── v124: pre-baked map assets (grid RLE + biome + metadata) ────
  // Lets the client skip the 3.6MB TopoJSON download + rasterization +
  // cleanup + biome compute + IndexedDB entirely (mobile-crash fix). The
  // client falls back to the full build if any of these 404 / fail.
  if (url.pathname === '/map_grid.json' || url.pathname === '/map_meta.json' || url.pathname === '/map_base.webp' || url.pathname === '/map_base.gif') {
    const name = url.pathname.slice(1);
    const f = path.join(__dirname, 'public', name);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('baked asset not found'); return; }
    const isImage = name.endsWith('.webp') || name.endsWith('.gif'); // v128: gif support
    const ctype = name.endsWith('.webp') ? 'image/webp' : (name.endsWith('.gif') ? 'image/gif' : 'application/json');
    const headers = {
      'Content-Type': ctype,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    };
    const accept = req.headers['accept-encoding'] || '';
    if (!isImage && accept.includes('gzip')) {
      const zlib = require('zlib');
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      fs.createReadStream(f).pipe(zlib.createGzip({ level: 9 })).pipe(res);
    } else {
      res.writeHead(200, headers);
      fs.createReadStream(f).pipe(res);
    }
    return;
  }

  // ── v88: tweet screenshots at /shots/{name}.png ────────────────
  if (url.pathname.startsWith('/shots/') && url.pathname.endsWith('.png')) {
    const m = url.pathname.match(/^\/shots\/([A-Za-z0-9_]+\.png)$/);
    if (!m) { res.writeHead(400); res.end('invalid shot path'); return; }
    const f = path.join(SHOTS_DIR, m[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('shot not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(f).pipe(res);
    return;
  }

  // ── v92n: timelapse GIFs (+ frames) ────────────────────────────
  if (url.pathname.startsWith('/timelapse/') && (url.pathname.endsWith('.gif') || url.pathname.endsWith('.png'))) {
    const m = url.pathname.match(/^\/timelapse\/([A-Za-z0-9_.\-]+\.(gif|png))$/);
    if (!m) { res.writeHead(400); res.end('invalid timelapse path'); return; }
    const f = path.join(TIMELAPSE_DIR, m[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('timelapse not found'); return; }
    res.writeHead(200, {
      'Content-Type': m[2] === 'gif' ? 'image/gif' : 'image/png',
      'Cache-Control': 'public, max-age=3600',
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

  // ── /admin — operator dashboard (metrics + controls), gated ──────────
  if (url.pathname === '/admin') {
    if (!_adminOK(url, req)) {
      res.writeHead(process.env.TWEETS_ADMIN_SECRET ? 401 : 503, { 'Content-Type': 'text/html' });
      res.end(process.env.TWEETS_ADMIN_SECRET ? '<h2>Unauthorized — append ?key=YOUR_SECRET</h2>' : '<h2>Admin disabled — set TWEETS_ADMIN_SECRET in .env</h2>');
      return;
    }
    if (_adminCookieRedirect(url, req, res)) return; // v98b: move secret URL→cookie
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ADMIN_DASHBOARD_HTML);
    return;
  }

  // ── /api/admin/metrics — live game KPIs (gated) ──────────────────────
  if (url.pathname === '/api/admin/metrics') {
    if (!_adminOK(url, req)) {
      res.writeHead(process.env.TWEETS_ADMIN_SECRET ? 401 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: process.env.TWEETS_ADMIN_SECRET ? 'unauthorized' : 'admin disabled' }));
      return;
    }
    let humans = 0, signedIn = 0;
    for (const [, p] of players) { if (p.isBot || !p.ws) continue; humans++; if (p.discordId) signedIn++; }
    let paintedPx = 0; for (const k in countryPxCount) paintedPx += countryPxCount[k] || 0;
    const conqByHolder = {};
    for (const key of conqueredSet) { const h = String(key).split(':')[1]; if (h) conqByHolder[h] = (conqByHolder[h] || 0) + 1; }
    const topConq = Object.entries(conqByHolder).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([id, n]) => ({ country: _countryName(id), conquests: n }));
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      serverVersion: SERVER_VERSION,
      uptimeSec: Math.round(process.uptime()),
      memRssMB: Math.round(mem.rss / 1048576),
      mapReady,
      botsDisabled: _BOTS_DISABLED,
      worldConquestActive: _worldConquestActive,
      humanPlayers: humans,
      signedInPlayers: signedIn,
      signInRatePct: humans ? Math.round(signedIn / humans * 100) : 0,
      activeBots: (typeof _activeBotCount === 'function' ? _activeBotCount() : bots.size),
      botsTotal: bots.size,
      connections: players.size,
      profilesTotal: profiles.size,
      conquests: _countDistinctConquered(),
      totalCountries: _totalCountries(),
      paintedPixels: paintedPx,
      topConquerors: topConq,
    }));
    return;
  }

  // ── /api/admin/control — world actions (gated, POST) ─────────────────
  if (url.pathname === '/api/admin/control' && req.method === 'POST') {
    if (!_adminOK(url, req)) {
      res.writeHead(process.env.TWEETS_ADMIN_SECRET ? 401 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: process.env.TWEETS_ADMIN_SECRET ? 'unauthorized' : 'admin disabled' }));
      return;
    }
    const action = url.searchParams.get('action');
    if (action === 'bots') {
      _BOTS_DISABLED = url.searchParams.get('disabled') === '1';
      console.log('[Admin] bots ' + (_BOTS_DISABLED ? 'DISABLED' : 'ENABLED'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, botsDisabled: _BOTS_DISABLED }));
      return;
    }
    if (action === 'monster') {
      const t = (url.searchParams.get('type') || '').toLowerCase();
      const id = 'admin-' + Date.now();
      if (t === 'ufo' && typeof _spawnUFO === 'function') _spawnUFO(id);
      else if (t === 'kraken' && typeof _spawnKraken === 'function') _spawnKraken(id);
      else if (t === 'godzilla' && typeof _spawnGodzilla === 'function') _spawnGodzilla(id);
      else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad monster type' })); return; }
      console.log('[Admin] spawned monster:', t);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: t }));
      return;
    }
    if (action === 'broadcast') {
      const text = (url.searchParams.get('text') || '').slice(0, 200).trim();
      if (text) { broadcast(JSON.stringify({ type: 'admin_announce', text })); console.log('[Admin] broadcast:', text); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !!text }));
      return;
    }
    if (action === 'reset') {
      console.log('[Admin] manual world reset');
      _resetWorld();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown action' }));
    return;
  }


  // ── /admin/tweets — operator-facing draft queue page ──
  if (url.pathname === '/admin/tweets') {
    if (!process.env.TWEETS_ADMIN_SECRET) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Tweet admin disabled — set TWEETS_ADMIN_SECRET in .env');
      return;
    }
    if (!_adminOK(url, req)) { // v98b: timing-safe + cookie support
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    if (_adminCookieRedirect(url, req, res)) return; // v98b: move secret URL→cookie
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TWEET_ADMIN_HTML);
    return;
  }

  // ── /api/tweets — admin-only ──
  if (url.pathname.startsWith('/api/tweets')) {
    if (!process.env.TWEETS_ADMIN_SECRET) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'admin disabled' }));
      return;
    }
    if (!_adminOK(url, req)) { // v98b: timing-safe + cookie support
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tweets') {
      const status = url.searchParams.get('status');
      const filtered = status ? tweetQueue.filter(t => t.status === status) : tweetQueue;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // v93l: xEnabled tells the dashboard whether to show the real "Post to X" button.
      // v99j: autopost = auto-fire toggle state for the dashboard button.
      res.end(JSON.stringify({ tweets: filtered, xEnabled: xposter.isXEnabled(), autopost: _autopostOn }));
      return;
    }
    // v99j: auto-fire toggle (admin-gated by the surrounding /api/tweets block).
    if (req.method === 'POST' && url.pathname === '/api/tweets/autopost') {
      let body = '';
      req.on('data', c => { body += c.toString(); if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        try { _setAutopost(!!JSON.parse(body || '{}').on); } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ autopost: _autopostOn }));
      });
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
    // v93l: real post to X (manual-approve). Uploads media (if any) then tweets,
    // marks the draft posted, and records the resulting tweet URL.
    const postxMatch = url.pathname.match(/^\/api\/tweets\/([a-z0-9]+)\/postx$/);
    if (req.method === 'POST' && postxMatch) {
      const id = postxMatch[1];
      let body = '';
      req.on('data', c => { body += c.toString(); if (body.length > 8192) req.destroy(); });
      req.on('end', async () => {
        const t = tweetQueue.find(x => x.id === id);
        if (!t) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        if (!xposter.isXEnabled()) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'X API not configured on the server' }));
          return;
        }
        try {
          const data = body ? JSON.parse(body) : {};
          // Honour any in-dashboard text edit; fall back to the stored draft text.
          const text = (data.text != null ? String(data.text) : t.text);
          const result = await xposter.postToX({ text, imageUrl: t.imageUrl });
          t.status    = 'posted';
          t.text      = String(text).slice(0, 280);
          t.postedUrl = result.url || null;
          t.postedAt  = Date.now();
          saveTweetQueue();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tweet: t, result }));
        } catch (e) {
          console.error('[Tweets] postx failed:', e && e.message ? e.message : e);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (e && e.message) ? e.message : String(e) }));
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

  // ── v138a: /api/playable — cached list of playable nations for the INSTANT welcome
  // picker. {id, name, a2 flag code, fallen}. Lets the client render the full country
  // list before the heavy map finishes mounting. Refreshed every 20s; gzipped.
  if (url.pathname === '/api/playable') {
    const now = Date.now();
    if (!_playableListCache || now - _playableListAt > 20000) {
      const list = [];
      for (const id of Object.keys(countryNames || {})) {
        if (!_isPlayableNation(id)) continue;
        list.push({ id: String(id), name: countryNames[id], a2: _isoNumericToA2(id), fallen: permanentlyConquered.has(String(id)) });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      _playableListCache = list; _playableListAt = now;
    }
    const body = JSON.stringify(_playableListCache);
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      try {
        const gz = require('zlib').gzipSync(body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=20', 'Access-Control-Allow-Origin': '*' });
        res.end(gz); return;
      } catch (e) { /* fall through to plain */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20', 'Access-Control-Allow-Origin': '*' });
    res.end(body); return;
  }

  // ── /api/world-state — public summary for the welcome popup ──
  if (url.pathname === '/api/world-state') {
    // Top 3 countries by total claimed pixel count.
    // v93y (task 4): only real, named countries on the leaderboard — exclude
    // unnamed Natural Earth features (no name / "Country NNN" / "Disputed
    // Territory"), which otherwise surfaced as e.g. "Country 168".
    const topCountries = Object.entries(countryPxCount)
      .filter(([id, cnt]) => {
        if (cnt <= 0) return false;
        const nm = countryNames[id];
        return nm && !/^Country \d+$/.test(nm) && nm !== 'Disputed Territory';
      })
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([id, count]) => ({ id, count, name: countryNames[id] }));
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
    // v97c: meaningful country counts. The old "totalCountries" counted ALL geos
    // (238, incl. ~50 unnamed Natural Earth artifacts + landless features), so
    // "countries remain" was wildly inflated vs the picker. An ORIGINAL country =
    // a named, land-having, playable nation. It's STANDING until its homeland is
    // permanentlyConquered (fallen). standing + fallen = originalTotal.
    const _pc = _playableCountryStats();
    res.end(JSON.stringify({
      topCountries,
      conqueredCount:  distinctConquered.size,
      totalCountries:  _totalCountries(), // v62: legacy raw-geo total (kept for compat)
      originalTotal:     _pc.total,    // v97c: real playable nations at world start
      originalStanding:  _pc.standing, // v97c: nations not yet conquered (matches picker)
      originalConquered: _pc.fallen,   // v97c: nations whose homeland has fallen
      warNumber:         _warNumber,   // v97h: which PixelAnnex War (game #) this is
      topPlayers,
      totalPlayers:    realHumans + activeBots,
      totalBots:       activeBots,
    }));
    return;
  }

  // ── /api/admin/force-win — end game now, winner by pixel count ─────
  // Protected by the same TWEETS_ADMIN_SECRET used for the tweet panel.
  if (url.pathname === '/api/admin/force-win' && req.method === 'POST') {
    if (!_adminOK(url, req)) { // v98b: timing-safe + cookie support
      res.writeHead(process.env.TWEETS_ADMIN_SECRET ? 401 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: process.env.TWEETS_ADMIN_SECRET ? 'unauthorized' : 'admin disabled' }));
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
    const topContributors = _sessionLeaderboard(5).map(s => ({ // v97
      username: s.username, avatar: s.avatar, pixels: s.pixels, conquests: s.conquests, country: s.country,
    }));
    console.log('[Admin] force-win triggered — winner by pixel count:', topCountriesByPx[0]?.name || '?');
    // v61: store payload so late-joiners/refreshers see the same screen
    _worldConquestPayload = { type: 'world_conquest', conquered, total, topCountries: topCountriesByPx, topPlayers, topContributors, resetAt: _worldResetAt, forceWin: true };
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

  // ── /api/stats/leaderboard — top 20 by pixels (public) ──
  // v97: ?scope=session → current-round stats (in-memory); else all-time (profiles).
  // Each row carries pixels + conquests so the client can show both columns + tabs.
  if (url.pathname === '/api/stats/leaderboard') {
    const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'alltime';
    // Normalise both sources into { discordId, username, avatar, pixels, conquests, country, gameRank }
    let allRanked;
    if (scope === 'session') {
      allRanked = _sessionLeaderboard(1000).map(s => ({
        discordId: s.discordId, username: s.username, avatar: s.avatar,
        pixels: s.pixels || 0, conquests: s.conquests || 0,
        points: s.pixels || 0, country: s.country, gameRank: null,
      }));
    } else {
      allRanked = [...profiles.values()]
        .filter(p => p.username && !p.isBot && ((p.pixelsPlaced > 0) || (p.conquestsMade > 0) || (p.points > 0)))
        .map(p => ({
          discordId: p.discordId, username: p.username, avatar: p.avatar,
          pixels: p.pixelsPlaced || 0, conquests: p.conquestsMade || 0,
          points: p.points || 0, country: p.countryMain, gameRank: p.rank,
        }))
        .sort((a, b) => (b.pixels - a.pixels) || (b.conquests - a.conquests));
    }
    const sorted = allRanked.slice(0, 20).map((p, i) => ({
      rank:            i + 1,
      username:        p.username,
      avatar:          p.avatar,
      pixels:          p.pixels,
      conquests:       p.conquests,
      points:          p.points,
      gameRank:        p.gameRank,
      countryMain:     p.country,
      countryMainName: p.country ? (countryNames[p.country] || ('Country ' + p.country)) : null,
    }));
    // v35: if caller supplies discord_id, include their rank position even when below top-20
    const viewerDiscordId = url.searchParams.get('discord_id');
    let viewer = null;
    if (viewerDiscordId) {
      const idx = allRanked.findIndex(p => p.discordId === viewerDiscordId);
      if (idx >= 0) {
        const p = allRanked[idx];
        viewer = {
          rank: idx + 1, username: p.username, avatar: p.avatar,
          pixels: p.pixels, conquests: p.conquests, gameRank: p.gameRank,
          inTop20: idx < 20,
        };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leaderboard: sorted, totalPlayers: allRanked.length, viewer, scope }));
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

  // ── v92n: /api/debug/timelapse — capture status + on-demand GIF assembly ──
  //   /api/debug/timelapse            → status JSON (mode, frame counts, window)
  //   /api/debug/timelapse?assemble=1 → assemble current window into a GIF now
  if (url.pathname === '/api/debug/timelapse') {
    const inWindow = _timelapseFramesInWindow();
    if (url.searchParams.get('assemble')) {
      const gifUrl = await assembleTimelapseGif();
      res.writeHead(gifUrl ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ assembled: !!gifUrl, url: gifUrl, framesUsed: inWindow.length }, null, 2));
      return;
    }
    let framesOnDisk = 0;
    try { framesOnDisk = fs.readdirSync(TIMELAPSE_DIR).filter(f => f.startsWith('tl_') && f.endsWith('.png')).length; } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mode: TIMELAPSE_TEST ? 'TEST' : 'PROD',
      frameIntervalSec: TL_FRAME_MS / 1000,
      windowMin: TL_WINDOW_MS / 60000,
      gifFps: TL_GIF_FPS,
      gifColors: TL_GIF_COLORS,
      outputSize: TL_OUT_W + 'x' + TL_OUT_H,
      framesOnDisk,
      framesInWindow: inWindow.length,
      windowStart: new Date(Math.max(Date.now() - TL_WINDOW_MS, _timelapseRoundStart)).toISOString(),
      serverStart: new Date(_serverStartMs).toISOString(),
      hint: 'GET ?assemble=1 to build a GIF from the current window now',
    }, null, 2));
    return;
  }

  // ── v92i: /api/debug/country — per-country occupation breakdown ──
  // Answers "why hasn't X fallen?". Public read-only (no secrets exposed).
  //   /api/debug/country?id=383      (numeric country ID)
  //   /api/debug/country?name=kosovo (case-insensitive substring)
  if (url.pathname === '/api/debug/country') {
    // v92j: ?list=1 dumps every geo that has pixels (id, name, total) so you can
    // discover valid IDs/names without guessing.
    if (url.searchParams.get('list')) {
      const list = Object.keys(geoTotal)
        .map(g => ({ id: +g, name: _countryName(g), totalPixels: geoTotal[g] || 0 }))
        .filter(c => c.totalPixels > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: list.length, countries: list }, null, 2));
      return;
    }
    let geo = null;
    const idParam = url.searchParams.get('id');
    const nameParam = (url.searchParams.get('name') || '').toLowerCase().trim();
    if (idParam) {
      geo = parseInt(idParam, 10);
    } else if (nameParam) {
      // v92j: search ALL geos that have pixels (countryNames may lack an entry),
      // collect every substring match so we can disambiguate / report candidates.
      const matches = [];
      for (const g of Object.keys(geoTotal)) {
        if (!(geoTotal[g] > 0)) continue;
        const nm = _countryName(g);
        if (nm.toLowerCase().includes(nameParam)) matches.push({ id: +g, name: nm });
      }
      if (matches.length === 1) {
        geo = matches[0].id;
      } else if (matches.length > 1) {
        res.writeHead(300, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ambiguous name — multiple matches', matches }, null, 2));
        return;
      }
      // matches.length === 0 → fall through to the not-found handler below
    }
    if (geo == null || Number.isNaN(geo)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: nameParam ? ('no country with pixels matches "' + nameParam + '"') : 'pass ?id=<numeric>, ?name=<substring>, or ?list=1',
        hint: 'GET /api/debug/country?list=1 to see all valid countries',
      }, null, 2));
      return;
    }
    const geoIdStr = String(geo);
    const total = geoTotal[geo] || 0;
    const claims = geoClaimCnt[geo] || {};
    // Build per-holder breakdown (raw painted counts + alliance-combined)
    const holders = [];
    let nativeCnt = 0, champId = null, champOwned = 0;
    for (const cId in claims) {
      const raw = claims[cId] || 0;
      if (raw <= 0) continue;
      const isNative = (cId === geoIdStr);
      if (isNative) nativeCnt = raw;
      const allyOwned = getAllyOwnedCount(geo, cId);
      holders.push({
        id: cId, name: _countryName(cId), native: isNative,
        pixels: raw, pct: total ? +(raw / total * 100).toFixed(1) : 0,
        allyCombined: allyOwned, allyPct: total ? +(allyOwned / total * 100).toFixed(1) : 0,
        notable: isNotableCountry(cId),
      });
      if (!isNative && allyOwned > champOwned) { champOwned = allyOwned; champId = cId; }
    }
    holders.sort((a, b) => b.pixels - a.pixels);
    const foreignSum = holders.filter(h => !h.native).reduce((s, h) => s + h.pixels, 0);
    const foreignHolders = holders.filter(h => !h.native && h.pixels > 0).length;
    const cThresh = conquestThreshold(total);
    const immuneUntil = _conquestImmunity.get(geoIdStr) || 0;
    const isConquered = [...conqueredSet].some(k => String(k).split(':')[0] === geoIdStr);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      geoId: geo,
      name: _countryName(geoIdStr),
      totalPixels: total,
      sizeClass: total <= 1500 ? 'S' : total <= 8000 ? 'M' : total <= 30000 ? 'L' : 'XL',
      conquered: isConquered,
      permanentlyConquered: permanentlyConquered.has(geoIdStr),
      immuneForMs: Math.max(0, immuneUntil - Date.now()),
      thresholds: {
        conquestPct: +(cThresh * 100).toFixed(1),         // champion path: ally-combined of TOTAL
        reversalPct: +(reversalThreshold(total) * 100).toFixed(1),
        contestFloorPct: CONTEST_FLOOR * 100,              // v93h contested path
        contestMajorityPct: CONTEST_MAJORITY * 100,
        decisiveTotalPct: CONTEST_TOTAL_FRAC * 100,
        // v93p (#1): empire-backed defense
        empireOutposts: (() => { let n = 0; for (const k of conqueredSet) if (String(k).split(':')[1] === geoIdStr) n++; return n; })(),
        empireBonusPct: +(empireDefenseBonus(geoIdStr) * 100).toFixed(1),
        effectiveConquestPct: +(Math.min(EMPIRE_DEF_CEIL, cThresh + empireDefenseBonus(geoIdStr)) * 100).toFixed(1),
      },
      champion: champId ? {
        id: champId, name: _countryName(champId),
        allyCombined: champOwned, allyPct: total ? +(champOwned / total * 100).toFixed(1) : 0,
        wouldConquer: total ? (champOwned / total >= cThresh) : false,
      } : null,
      // v93h: contested-territory fall diagnostics (matches the live logic).
      contested: (() => {
        const painted = foreignSum + nativeCnt;
        const topForeign = holders.find(h => !h.native && h.pixels > 0);
        const topCnt = topForeign ? topForeign.pixels : 0;
        const contestedMajority = total > CONTEST_LARGE_MIN && painted > 0 && (painted / total) >= CONTEST_FLOOR && (foreignSum / painted) >= CONTEST_MAJORITY;
        const decisiveCoverage  = total ? (foreignSum / total) >= CONTEST_TOTAL_FRAC : false;
        return {
          paintedPct:          total ? +(painted / total * 100).toFixed(1) : 0,
          foreignOfPaintedPct: painted ? +(foreignSum / painted * 100).toFixed(1) : 0,
          foreignOfTotalPct:   total ? +(foreignSum / total * 100).toFixed(1) : 0,
          nativePaintedPct:    total ? +(nativeCnt / total * 100).toFixed(1) : 0,
          foreignHolders,
          topForeign:          topForeign ? { name: topForeign.name, pct: topForeign.pct } : null,
          wouldFall:           !!(topForeign && topCnt > nativeCnt && (contestedMajority || decisiveCoverage)),
        };
      })(),
      // v92k: live multi-attack tracker state for this defender (rolling window).
      multiAttack: (() => {
        const eff = Math.min(MULTI_ATTACK_MAX_PIXELS,
          Math.max(MULTI_ATTACK_MIN_PIXELS, Math.round(total * MULTI_ATTACK_MIN_FRAC)));
        const e = _multiAttackTracker.get(geo);
        const nowMs = Date.now();
        let windowPixels = 0;
        const tracked = [];
        if (e) {
          for (const [aid, info] of e.attackers) {
            if (nowMs - info.lastTs > MULTI_ATTACK_WINDOW_MS) continue;
            windowPixels += info.pixels;
            tracked.push({ id: aid, name: _countryName(aid), pixels: info.pixels,
              qualifies: info.pixels >= MULTI_ATTACK_MIN_PIXELS_PER_ATTACKER });
          }
          tracked.sort((a, b) => b.pixels - a.pixels);
        }
        const qualifying = tracked.filter(t => t.qualifies).length;
        return {
          requirements: {
            minQualifyingAttackers: MULTI_ATTACK_THRESHOLD,
            minPixelsPerAttacker: MULTI_ATTACK_MIN_PIXELS_PER_ATTACKER,
            effectivePixelFloor: eff,
            windowMs: MULTI_ATTACK_WINDOW_MS,
            cooldownMs: MULTI_ATTACK_COOLDOWN_MS,
          },
          current: {
            qualifyingAttackers: qualifying,
            windowPixels,
            cooldownRemainingMs: e ? Math.max(0, MULTI_ATTACK_COOLDOWN_MS - (nowMs - e.lastNotifyAt)) : 0,
            wouldNotify: qualifying >= MULTI_ATTACK_THRESHOLD && windowPixels >= eff,
          },
          attackers: tracked,
        };
      })(),
      // v92l: screenshot framing diagnostic — flag-centered frame vs raw bbox.
      screenshotFrame: (() => {
        const frame = _shotFrame(geo);
        const raw = geoBbox[geo];
        if (!frame) return null;
        return {
          flagCenter: { x: Math.round((frame.minX + frame.maxX) / 2), y: Math.round((frame.minY + frame.maxY) / 2) },
          frameBbox: frame,
          frameSpanPx: (frame.maxX - frame.minX),
          rawBbox: raw || null,
          rawSpanPx: raw ? Math.max(raw.maxX - raw.minX, raw.maxY - raw.minY) : null,
          flagA2: _isoNumericToA2(geo),
          flagLoaded: !!getFlagImage(_isoNumericToA2(geo)),
        };
      })(),
      holders,
    }, null, 2));
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

  // v93 (Phase 3A): /api/bot/strike — an alliance member calls a strike; broadcast
  // a rally marker ONLY to that alliance's online members (the first per-recipient
  // filtered broadcast). Body: { discordId, countryId }.
  if (url.pathname === '/api/bot/strike' && req.method === 'POST') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const discordId = String(data.discordId || '');
        const countryId = String(data.countryId || '');
        if (!discordId || !countryId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing discordId/countryId' })); return; }
        // Which coalition is this member in? Check full alliances first, then
        // nascent (forming) coalitions — a player can rally any coalition they're
        // in, not only ones that have locked in at 10 members.
        let allianceKey = null, alliance = null;
        for (const [k, a] of alliances) { if (a.members.includes(discordId)) { allianceKey = k; alliance = a; break; } }
        if (!alliance) {
          for (const [k, a] of nascentAlliances) { if ((a.members || []).includes(discordId)) { allianceKey = k; alliance = a; break; } }
        }
        if (!alliance) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not in an alliance' })); return; }
        const targetName = _countryName(countryId);
        const caller = (getProfile(discordId)?.username) || 'A commander';
        const memberSet = new Set(alliance.members.map(String));
        const payload = JSON.stringify({ type: 'strike', countryId, targetName, caller, ttl: 45000 });
        let recipients = 0;
        for (const [, p] of players) {
          if (p.isBot || !p.discordId || !p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
          if (memberSet.has(String(p.discordId))) { try { p.ws.send(payload); recipients++; } catch (e) {} }
        }
        console.log('[Strike] ' + caller + ' -> ' + targetName + ' (alliance ' + allianceKey + ', ' + recipients + ' online)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, allianceKey, countries: alliance.countries, recipients, targetName, caller }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad request' }));
      }
    });
    return;
  }

  // v93g (Phase 3B): /api/bot/surge — leader triggers Allied Surge. All checks
  // server-side: must be the alliance leader, once per 24h per alliance.
  if (url.pathname === '/api/bot/surge' && req.method === 'POST') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const discordId = String((JSON.parse(body || '{}')).discordId || '');
        if (!discordId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing discordId' })); return; }
        const al = getAllianceForDiscord(discordId);
        if (!al) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not in an alliance' })); return; }
        const leader = getAllianceLeader(al);
        if (String(leader) !== discordId) {
          const lp = profiles.get(leader);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not the leader', leaderName: (lp && lp.username) || 'the alliance leader' }));
          return;
        }
        const now = Date.now();
        const last = _allianceLastSurge[al.key] || 0;
        if (now - last < SURGE_COOLDOWN_MS) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'on cooldown', cooldownRemainingMs: SURGE_COOLDOWN_MS - (now - last) }));
          return;
        }
        // Activate.
        _allianceLastSurge[al.key] = now; _markAllianceStateDirty();
        const until = now + SURGE_MS;
        const memberSet = new Set(al.members.map(String));
        let recipients = 0;
        for (const [pid, p] of players) {
          if (p.isBot || !p.discordId || !p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
          if (memberSet.has(String(p.discordId))) {
            _surgeUntil.set(pid, until);
            recipients++;
            try { p.ws.send(JSON.stringify({ type: 'surge', until, durationMs: SURGE_MS })); } catch (e) {}
          }
        }
        const caller = (profiles.get(discordId)?.username) || 'The leader';
        console.log('[Surge] ' + caller + ' triggered for alliance ' + al.key + ' (' + recipients + ' online, +50% 5min)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, allianceKey: al.key, recipients, durationMs: SURGE_MS, vault: Math.round(_allianceVaults[al.key] || 0), caller }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad request' }));
      }
    });
    return;
  }

  // v93j: /api/bot/worldstate — world standings for the /worldstate command.
  if (url.pathname === '/api/bot/worldstate') {
    if (!validBot) { res.writeHead(403); res.end('forbidden'); return; }
    const byConqueror = {};
    for (const key of conqueredSet) {
      const parts = String(key).split(':');
      if (parts.length !== 2 || parts[0] === parts[1]) continue;
      byConqueror[parts[1]] = (byConqueror[parts[1]] || 0) + 1;
    }
    const topConquerors = Object.entries(byConqueror)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ id, name: _countryName(id), conquered: n }));
    const totalCountries = Object.keys(geoTotal).filter(g => geoTotal[g] > 0).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalConquered: permanentlyConquered.size,
      totalCountries,
      topConquerors,
      alliances: alliances.size,
      players: [...players.values()].filter(p => !p.isBot).length,
    }));
    return;
  }

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
      list.push({ key, countries: alliance.countries, members: alliance.members,
        vault: Math.round(_allianceVaults[key] || 0), leader: getAllianceLeader(alliance) }); // v93g
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

// v79: prefer real client IP when behind Cloudflare / nginx.
// Header preference order:
//   1. CF-Connecting-IP  — set by Cloudflare; always the original client
//   2. X-Real-IP         — set by our nginx config
//   3. X-Forwarded-For   — falls back to first IP in the chain
//   4. socket.remoteAddress — direct connection (only when nothing else)
function getClientIP(req) {
  const h = req.headers || {};
  if (h['cf-connecting-ip']) return h['cf-connecting-ip'];
  if (h['x-real-ip']) return h['x-real-ip'];
  const xff = h['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress;
}

// v98b: per-IP WS connection cap — a single host scripting dozens of clients
// was previously unbounded. Generous limit (multiple tabs/family NAT are fine).
const MAX_WS_PER_IP = 10;
const _wsPerIP = new Map(); // ip → live connection count

wss.on('connection', (ws, req) => {
  const pid = nextPid++;
  const ip  = getClientIP(req);
  const ipCount = (_wsPerIP.get(ip) || 0) + 1;
  if (ipCount > MAX_WS_PER_IP) {
    console.log(`[!] Connection from ${ip} rejected — ${ipCount - 1} already open`);
    try { ws.close(1013, 'too many connections'); } catch (e) {}
    return;
  }
  _wsPerIP.set(ip, ipCount);
  console.log(`[+] Player ${pid} connected from ${ip}`);

  const player = { ws, countryId: null, countryIdx: -1, lastSeen: Date.now(), isBot: false, viewport: null };
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

    // v93n: hardening — a throw in any single case used to crash the whole
    // process (PM2 restart → in-memory map wiped → full game reset). Wrap the
    // switch so one bad message just logs and drops instead of nuking the world.
    try {
    switch (msg.type) {

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      // v92p: client reports its visible map rect (with overscan). null/full =
      // wants the whole broadcast. On a windowed update we send a one-shot region
      // snapshot so any stale off-screen state now in view is corrected.
      case 'viewport': {
        if (!VIEWPORT_FILTER_ENABLED) break;
        if (msg.full) { player.viewport = null; break; }
        let minX = msg.minX | 0, minY = msg.minY | 0, maxX = msg.maxX | 0, maxY = msg.maxY | 0;
        minX = Math.max(0, Math.min(MAP_W - 1, minX));
        maxX = Math.max(0, Math.min(MAP_W - 1, maxX));
        minY = Math.max(0, Math.min(MAP_H - 1, minY));
        maxY = Math.max(0, Math.min(MAP_H - 1, maxY));
        if (maxX < minX || maxY < minY) break;
        if ((maxX - minX + 1) * (maxY - minY + 1) >= VIEWPORT_MAX_FILTER_AREA) {
          // v93v: rect too big to filter → full stream. CRITICAL: still reconcile
          // the visible rect first. While previously windowed, off-rect changes
          // were filtered out, so the client has drifted (e.g. Italy showing a
          // stale owner). Switching to full stream only fixes FUTURE deltas — the
          // existing drift is never resynced without this snapshot.
          player.viewport = null;
          sendRegionSnapshot(player, minX, minY, maxX, maxY);
          break;
        }
        player.viewport = { minX, minY, maxX, maxY };
        sendRegionSnapshot(player, minX, minY, maxX, maxY);
        break;
      }

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
        // v98b SECURITY: client-sent geoNames are IGNORED. Names load from
        // countries-10m.json at boot (loadCountryNamesFromDisk) — previously any
        // client could wholesale rename every country server-wide, and those
        // names flowed into tweets/Discord/the admin dashboard.
        if (msg.geoNames && Object.keys(msg.geoNames).length > 0) {
          console.log(`  geoNames: ignored ${Object.keys(msg.geoNames).length} client-sent names (server loads from disk)`);
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
          // v93x: geoAtPixel is now available — rebuild geoClaimCnt from the
          // restored board so the conquest check sees real occupation.
          if (_boardRestoredPendingRebuild) {
            _rebuildGeoClaimCnt();
            _boardRestoredPendingRebuild = false;
          }
        }
        if (msg.landRuns) {
          landMask.fill(0);
          for (const { s, l } of msg.landRuns) {
            for (let i = s; i < s + l && i < MAP_PX; i++) landMask[i] = 1;
          }
        }
        // v88: cache country colours (numeric id → hex) for tweet screenshots
        if (msg.geoColors && typeof msg.geoColors === 'object') {
          for (const k of Object.keys(msg.geoColors)) geoColorsById[k] = msg.geoColors[k];
        }
        checkMapReady();

        // v98b: playability gate, evaluated AFTER this join's map data is
        // ingested (geoTotal may have been empty before it on a fresh boot).
        // Don't reject the join (the client would hang with no welcome) —
        // strip the country (strokes already no-op on a null countryId) and
        // force the client's re-pick modal right after the welcome below.
        let _forceRepickId = null;
        if (player.countryId && !_isPlayableCountry(player.countryId)) {
          console.log('[v98b] join with unplayable country', player.countryId, '— forcing re-pick');
          _forceRepickId = player.countryId;
          player.countryId = null;
        }

        // v92s: split the snapshot — welcome JSON carries the small metadata
        // (conquered set + player list); the heavy claimed-pixel runs go in a
        // separate compact binary frame (tag=3) sent right after.
        const _snap = buildSnapshot();
        ws.send(JSON.stringify({
          type: 'welcome',
          playerId: pid,
          botIds: [...bots.keys()],
          state: { conquered: _snap.conquered, players: _snap.players, sieged: _snap.sieged, permanentlyConquered: _snap.permanentlyConquered }, // v95o: include dead natives for client "Fallen"/grey-out
          david: buildDavidSnapshot(),
          serverVersion: SERVER_VERSION,
          nukeZones: (_pruneServerNukeZones(), _nukeZones.slice()),
          endgame: _endgamePayload || _computeEndgame(), // v100: sudden death + panel for late-joiners
          emotes: _buildActiveEmotes(), // v113: active conquest emotes for late-joiners
        }));
        try { ws.send(encodeSnapshotRuns(_snap.runs)); } catch (e) {}
        // v98b: stale unplayable country (e.g. Vatican in localStorage) → open
        // the client's re-pick modal via the existing your_country_lost flow.
        if (_forceRepickId) {
          try { ws.send(JSON.stringify({ type: 'your_country_lost', lostCountryId: _forceRepickId, attackerId: null, mercenaryBonus: 0, keep: null })); } catch (e) {}
        }
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
        if (!_isPlayableCountry(cid)) { console.log('[v98b] Rejected set-country for', cid, '(not playable: micro/unnamed/non-playable)'); break; }
        if (countryNames && countryNames[cid] && hasPixels) {
          // v93n: was `p.` — `p` is undefined in this scope (the player var is
          // `player`). This threw ReferenceError and CRASHED the whole server
          // every time a player re-picked after their country fell, wiping the
          // in-memory map (= full game reset). Use `player`.
          player.countryId = cid;
          player.countryIdx = getIdx(cid);
          if (!ownerPixels[player.countryIdx]) ownerPixels[player.countryIdx] = new Set();
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
        // v98: track pixels THIS stroke actually flipped to own — encirclement
        // detection opens exactly these in its "without the stroke" BFS pass,
        // so repainting your own wall can never re-trigger the bonus.
        if (changed.length) {
          if (!player._strokeChanged) player._strokeChanged = new Set();
          if (player._strokeChanged.size < 20000)
            for (const px of changed) player._strokeChanged.add(px.y * MAP_W + px.x);
        }
        // Award XP and stats to logged-in players
        if (player.discordId && changed.length) {
          updateProfileXP(player.discordId, changed.length);
          // Track stats
          const profile = getProfile(player.discordId);
          profile.points       += changed.length;
          profile.pixelsPlaced += changed.length;
          profile.lastSeen     =  Date.now();
          _recordSession(player.discordId, profile.username, profile.avatar, player.countryId, changed.length, 0); // v97
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
          _recordSession(player.discordId, profile.username, profile.avatar, player.countryId, 0, conquests.length); // v97
          markProfilesDirty();
        }
        break;
      }

      case 'stroke-end': {
        // Sent by client on mouseup/touchend with the full stroke buffer.
        // Pixels have ALREADY been applied via per-pixel 'stroke' events.
        // We only run encirclement detection here.
        if (!player.countryId || !Array.isArray(msg.pixels)) return;
        // v98: consume + clear the per-stroke changed set even on early returns.
        const strokeChanged = player._strokeChanged;
        player._strokeChanged = null;
        if (msg.pixels.length < 1 || msg.pixels.length > 5000) return; // v68: ≥1 (was ≥4)
        const enc = detectEncirclement(msg.pixels, player.countryId, strokeChanged);
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
          _recordSession(player.discordId, _ep.username, _ep.avatar, player.countryId, 0, encConquests.length); // v97
          markProfilesDirty();
        }
        const bonus = getEncircleBonus(enc.count);
        // v98: ratchet — an overlapping smaller encirclement must not downgrade
        // an active higher multiplier (mirrors the client's v93y rule). The
        // timer still refreshes: this is a GENUINE new encirclement (the v98
        // newly-enclosed-only detection killed the spurious re-triggers).
        {
          const _prev = encircleBonuses.get(String(player.countryId));
          const _mult = (_prev && _prev.expiresAt > Date.now()) ? Math.max(_prev.mult, bonus.mult) : bonus.mult;
          encircleBonuses.set(String(player.countryId), {
            mult:      _mult,
            expiresAt: Date.now() + bonus.durationMs,
          });
        }
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

      // v87: rally call — Lieutenant+ asks for help on a country. Throttled
      // per-player to one notification per 60s. Emits a Discord 'rally_call'.
      case 'rally': {
        const rallyCountryId = msg.countryId ? String(msg.countryId) : null;
        if (!rallyCountryId) break;
        const nowR = Date.now();
        const lastR = _rallyLastByPid.get(pid) || 0;
        if (nowR - lastR < 600000) break; // v99a: 10min per-player cooldown (was 60s), matches client RALLY_COOLDOWN_MS
        _rallyLastByPid.set(pid, nowR);
        const whoName = (player.discordId && getProfile(player.discordId)?.username)
          || ('A ' + (player.countryId ? _countryName(player.countryId) : 'player') + ' commander');
        const targetName = _countryName(rallyCountryId);
        emitBotEvent({
          type:          'rally_call',
          tier:          2,
          caller:        whoName,
          callerCountry: player.countryId || null,
          targetId:      rallyCountryId,
          targetName,
          timestamp:     nowR,
          sassyText:     '📣 ' + whoName + ' needs reinforcements on the front lines of ' + targetName + '! Deploy your pixels: ' + GAME_URL,
        });
        break;
      }
      case 'emote': {
        // v113: a conqueror attaches an emoji above a country they hold. Validate
        // the emoji is in the allowed set and that this player actually holds the
        // geo (its conqueror), then relay globally + remember for late-joiners.
        const emGeo = msg.geoIdx != null ? String(msg.geoIdx) : null;
        const emWho = msg.countryId != null ? String(msg.countryId) : null;
        const emoji = typeof msg.emoji === 'string' ? msg.emoji : null;
        if (!emGeo || !emWho || !emoji) break;
        if (!EMOTE_SET.has(emoji)) break;                          // unknown emoji → ignore
        if (emWho !== String(player.countryId || '')) break;       // must speak for your own country
        if (!conqueredSet.has(emGeo + ':' + emWho)) break;         // must currently hold the geo
        const until = Date.now() + EMOTE_TTL_MS;
        _emoteByGeo.set(emGeo, { emoji, countryId: emWho, until });
        broadcast(JSON.stringify({ type: 'emote', geoIdx: emGeo, emoji, until }));
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
          // v97: contain the blast to the single nation the nuke lands on.
          const centerGeo = geoAtPixel[cy * MAP_W + cx];
          _nukeZones.push({ cx, cy, radius, expiresAt, geo: centerGeo });
          const changed = clearPixelsInRadius(cx, cy, radius, centerGeo);
          if (changed.length) queueDelta(changed);
          // v94b: a nuke can wipe a conquered country to zero held pixels — reverse
          // those conquests (so the flag disappears) and refresh siege state.
          if (changed.length) {
            const _affGeos = new Set();
            for (const c of changed) { const g = geoAtPixel[c.y * MAP_W + c.x]; if (g >= 0) _affGeos.add(g); }
            for (const g of _affGeos) { _reverseConquestsForGeo(g); checkSiegeState(g); }
          }
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
              countries:   [player.countryId], // v84
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
    } catch (e) { console.error('[WS] handler error for type', (msg && msg.type), '-', (e && e.stack) || e); }
  });

  ws.on('close', () => {
    clearInterval(keepalive);
    players.delete(pid);
    // v98b: release the per-IP connection slot
    const c = (_wsPerIP.get(ip) || 1) - 1;
    if (c <= 0) _wsPerIP.delete(ip); else _wsPerIP.set(ip, c);
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
