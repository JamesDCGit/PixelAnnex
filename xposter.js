// v93l: optional X (Twitter) poster for the tweet-draft dashboard.
// ============================================================================
// Manual-approve only: the game server NEVER auto-posts. The admin dashboard
// exposes a "Post to X" button per draft which hits /api/tweets/:id/postx,
// which calls postToX() here. Media (the daily timelapse GIF or a country
// screenshot) is uploaded first, then the tweet is created with that media_id.
//
// Auth: OAuth 1.0a user context (app key/secret + access token/secret). This
// posts AS the account that generated the access token — no token refresh, no
// OAuth2 PKCE dance. Set these in .env (the operator supplies them; never
// commit them):
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//
// twitter-api-v2 is pure JS (no native addon), so it installs cleanly on the
// linux droplet. It's require()d lazily so a missing dep degrades gracefully:
// the dashboard simply reports the error instead of crashing the server.
'use strict';

const fs   = require('fs');
const path = require('path');

let _client    = null;  // cached TwitterApi instance
let _clientErr = null;  // last init error (so we don't retry require on every call)

function _env() {
  return {
    appKey:       process.env.X_API_KEY,
    appSecret:    process.env.X_API_SECRET,
    accessToken:  process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  };
}

// True when all four OAuth 1.0a credentials are present in the environment.
function isXEnabled() {
  const e = _env();
  return !!(e.appKey && e.appSecret && e.accessToken && e.accessSecret);
}

function _getClient() {
  if (_client) return _client;
  if (!isXEnabled()) {
    throw new Error('X API not configured — set X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET in .env');
  }
  let TwitterApi;
  try {
    ({ TwitterApi } = require('twitter-api-v2'));
  } catch (e) {
    _clientErr = e;
    throw new Error('twitter-api-v2 not installed — run `npm install` on the server');
  }
  _client = new TwitterApi(_env());
  return _client;
}

// Map a server-served media URL (/shots/x.png, /timelapse/x.gif) back to its
// on-disk path. Returns null for anything outside those two dirs (defence
// against path traversal) or if the file is missing.
function _resolveMediaPath(imageUrl) {
  if (!imageUrl) return null;
  const m = String(imageUrl).match(/^\/(shots|timelapse)\/([A-Za-z0-9._-]+\.(?:png|gif))$/);
  if (!m) return null;
  const p = path.join(__dirname, m[1], path.basename(m[2]));
  return fs.existsSync(p) ? p : null;
}

// Post a tweet, optionally with one image/GIF. Resolves to { id, url, media }.
// Throws on auth/API failure (the caller surfaces the message to the dashboard).
async function postToX({ text, imageUrl }) {
  const client = _getClient();
  const body = String(text || '').slice(0, 280);

  let mediaIds;
  if (imageUrl) {
    const filePath = _resolveMediaPath(imageUrl);
    if (filePath) {
      // uploadMedia infers MIME from the extension and uses chunked upload +
      // the correct media category (e.g. tweet_gif) for GIFs automatically.
      const id = await client.v1.uploadMedia(filePath);
      mediaIds = [id];
    }
    // If the file is gone, fall through and post text-only rather than fail.
  }

  const payload = mediaIds ? { media: { media_ids: mediaIds } } : undefined;
  const resp = await client.v2.tweet(body, payload);
  const tweetId = resp && resp.data && resp.data.id;
  return {
    id:    tweetId || null,
    url:   tweetId ? ('https://x.com/i/web/status/' + tweetId) : null,
    media: !!mediaIds,
  };
}

module.exports = { isXEnabled, postToX };
