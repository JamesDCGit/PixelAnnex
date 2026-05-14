# PixelAnnex — Discord OAuth Setup

Step-by-step guide to enable Discord login in PixelAnnex.

---

## 1. Create a Discord Application

1. Go to https://discord.com/developers/applications
2. Click **New Application**
3. Name it **PixelAnnex** → Create
4. **Save the Application ID** (you'll need this — it's your `DISCORD_CLIENT_ID`)

---

## 2. Create OAuth credentials

1. In your app, go to **OAuth2 → General**
2. Click **Reset Secret** → save the **Client Secret** (this is `DISCORD_CLIENT_SECRET`)
3. Under **Redirects**, click **Add Redirect** and enter:
   - For local testing: `http://localhost:3000/auth/callback`
   - For production: `http://YOUR_SERVER_IP:3000/auth/callback`
   - With domain: `https://yourdomain.com/auth/callback`
4. Click **Save Changes**

---

## 3. Create a Bot (needed for guild verification + future role syncing)

1. In your app, go to **Bot** → click **Reset Token** → save the **Bot Token** (this is `DISCORD_BOT_TOKEN`)
2. Under **Privileged Gateway Intents**, enable:
   - ✅ Server Members Intent
   - ✅ Presence Intent (optional, for online status)
3. Save Changes

---

## 4. Create the PixelAnnex Discord Server

1. In Discord, click **+** to add a server → Create My Own → For me and my friends
2. Name it **PixelAnnex**
3. Right-click the server icon → **Copy Server ID** (this is `DISCORD_GUILD_ID`)
   - You may need to enable Developer Mode first: User Settings → Advanced → Developer Mode

---

## 5. Invite the Bot to your server

1. Back in the Developer Portal, go to **OAuth2 → URL Generator**
2. Scopes: tick `bot` and `applications.commands`
3. Bot Permissions: tick `Manage Roles`, `Send Messages`, `View Channels`
4. Copy the generated URL at the bottom, paste it in your browser
5. Select your PixelAnnex server → Authorize

---

## 6. Configure environment variables on your server

SSH into your droplet:

```bash
cd /var/www/PixelAnnex

# Create .env file (don't commit this!)
nano .env
```

Paste:

```
DISCORD_CLIENT_ID=YOUR_APPLICATION_ID
DISCORD_CLIENT_SECRET=YOUR_CLIENT_SECRET
DISCORD_REDIRECT_URI=http://YOUR_SERVER_IP:3000/auth/callback
DISCORD_GUILD_ID=YOUR_SERVER_ID
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
PORT=3000
```

Save and exit (Ctrl+X, Y, Enter).

---

## 7. Update PM2 to load .env

PM2 doesn't auto-load `.env` files. Use `dotenv` or pass env vars directly:

```bash
# Install dotenv
npm install dotenv
```

Add to the very top of `server.js` (just below the comment header):

```js
require('dotenv').config();
```

Or, alternative — use PM2 ecosystem file:

```bash
nano ecosystem.config.js
```

```js
module.exports = {
  apps: [{
    name: 'pixelannex',
    script: 'server.js',
    env: {
      DISCORD_CLIENT_ID: 'YOUR_APPLICATION_ID',
      DISCORD_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      DISCORD_REDIRECT_URI: 'http://YOUR_SERVER_IP:3000/auth/callback',
      DISCORD_GUILD_ID: 'YOUR_SERVER_ID',
      DISCORD_BOT_TOKEN: 'YOUR_BOT_TOKEN',
      PORT: 3000,
    }
  }]
};
```

Then restart with this config:

```bash
pm2 delete pixelannex
pm2 start ecosystem.config.js
pm2 save
```

---

## 8. Test the flow

1. Open `http://YOUR_SERVER_IP:3000` in browser
2. You should see a **Sign in with Discord** button at the top centre of the screen
3. Click it → redirected to Discord → authorize → redirected back to game
4. Login HUD now shows your avatar, username, and rank

---

## Troubleshooting

