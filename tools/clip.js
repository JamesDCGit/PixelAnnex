#!/usr/bin/env node
// PixelAnnex CLIP POST — turns a raw capture (.webm from tools/capture.js) into a
// social-ready MP4: trims the warm-up, re-encodes to H.264/yuv420p 30fps (what
// TikTok/X/IG expect), pins the exact length, fades out, optionally muxes music.
//
//   node tools/clip.js out/greenland.webm --out out/greenland.mp4
//   options: --start 2      seconds to skip (capture's warm-up; default 2)
//            --len 10       output length in seconds (default 10)
//            --music x.mp3  optional audio track (trimmed + faded to fit)
//            --frames       also dump 1 frame/sec PNGs next to the output (for review)
//            --fps 30
// ffmpeg: uses PATH, else the winget install location.
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const IN = argv.find(a => /\.(webm|mp4|mov|mkv)$/i.test(a) && !a.startsWith('--'));
if (!IN) { console.error('usage: node tools/clip.js <capture.webm> [--out x.mp4] [--start 2] [--len 10] [--music m.mp3] [--frames]'); process.exit(1); }
const OUT = opt('out', IN.replace(/\.\w+$/, '.mp4'));
// Default trim = the exact moment the director timeline started, as recorded by
// tools/capture.js in a sidecar next to the take. A fixed guess is wrong because
// Playwright records from context creation (page load + boot + warm-up included).
let sidecar = null; try { sidecar = JSON.parse(fs.readFileSync(IN + '.json', 'utf8')); } catch (e) {}
// --lead: the video's own clock starts a few hundred ms AFTER the recording clock
// (first frames are dropped until the page paints), so the timeline lands slightly
// earlier in the file than the sidecar says. Measured ~0.4s; pass --lead to tune.
const LEAD = +opt('lead', 0.4);
const START = +opt('start', sidecar && sidecar.offset != null ? Math.max(0, sidecar.offset - LEAD) : 2);
const LEN = +opt('len', 10), FPS = +opt('fps', 30), MUSIC = opt('music', null);
if (sidecar) console.log('[clip] sidecar: timeline starts at ' + START + 's into the take' + (sidecar.seat ? ' (seat ' + sidecar.seat + ')' : ''));

function ffmpegBin() {
  for (const cand of ['ffmpeg', 'ffmpeg.exe']) { try { execFileSync(cand, ['-version'], { stdio: 'ignore' }); return cand; } catch (e) {} }
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name);
    if (f.isDirectory()) { const r = walk(p); if (r) return r; } else if (f.name === 'ffmpeg.exe') return p; } return null; };
  try { const p = walk(base); if (p) return p; } catch (e) {}
  throw new Error('ffmpeg not found on PATH or under WinGet packages');
}
const FF = ffmpegBin(), FFPROBE = FF.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

const vf = `fps=${FPS},format=yuv420p,fade=t=out:st=${(LEN - 0.4).toFixed(2)}:d=0.4`;
const args = ['-y', '-ss', String(START), '-i', IN];
if (MUSIC) args.push('-i', MUSIC);
args.push('-t', String(LEN), '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-movflags', '+faststart');
if (MUSIC) args.push('-map', '0:v:0', '-map', '1:a:0', '-af', `afade=t=out:st=${(LEN - 1).toFixed(2)}:d=1`, '-c:a', 'aac', '-b:a', '160k', '-shortest');
else args.push('-an');
args.push(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
console.log('[clip] ' + path.basename(FF) + ' ' + args.join(' '));
execFileSync(FF, args, { stdio: ['ignore', 'ignore', 'inherit'] });

const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=width,height,r_frame_rate,nb_frames:format=duration,size', '-of', 'json', OUT]).toString();
const j = JSON.parse(probe), s = j.streams[0], f = j.format;
console.log(`[clip] ${OUT}: ${s.width}x${s.height} @ ${s.r_frame_rate} · ${(+f.duration).toFixed(2)}s · ${(f.size / 1024 / 1024).toFixed(2)} MB · frames=${s.nb_frames}`);

if (argv.includes('--frames')) {
  const dir = OUT.replace(/\.mp4$/, '_frames'); fs.mkdirSync(dir, { recursive: true });
  execFileSync(FF, ['-y', '-i', OUT, '-vf', 'fps=1,scale=360:-1', path.join(dir, 'f%02d.png')], { stdio: 'ignore' });
  console.log('[clip] review frames (1/s, 360px wide) in ' + dir + ': ' + fs.readdirSync(dir).join(' '));
}
