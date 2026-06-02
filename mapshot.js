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
  const { MAP_W, MAP_H, claimByPixel, landMask, idxToId, geoColorsById, bbox } = opts;
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

  for (let oy = 0; oy < OUT_H; oy++) {
    const sy = Math.min(MAP_H - 1, Math.floor((oy / OUT_H) * MAP_H));
    for (let ox = 0; ox < OUT_W; ox++) {
      const sx = Math.min(MAP_W - 1, Math.floor((ox / OUT_W) * MAP_W));
      const p = (oy * OUT_W + ox) * 4;
      const si = sy * MAP_W + sx;
      let r, g, b;
      const owner = claimByPixel[si];
      if (owner >= 0) {
        const rgb = ownerColor(idxToId[owner]);
        r = rgb[0]; g = rgb[1]; b = rgb[2];
      } else if (landMask[si]) {
        r = LAND[0]; g = LAND[1]; b = LAND[2];
      } else {
        r = OCEAN[0]; g = OCEAN[1]; b = OCEAN[2];
      }
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer('image/png');
}

module.exports = { renderCountryPNG, renderWorldPNG };
