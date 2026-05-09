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

const COUNTRY_BY_ID = Object.fromEntries(COUNTRIES.map(c => [c.id, c.name]));

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
  const matches = COUNTRIES
    .filter(c => c.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(c => ({ name: c.name, value: c.id }));
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
      // Send promotion DM (best effort)
      try {
        await member.send({
          embeds: [{
            color: RANK_ROLES.find(r => r.name === newRank)?.color || 0x6366f1,
            title: `🎖️ Promoted to ${newRank}`,
            description: `Congratulations! You've been promoted in PixelAnnex.`,
          }],
        });
      } catch (e) { /* DMs disabled — silent fail */ }
    }
  } catch (e) {
    console.error('[Rank] Sync failed:', e.message);
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

function handleGameEvent(event) {
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
    // Future: conquest, siege, etc. (Step 6)
  }
}

// ── Login ────────────────────────────────────────────────────────
client.login(TOKEN).catch(err => {
  console.error('[Bot] Login failed:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
process.on('SIGINT',  () => { client.destroy(); process.exit(0); });
