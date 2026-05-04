/**
 * Register slash commands with Discord
 * =====================================
 * Run once after creating the bot, and again whenever you change commands.
 *
 *   node register-commands.js
 *
 * Per-guild registration is instant (vs global which takes ~1 hour).
 * Required env vars: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
 */

'use strict';

require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const TOKEN     = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing one of DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('country')
    .setDescription('Manage your country preferences in PixelAnnex')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set your main country and 2 optional allegiances')
      .addStringOption(o => o
        .setName('main')
        .setDescription('Your main country (where you paint pixels from)')
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption(o => o
        .setName('allegiance_b')
        .setDescription('First allegiance (forms alliances when shared)')
        .setRequired(false)
        .setAutocomplete(true))
      .addStringOption(o => o
        .setName('allegiance_c')
        .setDescription('Second allegiance')
        .setRequired(false)
        .setAutocomplete(true)))
    .addSubcommand(sub => sub
      .setName('show')
      .setDescription('Show your current country preferences'))
    .addSubcommand(sub => sub
      .setName('clear')
      .setDescription('Clear all country preferences'))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash command(s) for guild ${GUILD_ID}...`);
    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands },
    );
    console.log(`✓ Registered ${data.length} command(s):`);
    data.forEach(c => console.log('  /' + c.name));
  } catch (err) {
    console.error('Registration failed:', err);
    process.exit(1);
  }
})();
