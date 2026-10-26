#!/usr/bin/env node
// PixelAnnex PORTAL BUILD — packs the game for HTML5 portals (Poki, Y8) as a
// self-contained folder + zip: dist/<portal>/index.html + dist/<portal>/assets/…
//
//   node tools/build-portal.js poki
//   node tools/build-portal.js y8
//   options: --origin https://pixelannex.com   the live server (WebSocket + public APIs)
//            --no-minify                       keep the inline scripts readable
//            --no-zip                          folder only
//
// What changes vs the site build (pixelworld_v5.html is the single source):
//   * a bootstrap <script> sets window.PA_PORTAL / PA_ORIGIN before the game runs, routes
//     the game's /api calls to the live server, answers session-only calls (/auth, daily
//     login, my stats) locally as "signed out", and blocks window.open (no outbound links);
//   * the portal SDK adapter window.paPortal (Poki SDK for poki, no-op for y8) — the
//     client's v212 hooks call loaded / gameplayStart / gameplayStop / commercialBreak;
//   * root-absolute asset paths (/fonts/, /flags/, /map_grid.json, …) → relative assets/…,
//     and those files are copied in, so the portal's CDN serves all art;
//   * SEO/PWA/analytics head tags dropped (canonical, OG, manifest, JSON-LD, Umami);
//   * inline scripts minified with terser exactly like the server does at boot.
// The client's v212 `html.pa-portal` CSS hides Discord sign-in, social links, the
// install prompt and share-to-X. The bundle's CODE_VERSION must equal the live
// SERVER_VERSION — rebuild + re-upload whenever the client triad moves.
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const PORTAL = argv[0];
const ADAPTERS = {
  poki: {
    sdk: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
    // PokiSDK.init() first; every call is guarded so an ad-blocked SDK never breaks the game.
    adapter: `window.paPortal = (function () {
  function sdk() { return window.PokiSDK; }
  try { sdk().init().catch(function () {}); } catch (e) {}
  function call(fn) { try { return sdk()[fn](); } catch (e) {} }
  return {
    loaded: function () { call('gameLoadingFinished'); },
    gameplayStart: function () { call('gameplayStart'); },
    gameplayStop: function () { call('gameplayStop'); },
    commercialBreak: function () { try { return sdk().commercialBreak(); } catch (e) { return Promise.resolve(); } },
  };
})();`,
  },
  y8: { sdk: null, adapter: 'window.paPortal = {};' },
};
if (!ADAPTERS[PORTAL]) { console.error('usage: node tools/build-portal.js <' + Object.keys(ADAPTERS).join('|') + '> [--origin URL] [--no-minify] [--no-zip]'); process.exit(1); }
const ORIGIN = opt('origin', 'https://pixelannex.com').replace(/\/+$/, '');
const OUT = path.join(ROOT, 'dist', PORTAL);
const PUB = path.join(ROOT, 'public');

