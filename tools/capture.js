#!/usr/bin/env node
// PixelAnnex CLIP CAPTURE — records the real game client (headless Chromium via
// Playwright) while a director scenario runs, and writes a .webm.
//
//   node tools/capture.js scenarios/clip-greenland.json --out out/greenland.webm
//   options: --seconds 11   record length (default: last step + 2s)
//            --w 1080 --h 1920   viewport = video size (default 9:16 portrait)
//            --host http://localhost:3000   a server started with DIRECTOR=1
//            --warmup 2   seconds to let the map settle before the timeline starts
//
// Needs: `npm i --no-save playwright` + `npx playwright install chromium`.
// Post-process with ffmpeg (see tools/clip.js) — this only produces the raw take.
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const scenarioPath = argv.find(a => a.endsWith('.json'));
if (!scenarioPath) { console.error('usage: node tools/capture.js <scenario.json> [--out file.webm] [--seconds N]'); process.exit(1); }
const HOST = opt('host', process.env.DIRECTOR_HOST || 'http://localhost:3000');
const W = +opt('w', 1080), H = +opt('h', 1920);
const WARMUP = +opt('warmup', 2);
const sc = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const steps = sc.steps || sc;
const lastAt = Math.max(...steps.map(s => +s.at || 0));
const SECONDS = +opt('seconds', lastAt + 2);
const OUT = opt('out', path.join('out', path.basename(scenarioPath, '.json') + '.webm'));

async function director(payload) {
  const r = await fetch(HOST + '/api/director', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await r.json(); if (j.ok === false) throw new Error('director: ' + (j.error || JSON.stringify(j)));
  return j;
}

(async () => {
  const st = await (await fetch(HOST + '/api/director')).json().catch(() => null);
  if (!st || !st.director) { console.error('No DIRECTOR=1 server at ' + HOST + ' (GET /api/director must return director:true)'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const vidDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pa-cap-'));

  // Every take starts from a FRESH world. State persists on the director server
  // between runs, so without this a re-take opens on the previous take's result —
  // and a forced `conquer` of an already-held country takes the transfer path, which
  // never fires the leaders popup. Reset BEFORE the browser exists so nothing reloads.
  if (!argv.includes('--no-reset')) {
    await director({ action: 'reset' });
    await new Promise(r => setTimeout(r, 1500));
    console.log('[capture] world reset (pass --no-reset to continue from the current state)');
  }

  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1,
    recordVideo: { dir: vidDir, size: { width: W, height: H } },
  });
  const ctxStart = Date.now();           // recording clock zero (see sidecar below)
  // A fresh headless profile has NO stored country, and the quick-start modal opens
  // whenever there is none — so seed the seat before boot. pa_country_idx is a
  // featList INDEX; featList is rebuilt from map_meta.json in file order, so resolve
  // the index from the served meta rather than hard-coding it. Also mark every
  // first-run flag seen so no tutorial / FTUE coach / first-encircle card can appear.
  const SEAT = opt('seat', '242');       // Fiji — off camera for every current scenario
  const meta = await (await fetch(HOST + '/map_meta.json')).json();
  const seatIdx = meta.findIndex(f => String(f.id) === String(SEAT));
  if (seatIdx < 0) { console.error('seat id ' + SEAT + ' not in map_meta.json'); process.exit(1); }
  await ctx.addInitScript(({ seatIdx }) => {
    try {
      localStorage.setItem('pa_country_idx', String(seatIdx));
      localStorage.setItem('pa_tutorial_seen', '1');
      localStorage.setItem('pa_ftue_guided_done', '1');
      localStorage.setItem('pa_first_encircle_done', '1');
      localStorage.setItem('pa_force_mobile', '1');    // harmless on desktop tier; defeats the mobile splash if UA sniffing trips
      localStorage.setItem('pa_music', '0'); localStorage.setItem('pa_sfx', '0');
    } catch (e) {}
  }, { seatIdx });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.warn('[page error]', String(e).slice(0, 160)));

  console.log('[capture] opening ' + HOST + ' at ' + W + 'x' + H);
  await page.goto(HOST + '/?capture=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    typeof featList !== 'undefined' && featList && featList.length > 0 &&
    typeof _localPlayerId !== 'undefined' && _localPlayerId != null, null, { timeout: 90000 });
  const info = await page.evaluate(() => ({ v: typeof CODE_VERSION !== 'undefined' ? CODE_VERSION : '?', dir: window._directorOn === true }));
  console.log('[capture] client ready: ' + info.v + ' director=' + info.dir);
  if (!info.dir) { console.error('client did not receive director:true in welcome — is the server DIRECTOR=1?'); process.exit(1); }

  // The recording seat must be OFF CAMERA and not a participant: a player's own
  // pixels get the diagonal stripe and its homeland the pulsing outline. Confirm the
  // seeded seat took; if any welcome/quick-start overlay still opened, drop it WITHOUT
  // closeTutorial() (that would launch the FTUE guided-paint coach into the shot).
  const seat = await page.evaluate(({ seatIdx }) => {
    if (typeof currentIdx !== 'undefined' && currentIdx !== seatIdx && typeof selectCountry === 'function') selectCountry(seatIdx);
    const ov = document.getElementById('tutorial-overlay');
    const wasOpen = !!(ov && ov.classList.contains('open'));
    if (wasOpen) { ov.classList.remove('open'); try { _syncToolbarVisibility(); } catch (e) {} }
    return { idx: typeof currentIdx !== 'undefined' ? currentIdx : null, overlayWasOpen: wasOpen };
  }, { seatIdx });
  console.log('[capture] seat: country id ' + SEAT + ' (featList idx ' + seatIdx + ', client currentIdx ' + seat.idx + ')' + (seat.overlayWasOpen ? ' — closed a stray welcome overlay' : ''));

  await director({ action: 'cinematic', on: true, hud: 'events' });
  await page.waitForTimeout(WARMUP * 1000);

  // Playwright has been recording since the context was created (page load + boot
  // + warm-up included), so note EXACTLY when the timeline starts relative to the
  // recording and hand that to the encoder via a sidecar — a fixed trim is wrong.
  await page.evaluate(() => { const ov = document.getElementById('tutorial-overlay'); if (ov) ov.classList.remove('open'); }); // it can re-open on welcome
  const runAt = Date.now();
  console.log('[capture] running ' + (sc.name || scenarioPath) + ' — ' + steps.length + ' steps, recording ' + SECONDS + 's');
  await director({ action: 'run', steps });
  await page.waitForTimeout(SECONDS * 1000);
  await director({ action: 'abort' }).catch(() => {});
  console.log('[capture] took ' + ((Date.now() - runAt) / 1000).toFixed(1) + 's; finalising video…');

  const video = page.video();
  await ctx.close();                     // flushes the recording
  await browser.close();
  const src = await video.path();
  fs.copyFileSync(src, OUT); try { fs.rmSync(vidDir, { recursive: true, force: true }); } catch (e) {}
  const offset = (runAt - ctxStart) / 1000;
  fs.writeFileSync(OUT + '.json', JSON.stringify({ offset: +offset.toFixed(3), seconds: SECONDS, warmup: WARMUP, seat: SEAT, scenario: scenarioPath }, null, 2));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log('[capture] wrote ' + OUT + ' (' + kb + ' KB); timeline starts at ' + offset.toFixed(2) + 's into the recording (sidecar ' + OUT + '.json).');
})().catch(e => { console.error('[capture] failed:', e && e.message || e); process.exit(1); });
