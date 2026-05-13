/**
 * PixelAnnex Discord Bot
 * ======================
 * Run separately from the game server:
 *   node bot.js
 *
 * Required env vars (.env):
 *   DISCORD_BOT_TOKEN      — bot token from Developer Portal
 *   DISCORD_CLIENT_ID      — application ID (same as OAuth client ID)
 *   DISCORD_GUILD_ID       — your PixelAnnex server ID
 *   GAME_SERVER_URL        — e.g. http://localhost:3000
 *   BOT_API_SECRET         — shared secret for bot ↔ game server auth
 *
 * Slash commands (run register-commands.js once after changes):
 *   /country set <main> [allegiance_b] [allegiance_c]
 *   /country show
 *   /country clear
 */

'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const fetch = global.fetch || require('node-fetch');

// ── Config ────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const GAME_URL       = process.env.GAME_SERVER_URL || 'http://localhost:3000';
const BOT_SECRET     = process.env.BOT_API_SECRET || '';

if (!TOKEN || !GUILD_ID) {
  console.error('[Bot] Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID in .env');
  process.exit(1);
}

// ── Country list — must match game's DB ───────────────────────────
// In a future iteration this can be fetched from the game server via /api/bot/countries
// For now we hardcode the major countries that bots play as
const COUNTRIES = [
  // Major countries (alphabetical)
  { id: '4',   name: 'Afghanistan' }, { id: '8',   name: 'Albania' },
  { id: '12',  name: 'Algeria' },     { id: '32',  name: 'Argentina' },
  { id: '36',  name: 'Australia' },   { id: '40',  name: 'Austria' },
  { id: '50',  name: 'Bangladesh' },  { id: '56',  name: 'Belgium' },
  { id: '76',  name: 'Brazil' },      { id: '100', name: 'Bulgaria' },
  { id: '124', name: 'Canada' },      { id: '152', name: 'Chile' },
  { id: '156', name: 'China' },       { id: '170', name: 'Colombia' },
  { id: '203', name: 'Czech Rep.' },  { id: '208', name: 'Denmark' },
  { id: '218', name: 'Ecuador' },     { id: '231', name: 'Ethiopia' },
  { id: '246', name: 'Finland' },     { id: '250', name: 'France' },
  { id: '276', name: 'Germany' },     { id: '300', name: 'Greece' },
  { id: '348', name: 'Hungary' },     { id: '356', name: 'India' },
  { id: '360', name: 'Indonesia' },   { id: '364', name: 'Iran' },
  { id: '368', name: 'Iraq' },        { id: '372', name: 'Ireland' },
  { id: '376', name: 'Israel' },      { id: '380', name: 'Italy' },
  { id: '392', name: 'Japan' },       { id: '398', name: 'Kazakhstan' },
  { id: '404', name: 'Kenya' },       { id: '410', name: 'South Korea' },
  { id: '434', name: 'Libya' },       { id: '458', name: 'Malaysia' },
  { id: '484', name: 'Mexico' },      { id: '504', name: 'Morocco' },
  { id: '524', name: 'Nepal' },       { id: '528', name: 'Netherlands' },
  { id: '554', name: 'New Zealand' }, { id: '566', name: 'Nigeria' },
  { id: '578', name: 'Norway' },      { id: '586', name: 'Pakistan' },
  { id: '604', name: 'Peru' },        { id: '608', name: 'Philippines' },
  { id: '616', name: 'Poland' },      { id: '620', name: 'Portugal' },
  { id: '642', name: 'Romania' },     { id: '643', name: 'Russia' },
  { id: '682', name: 'Saudi Arabia' },{ id: '688', name: 'Serbia' },
  { id: '702', name: 'Singapore' },   { id: '710', name: 'South Africa' },
  { id: '724', name: 'Spain' },       { id: '752', name: 'Sweden' },
  { id: '756', name: 'Switzerland' }, { id: '764', name: 'Thailand' },
  { id: '792', name: 'Turkey' },      { id: '804', name: 'Ukraine' },
  { id: '784', name: 'UAE' },         { id: '826', name: 'United Kingdom' },
  { id: '840', name: 'USA' },         { id: '858', name: 'Uruguay' },
  { id: '862', name: 'Venezuela' },   { id: '704', name: 'Vietnam' },
];