// ── version guard ───────────────────────────────────────────────────────────
let html = fs.readFileSync(path.join(ROOT, 'pixelworld_v5.html'), 'utf8');
const codeV = (html.match(/const CODE_VERSION = '([^']+)'/) || [])[1];
const srvV = (fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/const SERVER_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (!codeV) throw new Error('CODE_VERSION not found');
if (codeV !== srvV) console.warn('WARNING: CODE_VERSION ' + codeV + ' != SERVER_VERSION ' + srvV + ' in the repo');

// ── head: drop site-only tags ───────────────────────────────────────────────
const DROP = [
  /^\s*<link rel="canonical"[^>]*>.*\n/m,
  /^\s*<meta (property="og:|name="twitter:)[^>]*>.*\n/gm,
  /^\s*<link rel="manifest"[^>]*>.*\n/m,
  /^\s*<link rel="apple-touch-icon"[^>]*>.*\n/m,
  /^\s*<meta name="(apple-mobile-web-app-capable|mobile-web-app-capable|apple-mobile-web-app-status-bar-style)"[^>]*>.*\n/gm,
  /<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/,
  /^\s*<script defer src="https:\/\/cloud\.umami\.is\/script\.js"[^>]*><\/script>.*\n/m,
];
for (const re of DROP) {
  const before = html.length;
  html = html.replace(re, '');
  if (html.length === before) console.warn('note: head pattern not found ' + re);
}

// ── asset paths → relative assets/… ─────────────────────────────────────────
const ASSET_RE = /(["'(`])\/(fonts\/|flags\/|Avatars\/|emoji\/|collectables\/|map_grid\.json|map_meta\.json|map_base\.(?:gif|webp)|city_lights\.png|PixelAnnexHero\.(?:webp|jpg)|PrettyNeatLogo512\.png|favicon-(?:32|64)\.png)/g;
let rewrites = 0;
html = html.replace(ASSET_RE, (m, q, p) => { rewrites++; return q + 'assets/' + p; });

// ── bootstrap + SDK adapter, before any game script ─────────────────────────
const a = ADAPTERS[PORTAL];
const boot = `<script>
window.PA_PORTAL = ${JSON.stringify(PORTAL)}; window.PA_ORIGIN = ${JSON.stringify(ORIGIN)};
(function () {
  var O = window.PA_ORIGIN, f = window.fetch.bind(window);
  var SESSION = /^\\/(auth\\/|api\\/daily-login|api\\/stats\\/me)/; // need the site's sign-in cookie: answer "signed out"
  window.fetch = function (u, o) {
    if (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/') {
      if (SESSION.test(u)) return Promise.resolve(new Response('{"loggedIn":false}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
      o = Object.assign({}, o || {}); o.credentials = 'omit'; u = O + u;
    }
    return f(u, o);
  };
  window.open = function () { return null; }; // no outbound links from inside the portal frame
})();
</script>
${a.sdk ? '<script src="' + a.sdk + '"></script>\n' : ''}<script>
${a.adapter}
</script>
`;
html = html.replace(/(<meta charset="UTF-8">\n)/, '$1' + boot);
if (!html.includes('window.PA_PORTAL')) throw new Error('bootstrap injection failed');

// ── minify (same as server.js _minifyHtmlAsset) ─────────────────────────────
async function minify(src) {
  let terser;
  try { terser = require('terser'); } catch (e) { console.warn('terser not installed — inline scripts left unminified'); return src; }
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    const attrs = m[1], code = m[2];
    out += src.slice(last, m.index); last = m.index + m[0].length;
    if (/type\s*=\s*["']?(?!text\/javascript|module)[a-z]/i.test(attrs) || code.trim().length < 200) { out += m[0]; continue; }
    const r = await terser.minify(code, { compress: false, mangle: true, format: { comments: false } });
    out += '<script' + attrs + '>' + r.code + '</script>';
  }
  out += src.slice(last);
  return out.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (all, at, css) => '<style' + at + '>' + css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n+/g, '\n') + '</style>');
}

// ── copy assets ─────────────────────────────────────────────────────────────
function copyAssets() {
  const dst = path.join(OUT, 'assets');
  const files = [];
  const dir = (sub, keep) => { for (const n of fs.readdirSync(path.join(PUB, sub))) if (keep.test(n)) files.push(sub + '/' + n); };
  dir('fonts', /\.woff2$/);
  dir('flags', /^([a-z]{2}|Fallen)\.png$/);
  dir('Avatars', /\.png$/);
  dir('emoji', /\.png$/);
  files.push('collectables/atlas.png', 'collectables/manifest.json',
    'map_grid.json', 'map_meta.json', 'map_base.gif', 'map_base.webp', 'city_lights.png',
    'PixelAnnexHero.webp', 'PixelAnnexHero.jpg', 'PrettyNeatLogo512.png', 'favicon-32.png', 'favicon-64.png');
  let bytes = 0;
  for (const f of files) {
    const to = path.join(dst, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(PUB, f), to);
    bytes += fs.statSync(to).size;
  }
  return { count: files.length, bytes };
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const out = argv.includes('--no-minify') ? html : await minify(html);
  fs.writeFileSync(path.join(OUT, 'index.html'), out);
  const as = copyAssets();
  // anything root-absolute left that would 404 on a portal CDN?
  const left = (out.match(/["'(`]\/(?!\/)[A-Za-z_][\w.-]*\.(png|jpe?g|gif|webp|json|woff2)/g) || []).filter(s => !/\/(icon-|apple-touch|screenshots|sw\.js|countries-10m)/.test(s));
  if (left.length) console.warn('WARNING: root-absolute asset refs left:', [...new Set(left)].join(' '));
  const mb = n => (n / 1048576).toFixed(2) + ' MB';
  console.log(`[${PORTAL}] ${codeV} → ${path.relative(ROOT, OUT)}  index.html ${mb(Buffer.byteLength(out))}, ${as.count} assets ${mb(as.bytes)}, ${rewrites} path rewrites, server ${ORIGIN}`);
  if (argv.includes('--no-zip')) return;
  const zip = path.join(ROOT, 'dist', `pixelannex-${PORTAL}-${codeV}.zip`);
  fs.writeFileSync(zip, makeZip(OUT));
  console.log(`[${PORTAL}] zip ${path.relative(ROOT, zip)} ${mb(fs.statSync(zip).size)}`);
})().catch(e => { console.error(e); process.exit(1); });

// Minimal zip writer (deflate, no dependency). Windows PowerShell 5.1's Compress-Archive
// stores entry names with BACKSLASHES ("assets\flags\us.png"), which Linux unzip — i.e.
// the portals' upload pipelines — extracts as literal filenames, so every asset 404s.
// Entries here always use forward slashes, index.html at the root.
function makeZip(dir) {
  const zlib = require('zlib');
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const walk = (d, pre) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name), pre + e.name + '/') : [pre + e.name]);
  const names = walk(dir, '').sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed stamp → reproducible zips
  const local = [], central = [];
  let offset = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(dir, name));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const stored = comp.length >= data.length; // already-compressed art: store as-is
    const body = stored ? data : comp, nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    local.push(lh, nameBuf, body); central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
