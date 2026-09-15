#!/usr/bin/env node
// PixelAnnex DIRECTOR CLI — drives a local server started with DIRECTOR=1.
//
//   node tools/director.js scenarios/usa-greenland-canada.json   run a timeline
//   node tools/director.js reset                                  fresh world (clients reload)
//   node tools/director.js attack attacker=USA targets=Greenland,Canada style=spread rate=300
//   node tools/director.js conquer attacker=USA target=Greenland
//   node tools/director.js camera countries=USA,Canada pad=0.7
//   node tools/director.js cinematic on=true hud=events
//   node tools/director.js status | abort | find q=green
//
// Host: DIRECTOR_HOST env (default http://localhost:3000). The endpoint only exists
// on a DIRECTOR=1 server and only answers localhost — it is unreachable in production.
'use strict';
const fs = require('fs');
const HOST = process.env.DIRECTOR_HOST || 'http://localhost:3000';

async function post(payload) {
  const r = await fetch(HOST + '/api/director', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { status: r.status, raw: t }; }
}

function coerce(key, v) {
  if (/^(targets|countries)$/.test(key)) return v.split(',').map(s => s.trim()).filter(Boolean);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !isNaN(v)) return +v;
  if (v.startsWith('[') || v.startsWith('{')) { try { return JSON.parse(v); } catch {} }
  return v;
}

(async () => {
  const [first, ...rest] = process.argv.slice(2);
  if (!first) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).join('\n'));
    process.exit(1);
  }
  let payload;
  if (first.endsWith('.json')) {
    const sc = JSON.parse(fs.readFileSync(first, 'utf8'));
    const steps = sc.steps || sc;
    payload = { action: 'run', steps };
    console.log('running ' + (sc.name || first) + ' — ' + steps.length + ' steps, ' +
      Math.max(...steps.map(s => +s.at || 0)) + 's');
    if (sc.note) console.log('note: ' + sc.note);
  } else {
    payload = { action: first };
    for (const kv of rest) {
      const m = kv.match(/^([^=]+)=(.*)$/); if (!m) continue;
      payload[m[1]] = coerce(m[1], m[2]);
    }
  }
  try {
    console.log(JSON.stringify(await post(payload), null, 2));
  } catch (e) {
    console.error('failed: ' + e.message + '\nIs the server running with DIRECTOR=1 at ' + HOST + '?');
    process.exit(1);
  }
})();