// Mutable map: starts with hardcoded fallback, gets updated from server with full list
const COUNTRY_BY_ID = Object.fromEntries(COUNTRIES.map(c => [c.id, c.name]));

// Fetch full country list from game server (called on startup + on demand)
async function refreshCountryNames() {
  try {
    const data = await gameFetch('/api/bot/countries');
    if (data.countries && data.countries.length) {
      let added = 0;
      for (const c of data.countries) {
        if (!c.name || c.name.startsWith('Country ') || c.name.startsWith('Territory ')) continue;
        // Store under both original ID (may be padded) and unpadded form
        const padded   = String(c.id);
        const unpadded = String(parseInt(padded, 10));
        if (!COUNTRY_BY_ID[padded])   { added++; }
        COUNTRY_BY_ID[padded]   = c.name;
        COUNTRY_BY_ID[unpadded] = c.name;
      }
      console.log(`[Bot] Country names refreshed (${Object.keys(COUNTRY_BY_ID).length} total, +${added} new)`);
    }
  } catch (e) {
    console.log('[Bot] Country names refresh failed:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────
async function gameFetch(path, opts = {}) {
  const res = await fetch(GAME_URL + path, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'X-Bot-Secret':  BOT_SECRET,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Game server ${path} → ${res.status}`);
  return res.json();
}

async function getProfile(discordId) {
  try {
    return await gameFetch(`/api/bot/profile?discord_id=${discordId}`);
  } catch (e) {
    console.error('[Bot] getProfile failed:', e.message);
    return null;
  }
}

async function setProfile(data) {
  return gameFetch('/api/bot/profile', { method: 'POST', body: JSON.stringify(data) });
}

// ── Discord client ────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once(Events.ClientReady, async c => {
  console.log(`[Bot] Logged in as ${c.user.tag}`);
  console.log(`[Bot] Watching guild ${GUILD_ID}`);
  // Bootstrap rank roles
  const guild = c.guilds.cache.get(GUILD_ID);
  if (guild) {
    try { await ensureRankRoles(guild); }
    catch (e) { console.error('[Bot] Failed to ensure rank roles:', e.message); }
  }
  // Refresh country names from game server (so war reporter shows real names)
  refreshCountryNames();
  // Retry every 30s — if first client hasn't connected yet, names won't be ready
  // After we have 100+ names, slow down to every 5 minutes
  const fastRefresh = setInterval(() => {
    refreshCountryNames();
    if (Object.keys(COUNTRY_BY_ID).length > 100) {
      clearInterval(fastRefresh);
      setInterval(refreshCountryNames, 5 * 60 * 1000);
    }
  }, 30 * 1000);
  // Connect to game event stream
  connectEventStream();
});

// ── Slash command handler ─────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
    return;
  }
  if (interaction.commandName !== 'country') return;

  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  try {
    if (sub === 'set') {
      const main = interaction.options.getString('main');
      const b    = interaction.options.getString('allegiance_b');
      const c    = interaction.options.getString('allegiance_c');

      if (!COUNTRY_BY_ID[main]) {
        await interaction.reply({ content: `❌ Unknown country: ${main}`, ephemeral: true });
        return;
      }
      if (b && !COUNTRY_BY_ID[b]) {
        await interaction.reply({ content: `❌ Unknown allegiance B: ${b}`, ephemeral: true });
        return;
      }
      if (c && !COUNTRY_BY_ID[c]) {
        await interaction.reply({ content: `❌ Unknown allegiance C: ${c}`, ephemeral: true });
        return;
      }

      // Update profile on game server
      const result = await setProfile({
        discordId:   userId,
        username:    interaction.user.username,
        countryMain: main,
        countryB:    b || null,
        countryC:    c || null,
      });

      const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle('🌍 Country preferences updated')
        .addFields(
          { name: '🏠 Main',          value: COUNTRY_BY_ID[main],                inline: true },
          { name: '🤝 Allegiance B',  value: b ? COUNTRY_BY_ID[b] : '—',         inline: true },
          { name: '🤝 Allegiance C',  value: c ? COUNTRY_BY_ID[c] : '—',         inline: true },
        )
        .setFooter({ text: 'Alliances form when 3+ players share preferences' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === 'show') {
      const profile = await getProfile(userId);
      if (!profile) {
        await interaction.reply({ content: 'You haven\'t set any countries yet. Use `/country set` to begin.', ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle('🌍 Your country preferences')
        .addFields(
          { name: '🏠 Main',          value: profile.countryMain ? COUNTRY_BY_ID[profile.countryMain] || profile.countryMain : '—',  inline: true },
          { name: '🤝 Allegiance B',  value: profile.countryB    ? COUNTRY_BY_ID[profile.countryB]    || profile.countryB    : '—',  inline: true },
          { name: '🤝 Allegiance C',  value: profile.countryC    ? COUNTRY_BY_ID[profile.countryC]    || profile.countryC    : '—',  inline: true },
          { name: '🎖️ Rank',          value: profile.rank || 'Soldier',                                                               inline: true },
          { name: '⭐ XP',             value: String(profile.xp || 0),                                                                 inline: true },
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === 'clear') {
      await setProfile({ discordId: userId, countryMain: null, countryB: null, countryC: null });
      await interaction.reply({ content: '✅ Country preferences cleared.', ephemeral: true });
      return;
    }
  } catch (e) {
    console.error('[Bot] Command error:', e);
    await interaction.reply({ content: '❌ Error updating preferences. Is the game server running?', ephemeral: true });
  }
});

// ── Autocomplete handler — fuzzy search through countries ────────
async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'country') return;
  const focused = interaction.options.getFocused().toLowerCase();
  // Build list from COUNTRY_BY_ID (populated from server). De-duplicate so
  // padded/unpadded variants don't both appear.
  const seen = new Set();
  const matches = [];
  for (const [id, name] of Object.entries(COUNTRY_BY_ID)) {
    if (seen.has(name)) continue;
    if (!name.toLowerCase().includes(focused)) continue;
    seen.add(name);
    matches.push({ name, value: String(parseInt(id, 10)) }); // value uses unpadded form
    if (matches.length >= 25) break;
  }
  await interaction.respond(matches);
}


// ── Rank role configuration ──────────────────────────────────────
// These roles are auto-created on bot startup if missing.
const RANK_ROLES = [
  { name: 'Lieutenant', color: 0x60a5fa, hoist: false },  // light blue
  { name: 'Captain',    color: 0x34d399, hoist: false },  // green
  { name: 'General',    color: 0xfbbf24, hoist: false },  // gold
  { name: 'Admiral',    color: 0xa855f7, hoist: true  },  // purple, hoisted
];

const _roleCache = {}; // rank name → role ID

async function ensureRankRoles(guild) {
  const existing = await guild.roles.fetch();
  for (const rankDef of RANK_ROLES) {
    let role = existing.find(r => r.name === rankDef.name);
    if (!role) {
      console.log(`[Bot] Creating rank role: ${rankDef.name}`);
      role = await guild.roles.create({
        name:    rankDef.name,
        color:   rankDef.color,
        hoist:   rankDef.hoist,
        reason:  'PixelAnnex auto-created rank role',
      });
    }
    _roleCache[rankDef.name] = role.id;
  }
  console.log(`[Bot] Rank roles ready: ${Object.keys(_roleCache).join(', ')}`);
}

async function syncMemberRank(discordId, newRank) {
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      console.log(`[Rank] Member ${discordId} not in guild — skipping`);
      return;
    }
    // Remove all rank roles first, then add the new one (if not Soldier)
    for (const rankDef of RANK_ROLES) {
      const roleId = _roleCache[rankDef.name];
      if (!roleId) continue;
      if (rankDef.name === newRank) continue; // we'll add this one
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, 'PixelAnnex rank update');
      }
    }
    if (newRank !== 'Soldier' && _roleCache[newRank]) {
      await member.roles.add(_roleCache[newRank], 'PixelAnnex rank promotion');
      console.log(`[Rank] ${member.user.username} → ${newRank}`);
      // Announce promotion in the configured channel (default: #general)
      try {
        const channelName = process.env.PROMOTION_CHANNEL || 'general';
        const channel = guild.channels.cache.find(
          c => c.name === channelName && c.isTextBased()
        );
        if (channel) {
          const rankColor = RANK_ROLES.find(r => r.name === newRank)?.color || 0x6366f1;
          await channel.send({
            embeds: [{
              color: rankColor,
              description: `🎖️ <@${member.id}> has been promoted to **${newRank}**!`,
            }],
          });
        } else {
          console.log(`[Rank] Channel #${channelName} not found — promotion not announced`);
        }
      } catch (e) {
        console.error('[Rank] Promotion announce failed:', e.message);
      }
    }
  } catch (e) {
    console.error('[Rank] Sync failed:', e.message);
  }
}


