// v88: server-side map screenshot renderer for tweet/Discord images.
// Renders a 256x256 PNG cropped + centered on a country, colouring owned
// pixels with their painter's colour over a land/ocean base.
//
// Lazily loads @napi-rs/canvas. If it isn't installed the renderer returns
// null and the tweet pipeline simply carries on text-only — the game server
// never hard-depends on the native module.

'use strict';

let _Canvas = null;
let _canvasTried = false;
function _loadCanvas() {
  if (_canvasTried) return _Canvas;
  _canvasTried = true;
  try {
    _Canvas = require('@napi-rs/canvas');
  } catch (e) {
    console.warn('[Mapshot] @napi-rs/canvas not installed — screenshots disabled:', e.message);
    _Canvas = null;
  }
  return _Canvas;
}

// v92m: flag image cache. Real country flags are 15x10 PNGs in public/flags/.
// We preload them all once into decoded Image objects so renderCountryPNG can
// draw the flag synchronously (loadImage is async; pre-warming avoids making the
// whole screenshot pipeline async). Keyed by ISO alpha-2 (lowercase).
const _flagCache = new Map();
let _flagsLoaded = false;
async function preloadFlags(flagsDir) {
  const C = _loadCanvas();
  if (!C || !C.loadImage) { console.warn('[Mapshot] canvas/loadImage unavailable — flags disabled'); return; }
  let files;
  try { files = require('fs').readdirSync(flagsDir); }
  catch (e) { console.warn('[Mapshot] flags dir unreadable:', e.message); return; }
  let ok = 0;
  for (const f of files) {
    const m = /^([a-z]{2})\.png$/.exec(f);
    if (!m) continue;
    try {
      const img = await C.loadImage(require('path').join(flagsDir, f));
      _flagCache.set(m[1], img);
      ok++;
    } catch (e) { /* skip unreadable flag */ }
  }
  _flagsLoaded = true;
  console.log('[Mapshot] preloaded ' + ok + ' flag images');
}
function getFlagImage(a2) {
  return a2 ? _flagCache.get(String(a2).toLowerCase()) : undefined;
}

// v136: baked basemap art (biome + coast) for world-snapshot frames (the daily GIF).
// Decoded once at boot so renderWorldPNG can draw it synchronously. Prefer the WebP
// (@napi-rs/canvas decodes it reliably; GIF support is patchier) with PNG/GIF fallbacks.
let _baseMapImg = null;
async function preloadBaseMap(publicDir) {
  const C = _loadCanvas();
  if (!C || !C.loadImage) { console.warn('[Mapshot] canvas/loadImage unavailable — basemap disabled'); return; }
  const path = require('path'), fs = require('fs');
  for (const f of ['map_base.webp', 'map_base.png', 'map_base.gif']) {
    const fp = path.join(publicDir, f);
    if (!fs.existsSync(fp)) continue;
    try {
      _baseMapImg = await C.loadImage(fp);
      console.log('[Mapshot] basemap loaded: ' + f + ' (' + _baseMapImg.width + 'x' + _baseMapImg.height + ')');
      return;
    } catch (e) { console.warn('[Mapshot] basemap load failed for ' + f + ':', e.message); }
  }
  console.warn('[Mapshot] no basemap image loaded — world snapshots use the procedural base');
}