**"OAuth not configured"** — `DISCORD_CLIENT_ID` env var isn't set. Check `.env` or ecosystem file.

**"Invalid redirect URI"** — the `DISCORD_REDIRECT_URI` env var must exactly match the one registered in Discord Developer Portal (including http vs https, port, trailing slash).

**Login button doesn't appear** — open browser DevTools console, check for errors. The `/auth/me` request should return `{"loggedIn":false}` initially.

**Logged in but no profile** — check server logs: `pm2 logs pixelannex`. The OAuth callback logs will show what failed.

---

## What you have now

After completing this guide:
- Players can sign in via Discord
- Server stores `discord_id`, `username`, `avatar`, `rank`, `xp` per player
- Sessions persist 7 days via cookies
- In-game HUD shows logged-in user

## Next phase steps (already planned)

- `/country` slash command for selecting main + 2 allegiance countries
- Auto-promotion: game rank → Discord role
- Alliance detection from shared country preferences
- War Reporter bot posting to `#war-room`
- Twitter/X automation for major events

---

# Step 2: `/country` slash command

After completing the OAuth setup above, follow these additional steps to enable the bot.

## 1. Generate a bot API secret

This shared secret protects bot-only endpoints from random callers.

```bash
# On your server
openssl rand -hex 32
```

Save the output — you'll add it as `BOT_API_SECRET` in your `.env`.

## 2. Update `.env` on the server

```bash
cd /var/www/PixelAnnex
nano .env
```

Add to the existing file:

```
BOT_API_SECRET=PASTE_THE_SECRET_FROM_STEP_1
GAME_SERVER_URL=http://localhost:3000
```

(`DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` should already be there from Step 1.)

## 3. Install bot dependencies

```bash
cd /var/www/PixelAnnex
npm install
```

This installs `discord.js`, `dotenv`, and `ws`.

## 4. Register the slash command (one-time)

```bash
node register-commands.js
```

You should see:
```
✓ Registered 1 command(s):
  /country
```

You only need to run this when the command structure changes.

## 5. Start the bot with PM2

```bash
pm2 start bot.js --name pixelannex-bot
pm2 save
pm2 logs pixelannex-bot --lines 10
```

You should see:
```
[Bot] Logged in as PixelAnnex#1234
[Bot] Watching guild XXXXXXXXXXX
```

## 6. Restart the game server (now has bot API endpoints)

```bash
pm2 restart pixelannex
```

## 7. Test the slash command

In your Discord server, type `/country` — you should see the autocomplete suggesting:
- `/country set main: <type to search>`
- `/country show`
- `/country clear`

Example flow:
1. Type `/country set` → `main: USA` → `allegiance_b: Canada` → `allegiance_c: Mexico` → Enter
2. Bot replies (only visible to you): "🌍 Country preferences updated"
3. Type `/country show` → bot displays your current preferences

## 8. Verify the game server received it

```bash
curl -H "X-Bot-Secret: YOUR_BOT_API_SECRET" \
  "http://localhost:3000/api/bot/profile?discord_id=YOUR_DISCORD_ID"
```

Should return:
```json
{
  "discordId": "...",
  "countryMain": "840",
  "countryB": "124",
  "countryC": "484",
  ...
}
```

---

## What you have now (after Step 2)

- Players can sign in via Discord OAuth (Step 1)
- Players can set 3 country preferences via `/country set`
- Profile data persists on the game server
- Foundation is laid for alliance detection (Step 5) and rank sync (Step 4)

## Coming up

- **Step 3**: When the player logs into the game, automatically use their `countryMain` from the profile
- **Step 4**: Game promotes player → bot assigns Discord rank role
- **Step 5**: Alliance detection from shared `countryB`/`countryC` preferences
- **Step 6**: War Reporter — events posted to `#war-room`

---

# Step 4: Rank sync (game ↔ Discord)

When players earn XP in-game, the server promotes them through ranks. The bot mirrors this to Discord automatically by assigning rank roles.

**Ranks:** Soldier (0 XP) → Lieutenant (50) → Captain (150) → General (300) → Admiral (500)