// ── Alliance role management ─────────────────────────────────────
// Alliance roles are dynamically created/deleted as alliances form/dissolve.
// Naming: "Alliance: USA-Canada" (countries joined alphabetically by name).

const _allianceRoleCache = {}; // alliance_key → role ID

function buildAllianceName(countryIds) {
  const names = countryIds.map(id => COUNTRY_BY_ID[id] || ('Country ' + id));
  // Cap displayed name to 3 countries for readability — show count if more
  if (names.length <= 3) return 'Alliance: ' + names.join('-');
  return 'Alliance: ' + names.slice(0, 3).join('-') + ' +' + (names.length - 3);
}

async function createOrUpdateAllianceRole(guild, key, countryIds, members) {
  const roleName = buildAllianceName(countryIds);

  // Find existing role by stored ID, or by name
  let role = _allianceRoleCache[key]
    ? guild.roles.cache.get(_allianceRoleCache[key])
    : guild.roles.cache.find(r => r.name === roleName);

  if (!role) {
    try {
      role = await guild.roles.create({
        name:   roleName,
        color:  0x6366f1, // indigo — distinctive from rank colours
        hoist:  false,
        mentionable: true,
        reason: 'PixelAnnex auto-created alliance role',
      });
      console.log(`[Alliance] Created role: ${roleName}`);
    } catch (e) {
      console.error('[Alliance] Failed to create role:', e.message);
      return null;
    }
  } else if (role.name !== roleName) {
    try {
      await role.setName(roleName, 'PixelAnnex alliance update');
      console.log(`[Alliance] Renamed role to: ${roleName}`);
    } catch (e) {
      console.error('[Alliance] Failed to rename:', e.message);
    }
  }

  _allianceRoleCache[key] = role.id;

  // Sync members — add the role to all alliance members
  for (const memberId of members) {
    try {
      const m = await guild.members.fetch(memberId).catch(() => null);
      if (m && !m.roles.cache.has(role.id)) {
        await m.roles.add(role.id, 'PixelAnnex alliance membership');
      }
    } catch (e) { /* member may have left — silent */ }
  }

  // Remove the role from anyone who has it but isn't a member
  const memberSet = new Set(members);
  for (const m of role.members.values()) {
    if (!memberSet.has(m.id)) {
      try {
        await m.roles.remove(role.id, 'PixelAnnex alliance update');
      } catch (e) { /* silent */ }
    }
  }

  return role;
}

