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