**XP awarded:**
- 1 XP per pixel painted (only counts pixels that weren't already yours)
- 50 XP bonus per country conquered

## Setup

The bot creates the four rank roles automatically on startup. Just deploy and restart.

## Deploy

```bash
# Local — push the updates
git add server.js bot.js pixelworld_v5.html DISCORD_SETUP.md
git commit -m "Step 4: rank sync via SSE events"
git push

# Server
cd /var/www/PixelAnnex
git pull
npm install                  # in case any deps changed
pm2 restart pixelannex
pm2 restart pixelannex-bot
pm2 logs pixelannex-bot --lines 20
```

You should see in the bot logs:
```
[Bot] Logged in as PixelAnnex#1234
[Bot] Creating rank role: Lieutenant
[Bot] Creating rank role: Captain
[Bot] Creating rank role: General
[Bot] Creating rank role: Admiral
[Bot] Rank roles ready: Lieutenant, Captain, General, Admiral
[Bot] Event stream connected
[Bot] Event handshake received
```

## Important: bot role hierarchy

For the bot to assign roles, **its own role must be ABOVE** the rank roles in your server.

1. Server Settings → Roles
2. Find the bot's role (probably named "PixelAnnex" — same as your bot)
3. Drag it ABOVE Lieutenant, Captain, General, Admiral
4. Save

If you skip this, the bot will log `[Rank] Sync failed: Missing Permissions` whenever someone gets promoted.

## Test

1. Sign into the game with your Discord account
2. Run `/country set` to set a country
3. Paint at least 50 pixels (you'll start as Soldier)
4. Within a few seconds, the bot will:
   - Assign the **Lieutenant** role to you in Discord
   - DM you a "🎖️ Promoted to Lieutenant" message
5. Continue painting → progress through Captain (150 XP), General (300), Admiral (500)

Check progress via `/country show` — it displays current rank and XP.

## How it works

```
Player paints pixel
   ↓
server.js applyPixels() → returns changed[]
   ↓
updateProfileXP(discordId, changed.length)
   ↓
If rank crosses threshold:
   emitBotEvent({ type: 'rank_change', discordId, newRank })
   ↓
SSE stream → bot.js handleGameEvent()
   ↓
syncMemberRank(discordId, newRank)
   ↓
Remove old rank roles, add new one, send DM
```

## Troubleshooting

**Bot can't assign roles** — check role hierarchy (above). The bot's role must be above the rank roles.

**XP not increasing** — check `pm2 logs pixelannex` for `[Rank]` messages. If absent, the player isn't logged in via Discord (no `discordId` bound to their session).

**Bot disconnects from event stream** — auto-reconnect with exponential backoff is built in. Check logs for `[Bot] Event stream error:` messages.

**Wrong rank assigned** — check the player's actual XP via `/country show` — the bot syncs whatever the server says.


---

# Step 5: Alliance detection

When 3+ players share country preferences, an alliance forms automatically. The bot creates a Discord role and announces it in `#general`.

## How it works

**Server-side:** Every 30 seconds, the server scans all profiles and clusters countries that share members (using union-find). Any cluster with 2+ countries and 3+ players becomes an alliance.

**Bot-side:** Receives `alliance_formed`, `alliance_changed`, `alliance_dissolved` events via SSE. Creates/updates/deletes a Discord role named `Alliance: USA-Canada-Mexico`, assigns it to all members.

**Game-side:** Polls `/api/alliances` every 30s. Countries in alliances show 🤝 in the territory panel.

## Threshold

Default: **3+ players** sharing **2+ countries** = alliance.

To change, edit `server.js`:
```js
const ALLIANCE_MIN_MEMBERS = 3;  // bump to 5 once you have more players
```

## Optional: separate channel for alliances

By default alliances announce in the same channel as promotions (`#general` or `PROMOTION_CHANNEL`). For a dedicated channel, add to `.env`:

```
ALLIANCE_CHANNEL=alliances
```

## Deploy

```bash
# Local
git add server.js bot.js pixelworld_v5.html DISCORD_SETUP.md
git commit -m "Step 5: alliance detection"
git push

# Server
cd /var/www/PixelAnnex
git checkout server.js  # discard any local changes
git pull
pm2 restart pixelannex
pm2 restart pixelannex-bot
```

## Test

You need 3 different Discord users to test alliance formation. The simplest test:

1. User A — `/country set main:USA allegiance_b:Canada`
2. User B — `/country set main:Canada allegiance_b:USA`
3. User C — `/country set main:Mexico allegiance_b:USA`

Within 30 seconds, the bot will:
- Create role `Alliance: USA-Canada-Mexico` (or similar)
- Assign it to all three users
- Announce in `#general`: "🤝 New alliance formed! USA + Canada + Mexico — 3 members united."

If User D joins with USA in their preferences, the alliance grows:
- "🌱 Alliance growing — Now 4 members strong."

If users `/country clear` and the alliance drops below 3:
- Role deleted
- "💔 Alliance dissolved — Member count fell below threshold."

## In-game

Open the game while logged in. Countries that are part of an alliance show 🤝 next to their pixel count in the Territory panel. Hover for details.

## Troubleshooting

**Alliance not forming** — check `pm2 logs pixelannex` for `[Alliance] Formed:` messages. The recompute runs every 30s. If you don't see it, check that all test users have set countries via `/country set`.

**Role not assigned** — the bot's role must be ABOVE alliance roles in server settings (same as rank role hierarchy issue).

**Alliance role mentions everyone** — alliance roles are created with `mentionable: true` so they can be pinged in the war reporter (Step 6). If you don't want this, edit `bot.js` and set `mentionable: false`.


---

# Step 6: War Reporter

The bot now posts game events to a `#war-room` channel with tiered importance:

| Tier | Trigger | Behaviour |
|------|---------|-----------|
| **1** | Mortar dropped, siege lifted | Silent embed in channel |
| **2** | Country conquered, siege starts (50%), MOAB | Embed + alliance role ping |
| **3** | Nuke deployed | Embed + `@everyone` ping |

## Setup

### 1. Create the war-room channel

In your Discord server:
1. Right-click the channel list → Create Channel
2. Name: `war-room` (lowercase, no spaces)
3. Type: Text channel
4. Create

The bot needs `Send Messages`, `Embed Links`, and `Mention @everyone` permissions in this channel.

### 2. Optional: configure a different channel name

```bash
nano /var/www/PixelAnnex/.env
```

Add:
```
WAR_CHANNEL=war-room
```

Default is `war-room` if not set.

### 3. Deploy

```bash
# Local
git add server.js bot.js DISCORD_SETUP.md
git commit -m "Step 6: war reporter"
git push

# Server
cd /var/www/PixelAnnex
git checkout server.js   # discard any local changes
git pull
pm2 restart pixelannex
pm2 restart pixelannex-bot
```

## Event types

**war_conquest** — when a country crosses the 80% ownership threshold
```
⚔️ Country Conquered
Russia has conquered Ukraine!
```

**war_siege_start** — when an enemy holds >50% of a country's territory
```
🚨 Country Under Siege
China has 53% of India's territory!
```

**war_siege_end** — siege lifts (drops below 50%)
```
🛡️ Siege Lifted
India has reclaimed enough territory to break the siege.
```

**war_bomb** — Mortar/MOAB/Nuke deployed
```
☢️ Nuke Deployed
USA dropped a Nuke on China!
```
(Mortar = 💥, MOAB = 🔥, Nuke = ☢️)

## Batching & rate limits

- **Event batching:** events collected for 3 seconds before posting
- **Deduplication:** same attacker→defender event in a batch keeps only highest tier
- **Throttle:** 600ms between posts (well under Discord's 5/s/channel limit)
- **Max 5 events per batch:** prevents spam in big battles

## Alliance role pings

If an attacker or defender belongs to an alliance (from Step 5), their alliance role is mentioned instead of just the country name:

```
⚔️ Country Conquered
@Alliance: USA-Canada-Mexico (USA) has conquered @Alliance: Russia-Belarus (Russia)!
```

## Troubleshooting

**No events posting** — check `pm2 logs pixelannex-bot --lines 30`. If you don't see `[War]` messages, the SSE connection may have dropped. Restart the bot.

**Channel not found** — `[War] Channel #war-room not found — events dropped`. Create the channel with that exact name, or set `WAR_CHANNEL` in `.env`.

**Too many @everyone pings** — only Tier 3 (Nuke) events trigger this. To require admin rank, the player needs Admiral (500 XP). Adjust thresholds in `server.js` if you want this rarer.

**Missing permissions** — the bot needs `Mention @everyone` permission for Tier 3 events. If missing, the embed posts but the everyone ping silently fails.


---

# QoL Group A: Stats & Player Identity

Adds a points system, stats tracking, in-game stats screen, and Discord leaderboard.

## What's new

**Server tracks per-player stats** (persists to `profiles.json` on disk):
- `points` — total points (1 per pixel placed + 50 per conquest)
- `pixelsPlaced` — lifetime pixel count
- `conquestsMade` — countries conquered
- `bombsDeployed` — bombs used
- `topCountries` — pixel count per country painted

**New in-game UI** — 📊 button in toolbar opens a modal with:
- **My Stats** tab — your stats card + top 5 painted countries with progress bars
- **Leaderboard** tab — top 20 players globally with gold/silver/bronze medals

**New Discord slash commands:**
- `/me` — your stats card (private)
- `/leaderboard` — top 20 players (public)

## Deploy

```bash
# Local
git add server.js bot.js register-commands.js pixelworld_v5.html .gitignore DISCORD_SETUP.md
git commit -m "QoL Group A: stats system + Discord leaderboard"
git push

# Server
cd /var/www/PixelAnnex
git checkout server.js
git pull
node register-commands.js   # registers /me and /leaderboard
pm2 restart pixelannex
pm2 restart pixelannex-bot
```

## Testing

1. Reload the game, sign in via Discord, paint some pixels
2. Click 📊 in the toolbar → see your stats and the leaderboard
3. In Discord, try `/me` → your stats appear
4. Try `/leaderboard` → top 20 players appear

## Data persistence

Profiles save to `/var/www/PixelAnnex/profiles.json` every 60 seconds and on graceful shutdown. The file is gitignored (per-server data, not source code).

To reset all stats:
```bash
pm2 stop pixelannex
rm /var/www/PixelAnnex/profiles.json
pm2 start pixelannex
```


---

# QoL Group B: Visual & UX Polish

Pure client-side updates — no server changes.

## What's new

1. **Favicon** — pixel-grid icon in browser tab (inline SVG, no external file)
2. **Light grid at high zoom** — subtle dot grid appears at scale > 8x for precise pixel placement
3. **Coordinate display on hover** — `x:1234  y:567` shown at the bottom of the tooltip
4. **Loading screen tips** — 16 rotating tips (game mechanics, lore, controls) cycle every 4.5s during boot
5. **Flag scaling with zoom** — flags fade out at extreme zoom (scale > 18) so pixel detail isn't obscured
6. **Confetti on conquest** — particle burst when YOU conquer a country (not when others do)

## Deploy

```bash
git add pixelworld_v5.html DISCORD_SETUP.md
git commit -m "QoL Group B: favicon, grid, coords, tips, flag scaling, confetti"
git push

# Server
cd /var/www/PixelAnnex
git pull
pm2 restart pixelannex
```

No bot restart needed. Hard-refresh browser (Ctrl+Shift+R) to see all changes.

## Testing

- **Favicon** — check browser tab icon
- **Grid** — zoom in heavily (mouse wheel multiple times) until grid dots appear
- **Coords** — hover over the map, see `x:..  y:..` at bottom of tooltip
- **Loading tips** — refresh the page, watch tips cycle during load
- **Flag scaling** — zoom in to max, flags fade out before pixels become unreadable
- **Confetti** — conquer a country yourself, see the burst from screen centre