async function dissolveAllianceRole(guild, key) {
  const roleId = _allianceRoleCache[key];
  if (!roleId) return;
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    delete _allianceRoleCache[key];
    return;
  }
  try {
    await role.delete('PixelAnnex alliance dissolved');
    console.log(`[Alliance] Deleted role: ${role.name}`);
  } catch (e) {
    console.error('[Alliance] Failed to delete role:', e.message);
  }
  delete _allianceRoleCache[key];
}

async function announceAlliance(guild, type, key, countryIds, extra) {
  const channelName = process.env.ALLIANCE_CHANNEL || process.env.PROMOTION_CHANNEL || 'general';
  const channel = guild.channels.cache.find(c => c.name === channelName && c.isTextBased());
  if (!channel) {
    console.log(`[Alliance] Channel #${channelName} not found — not announced`);
    return;
  }
  const names = countryIds.map(id => COUNTRY_BY_ID[id] || ('Country ' + id));
  let description, color;

  if (type === 'formed') {
    description = `🤝 **New alliance formed!**\n${names.join(' + ')}\n${extra.memberCount} members united.`;
    color = 0x22c55e; // green
  } else if (type === 'dissolved') {
    description = `💔 **Alliance dissolved**\n${names.join(' + ')}\nMember count fell below threshold.`;
    color = 0xef4444; // red
  } else if (type === 'grew') {
    description = `🌱 **Alliance growing**\n${names.join(' + ')}\nNow ${extra.memberCount} members strong.`;
    color = 0x3b82f6; // blue
  } else return;

  try {
    await channel.send({ embeds: [{ color, description }] });
  } catch (e) {
    console.error('[Alliance] Announce failed:', e.message);
  }
}