function hexToRgb(hex) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return [128, 128, 128];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// opts: { MAP_W, MAP_H, geoAtPixel, claimByPixel, landMask, idxToId, geoColorsById, bbox }
//   bbox: { minX, minY, maxX, maxY } of the target country in map-pixel coords.
// Returns a PNG Buffer (256x256) or null if rendering is unavailable.
function renderCountryPNG(opts) {
  const C = _loadCanvas();
  if (!C) return null;
  const { MAP_W, MAP_H, claimByPixel, landMask, idxToId, geoColorsById, bbox, flag } = opts;
  if (!bbox) return null;

  const OUT = 256;
  // v92e: tighter zoom — frame the country to its extents plus a fixed PAD px
  // of breathing room on every side (was a loose 1.5x multiplier that zoomed
  // out too far). The crop is squared (max of width/height) so the output
  // stays 1:1 and the country isn't distorted, then centered on the bbox.
  const PAD = 50;
  const bw = (bbox.maxX - bbox.minX + 1) + PAD * 2;
  const bh = (bbox.maxY - bbox.minY + 1) + PAD * 2;
  const ccx = (bbox.minX + bbox.maxX) / 2;
  const ccy = (bbox.minY + bbox.maxY) / 2;
  let crop = Math.max(bw, bh);
  crop = Math.max(60, Math.min(MAP_H, crop)); // floor keeps micro-countries visible; ceil = full map height
  crop = Math.round(crop);
  let x0 = Math.round(ccx - crop / 2);
  let y0 = Math.round(ccy - crop / 2);
  x0 = Math.max(0, Math.min(MAP_W - crop, x0));
  y0 = Math.max(0, Math.min(MAP_H - crop, y0));

  const canvas = C.createCanvas(OUT, OUT);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(OUT, OUT);
  const d = img.data;

  const OCEAN = [10, 37, 64];   // dark blue
  const LAND  = [75, 75, 75];   // neutral grey land base
  const colorCache = {};
  function ownerColor(cid) {
    let c = colorCache[cid];
    if (c) return c;
    c = hexToRgb(geoColorsById[cid]);
    colorCache[cid] = c;
    return c;
  }

  for (let oy = 0; oy < OUT; oy++) {
    const sy = y0 + Math.floor((oy / OUT) * crop);
    for (let ox = 0; ox < OUT; ox++) {
      const sx = x0 + Math.floor((ox / OUT) * crop);
      const p = (oy * OUT + ox) * 4;
      let r, g, b;
      if (sx < 0 || sx >= MAP_W || sy < 0 || sy >= MAP_H) {
        r = OCEAN[0]; g = OCEAN[1]; b = OCEAN[2];
      } else {
        const si = sy * MAP_W + sx;
        const owner = claimByPixel[si];
        if (owner >= 0) {
          const rgb = ownerColor(idxToId[owner]);
          r = rgb[0]; g = rgb[1]; b = rgb[2];
        } else if (landMask[si]) {
          r = LAND[0]; g = LAND[1]; b = LAND[2];
        } else {
          r = OCEAN[0]; g = OCEAN[1]; b = OCEAN[2];
        }
      }
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // v92m: draw the country flag at the flag spot (same density-center the crop is
  // built around). flag = { img, cx, cy } in map-pixel coords; transform to output
  // coords with the same crop math used above. Pixel-art flags: no smoothing.
  if (flag && flag.img) {
    const fx = (flag.cx - x0) / crop * OUT;
    const fy = (flag.cy - y0) / crop * OUT;
    const fw = 34;
    const ar = (flag.img.height && flag.img.width) ? (flag.img.height / flag.img.width) : (10 / 15);
    const fh = Math.round(fw * ar);
    const dx = Math.round(fx - fw / 2), dy = Math.round(fy - fh / 2);
    ctx.imageSmoothingEnabled = false;
    // dark plate + thin light edge so the flag reads on any background
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(dx - 2, dy - 2, fw + 4, fh + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(dx - 1, dy - 1, fw + 2, fh + 2);
    ctx.drawImage(flag.img, dx, dy, fw, fh);
  }

  return canvas.toBuffer('image/png');
}

// v92e: full-world snapshot for the daily summary post. Renders the entire
// map (the full 2:1 MAP_W×MAP_H) downsampled to OUT_W×OUT_H, coloured the same
// way as renderCountryPNG (owner colour / land grey / ocean blue).
// opts: { MAP_W, MAP_H, claimByPixel, landMask, idxToId, geoColorsById, outW? }
function renderWorldPNG(opts) {
  const C = _loadCanvas();
  if (!C) return null;
  const { MAP_W, MAP_H, claimByPixel, landMask, idxToId, geoColorsById } = opts;
  const OUT_W = opts.outW || 512;
  const OUT_H = Math.round(OUT_W * (MAP_H / MAP_W)); // preserve 2:1 aspect

  const canvas = C.createCanvas(OUT_W, OUT_H);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(OUT_W, OUT_H);
  const d = img.data;

  const OCEAN = [10, 37, 64];
  const LAND  = [75, 75, 75];
  const colorCache = {};
  function ownerColor(cid) {
    let c = colorCache[cid];
    if (c) return c;
    c = hexToRgb(geoColorsById[cid]);
    colorCache[cid] = c;
    return c;
  }

  if (_baseMapImg) {
    // v136: draw the baked basemap art (biome + coast), scaled to the output, then
    // overlay ONLY claimed pixels in their owner colour at 65% (matching the in-game
    // paint alpha) so unclaimed land/ocean shows the real terrain, not flat grey/blue.
    ctx.drawImage(_baseMapImg, 0, 0, OUT_W, OUT_H);
    const base = ctx.getImageData(0, 0, OUT_W, OUT_H);
    const bd = base.data;
    for (let oy = 0; oy < OUT_H; oy++) {
      const sy = Math.min(MAP_H - 1, Math.floor((oy / OUT_H) * MAP_H));
      for (let ox = 0; ox < OUT_W; ox++) {
        const sx = Math.min(MAP_W - 1, Math.floor((ox / OUT_W) * MAP_W));
        const owner = claimByPixel[sy * MAP_W + sx];
        if (owner < 0) continue; // unclaimed → the baked basemap shows through
        const rgb = ownerColor(idxToId[owner]);
        const p = (oy * OUT_W + ox) * 4;
        bd[p]     = (rgb[0] * 0.65 + bd[p]     * 0.35) | 0;
        bd[p + 1] = (rgb[1] * 0.65 + bd[p + 1] * 0.35) | 0;
        bd[p + 2] = (rgb[2] * 0.65 + bd[p + 2] * 0.35) | 0;
        bd[p + 3] = 255;
      }
    }
    ctx.putImageData(base, 0, 0);
  } else {
    // Fallback (basemap failed to load): procedural grey-land / blue-ocean base.
    for (let oy = 0; oy < OUT_H; oy++) {
      const sy = Math.min(MAP_H - 1, Math.floor((oy / OUT_H) * MAP_H));
      for (let ox = 0; ox < OUT_W; ox++) {
        const sx = Math.min(MAP_W - 1, Math.floor((ox / OUT_W) * MAP_W));
        const p = (oy * OUT_W + ox) * 4;
        const si = sy * MAP_W + sx;
        let r, g, b;
        const owner = claimByPixel[si];
        if (owner >= 0) { const rgb = ownerColor(idxToId[owner]); r = rgb[0]; g = rgb[1]; b = rgb[2]; }
        else if (landMask[si]) { r = LAND[0]; g = LAND[1]; b = LAND[2]; }
        else { r = OCEAN[0]; g = OCEAN[1]; b = OCEAN[2]; }
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // v95y: optional timestamp burned into the frame (bottom-left). Used by the
  // timelapse so the assembled GIF visibly ticks through its 12h window.
  if (opts.label) {
    const fs2 = Math.max(11, Math.round(OUT_W / 52)); // ~20px @ 1024 wide
    const pad = Math.round(fs2 * 0.55);
    ctx.font = '600 ' + fs2 + 'px sans-serif';
    ctx.textBaseline = 'alphabetic';
    const tw = ctx.measureText(opts.label).width;
    const bx = pad, by = OUT_H - pad - fs2 - pad;
    // dark pill backdrop for legibility over any map colour
    ctx.fillStyle = 'rgba(7,13,26,0.66)';
    ctx.fillRect(bx, by, tw + pad * 2, fs2 + pad * 2);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(opts.label, bx + pad, by + pad + fs2 - Math.round(fs2 * 0.18));
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderCountryPNG, renderWorldPNG, preloadFlags, preloadBaseMap, getFlagImage };