// ── SSE event listener ───────────────────────────────────────────
let _sseRetryDelay = 1000;
async function connectEventStream() {
  try {
    const res = await fetch(GAME_URL + '/api/bot/events', {
      headers: { 'X-Bot-Secret': BOT_SECRET },
    });
    if (!res.ok) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }
    console.log('[Bot] Event stream connected');
    _sseRetryDelay = 1000;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // keep incomplete chunk
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          handleGameEvent(event);
        } catch (e) {
          console.error('[Bot] Bad event JSON:', line);
        }
      }
    }
    throw new Error('Stream ended');
  } catch (e) {
    console.error('[Bot] Event stream error:', e.message);
    setTimeout(connectEventStream, _sseRetryDelay);
    _sseRetryDelay = Math.min(_sseRetryDelay * 2, 30000);
  }
}


// ── War Reporter ──────────────────────────────────────────────────
// Receives war events from the game server via SSE and posts to #war-room.
//
// Tiers:
//   1 = channel only (siege end, mortar)
//   2 = role ping     (conquest, siege start, MOAB)
//   3 = @everyone + future Twitter (nuke, full alliance collapse)
//
// Batching: events queued and flushed every 3s to respect Discord's
// 5 msg/s/channel rate limit.

const WAR_CHANNEL_NAME = process.env.WAR_CHANNEL || 'war-room';
const WAR_BATCH_INTERVAL_MS = 3000;
const WAR_MAX_PER_BATCH = 5;

let _warQueue = [];
let _warTimer = null;
let _warChannel = null; // cached channel ref

function getCountryName(id) {
  // TopoJSON IDs are zero-padded ("050"); try unpadded as fallback ("50")
  const idStr = String(id);
  const unpadded = String(parseInt(idStr, 10));
  return COUNTRY_BY_ID[idStr] || COUNTRY_BY_ID[unpadded] || ('Country ' + idStr);
}

function getCountryMention(id, guild) {
  // Returns a Discord role mention for the country's alliance, or just the name
  if (!guild) return '**' + getCountryName(id) + '**';
  // Check if this country belongs to an alliance role
  for (const [allianceKey, roleId] of Object.entries(_allianceRoleCache)) {
    if (allianceKey.split('-').includes(String(id))) {
      const role = guild.roles.cache.get(roleId);
      if (role) return '<@&' + role.id + '> (' + getCountryName(id) + ')';
    }
  }
  return '**' + getCountryName(id) + '**';
}

function queueWarEvent(event) {
  _warQueue.push(event);
  if (!_warTimer) {
    _warTimer = setTimeout(flushWarQueue, WAR_BATCH_INTERVAL_MS);
  }
}

async function flushWarQueue() {
  _warTimer = null;
  if (_warQueue.length === 0) return;

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { _warQueue = []; return; }

  // Find/cache the war channel
  if (!_warChannel || !guild.channels.cache.has(_warChannel.id)) {
    _warChannel = guild.channels.cache.find(c => c.name === WAR_CHANNEL_NAME && c.isTextBased());
    if (!_warChannel) {
      console.log(`[War] Channel #${WAR_CHANNEL_NAME} not found — events dropped`);
      _warQueue = [];
      return;
    }
  }

  // Deduplicate: if same attacker→defender event repeats within batch, keep only highest tier
  const dedup = new Map();
  for (const e of _warQueue) {
    const key = e.type + ':' + (e.attackerId || '') + ':' + (e.defenderId || '');
    const existing = dedup.get(key);
    if (!existing || (e.tier || 0) > (existing.tier || 0)) {
      dedup.set(key, e);
    }
  }
  const events = [...dedup.values()].slice(0, WAR_MAX_PER_BATCH);
  _warQueue = [];

  for (const event of events) {
    try {
      await postWarEvent(guild, event);
    } catch (e) {
      console.error('[War] Post failed:', e.message);
    }
    // Throttle: ~600ms between posts (5/s limit with safety margin)
    await new Promise(r => setTimeout(r, 600));
  }
}

async function postWarEvent(guild, event) {
  const attacker = event.attackerId ? getCountryMention(event.attackerId, guild) : null;
  const defender = event.defenderId ? getCountryMention(event.defenderId, guild) : null;

  let content = '';
  let color   = 0x6366f1;
  let title   = '';

  switch (event.type) {
    case 'war_conquest':
      title   = '⚔️ Country Conquered';
      content = `${attacker} has conquered ${defender}!`;
      color   = 0xef4444; // red
      break;

    case 'war_siege_start':
      title   = '🚨 Country Under Siege';
      content = `${attacker} has ${event.ratio}% of ${defender}'s territory!`;
      color   = 0xf59e0b; // amber
      break;

    case 'war_siege_end':
      title   = '🛡️ Siege Lifted';
      content = `${defender} has reclaimed enough territory to break the siege.`;
      color   = 0x10b981; // green
      break;

    case 'war_bomb':
      const emojis = { 1: '💥', 2: '🔥', 3: '☢️' };
      title   = `${emojis[event.tier] || '💥'} ${event.bombName} Deployed`;
      content = defender
        ? `${attacker} dropped a ${event.bombName} on ${defender}!`
        : `${attacker} dropped a ${event.bombName}!`;
      color   = event.tier === 3 ? 0x8b5cf6 : (event.tier === 2 ? 0xef4444 : 0xf59e0b);
      break;

    default:
      return;
  }

  // Tier 3 events ping @everyone (use sparingly!)
  const allowedMentions = { roles: [] };
  let mentionPrefix = '';
  if (event.tier >= 3) {
    mentionPrefix = '@everyone ';
    allowedMentions.parse = ['everyone', 'roles'];
  } else if (event.tier >= 2) {
    // Tier 2: allow role mentions (alliance pings)
    allowedMentions.parse = ['roles'];
  }
  // Tier 1: silent — no mentions parsed

  await _warChannel.send({
    content: mentionPrefix || undefined,
    embeds: [{
      color,
      title,
      description: content,
      timestamp: new Date(event.timestamp).toISOString(),
    }],
    allowedMentions,
  });
}

function handleGameEvent(event) {
  const guild = client.guilds.cache.get(GUILD_ID);
  switch (event.type) {
    case 'connected':
      console.log('[Bot] Event handshake received');
      break;

    case 'rank_change':
      console.log(`[Bot] Rank change: ${event.username} ${event.oldRank} → ${event.newRank}`);
      if (event.discordId && event.newRank) {
        syncMemberRank(event.discordId, event.newRank);
      }
      break;

    case 'alliance_formed':
      if (!guild) return;
      console.log(`[Bot] Alliance formed: ${event.key}`);
      createOrUpdateAllianceRole(guild, event.key, event.countries, event.members);
      announceAlliance(guild, 'formed', event.key, event.countries, { memberCount: event.members.length });
      break;

    case 'alliance_changed':
      if (!guild) return;
      console.log(`[Bot] Alliance changed: ${event.key} +${event.added.length} -${event.removed.length}`);
      createOrUpdateAllianceRole(guild, event.key, event.countries, event.members);
      // Only announce if grew, not on shrinks (avoid noise)
      if (event.added.length > event.removed.length) {
        announceAlliance(guild, 'grew', event.key, event.countries, { memberCount: event.members.length });
      }
      break;

    case 'alliance_dissolved':
      if (!guild) return;
      console.log(`[Bot] Alliance dissolved: ${event.key}`);
      dissolveAllianceRole(guild, event.key);
      announceAlliance(guild, 'dissolved', event.key, event.countries);
      break;

    case 'war_conquest':
    case 'war_siege_start':
    case 'war_siege_end':
    case 'war_bomb':
      queueWarEvent(event);
      break;
  }
}

// ── Login ────────────────────────────────────────────────────────
client.login(TOKEN).catch(err => {
  console.error('[Bot] Login failed:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
process.on('SIGINT',  () => { client.destroy(); process.exit(0); });
