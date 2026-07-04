// tools/gen-collectables.js — bakes the collectables atlas + manifest (v157).
//
// Reads public/map_meta.json (id/name per country), assigns each playable country a
// collectable item (curated for notable countries, themed generics elsewhere), draws a
// 32x32 pixel-art icon per item, and writes:
//   public/collectables/atlas.png      — 16 columns of 32x32 cells, alphabetical by
//                                        country name (slot = index; row-major).
//   public/collectables/manifest.json  — { cell, cols, count, items: { <countryId>:
//                                        { slot, name, country } } }
//
// The atlas is DESIGNED FOR MANUAL EDITING: repaint any 32x32 cell in an image editor
// and redeploy — slots are stable as long as the country list doesn't change. Re-run:
//   node tools/gen-collectables.js
//
// Requires @napi-rs/canvas (already a server dependency).

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.join(__dirname, '..');
const META = path.join(ROOT, 'public', 'map_meta.json');
const OUT_DIR = path.join(ROOT, 'public', 'collectables');
const CELL = 32, COLS = 16;

// Countries that never appear in-game (mirror client NON_PLAYABLE_IDS).
const NON_PLAYABLE = new Set(['10', '74', '260', '334', '239']);

// Curated items for notable countries: id → { name, shape }.
const CURATED = {
  '36':  { name: 'Boomerang',        shape: 'boomerang' },
  '840': { name: 'Liberty Torch',    shape: 'torch' },
  '826': { name: 'Royal Crown',      shape: 'crown' },
  '250': { name: 'Fine Wine',        shape: 'bottle' },
  '276': { name: 'Beer Stein',       shape: 'stein' },
  '392': { name: 'Katana',           shape: 'sword' },
  '156': { name: 'Golden Dragon',    shape: 'dragon' },
  '643': { name: 'Matryoshka',       shape: 'doll' },
  '76':  { name: 'Football',         shape: 'ball' },
  '124': { name: 'Maple Leaf',       shape: 'leaf' },
  '356': { name: 'Lotus Idol',       shape: 'idol' },
  '380': { name: 'Pizza Slice',      shape: 'pizza' },
  '724': { name: 'Matador Cape',     shape: 'cape' },
  '818': { name: 'Golden Pyramid',   shape: 'pyramid' },
  '484': { name: 'Aztec Mask',       shape: 'mask' },
  '410': { name: 'Celadon Vase',     shape: 'vase' },
  '408': { name: 'Chollima Statue',  shape: 'idol' },
  '792': { name: 'Ottoman Lamp',     shape: 'lamp' },
  '300': { name: 'Amphora',          shape: 'vase' },
  '752': { name: 'Dala Horse',       shape: 'horse' },
  '578': { name: 'Viking Helm',      shape: 'helm' },
  '208': { name: 'Rune Stone',       shape: 'stone' },
  '528': { name: 'Tulip',            shape: 'flower' },
  '756': { name: 'Cuckoo Clock',     shape: 'clock' },
  '616': { name: 'Amber Gem',        shape: 'gem' },
  '804': { name: 'Wheat Sheaf',      shape: 'sheaf' },
  '682': { name: 'Golden Falcon',    shape: 'bird' },
  '364': { name: 'Persian Rug',      shape: 'rug' },
  '376': { name: 'Menorah',          shape: 'menorah' },
  '586': { name: 'Cricket Bat',      shape: 'bat' },
  '360': { name: 'Gamelan Gong',     shape: 'gong' },
  '764': { name: 'Golden Buddha',    shape: 'idol' },
  '704': { name: 'Conical Hat',      shape: 'hat' },
  '608': { name: 'Pearl',            shape: 'pearl' },
  '554': { name: 'Silver Fern',      shape: 'leaf' },
  '710': { name: 'Diamond',          shape: 'gem' },
  '566': { name: 'Tribal Drum',      shape: 'drum' },
  '32':  { name: 'Mate Gourd',       shape: 'gourd' },
  '152': { name: 'Moai Head',        shape: 'moai' },
  '170': { name: 'Emerald',          shape: 'gem' },
  '604': { name: 'Inca Sun Disc',    shape: 'disc' },
  '192': { name: 'Cigar Box',        shape: 'box' },
};

// Generic item pool cycled for everyone else (name + shape).
const GENERICS = [
  { name: 'Ancient Coin',   shape: 'coin' },   { name: 'Royal Gem',     shape: 'gem' },
  { name: 'War Banner',     shape: 'banner' }, { name: 'Bronze Shield', shape: 'shield' },
  { name: 'Ceremonial Pot', shape: 'vase' },   { name: 'Golden Idol',   shape: 'idol' },
  { name: 'Old Compass',    shape: 'disc' },   { name: 'Signet Ring',   shape: 'ring' },
  { name: 'Jade Amulet',    shape: 'amulet' }, { name: 'Iron Blade',    shape: 'sword' },
  { name: 'Woven Basket',   shape: 'box' },    { name: 'Clay Tablet',   shape: 'stone' },
];

// ── tiny 16x16 pixel-art painter, upscaled 2x into the 32x32 cell ────────────
// Each shape is drawn on a 16x16 grid with a small palette. Deterministic per id.
function hashHue(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function pal(id) {
  const hue = hashHue(id);
  return {
    A: `hsl(${hue},68%,52%)`,   // main
    B: `hsl(${hue},72%,34%)`,   // shade
    C: `hsl(${hue},80%,72%)`,   // light
    G: '#e8b93c', g: '#a87e1c', // gold + gold shade
    K: '#1b1410',               // outline
    W: '#f5efe0',               // bone/white
  };
}

// Shape stencils: 16 rows of 16 chars. '.'=transparent, letters = palette keys.
const S = {}; // shape → rows
S.gem = [
  '................','................','....KKKKKKK.....','...KCCCAAABK....',
  '..KCCAAAAABBK...','..KCAAAAAABBK...','..KCAAAAAABBK...','...KAAAAABBK....',
  '....KAAAABBK....','.....KAABBK.....','......KABK......','.......KK.......',
  '................','................','................','................'];
S.coin = [
  '................','.....KKKKK......','...KKGGGGGKK....','..KGGCCGGGGgK...',
  '..KGCCGGGGGgK...','.KGGCGGKKGGGgK..','.KGGGGKGGKGGgK..','.KGGGGKGGKGGgK..',
  '.KGGGGKKKKGGgK..','.KGGGGGGGGGGgK..','..KGGGGGGGGgK...','..KgGGGGGGggK...',
  '...KKgggggKK....','.....KKKKK......','................','................'];
S.crown = [
  '................','................','..K...K...K.....','..KA..KA..KA....',
  '..KAK.KAK.KAK...','..KAAKAAAKAAK...','..KAAAAAAAAAK...','..KGGGGGGGGGK...',
  '..KAAAAAAAAAK...','..KAAAAAAAAAK...','..KKKKKKKKKKK...','................',
  '................','................','................','................'];
S.sword = [
  '..........KK....','.........KWWK...','........KWWK....','.......KWWK.....',
  '......KWWK......','.....KWWK.......','....KWWK........','...KWWK.........',
  '..KKWWK.........','.KGKWK..........','KGGKK...........','KGKGGK..........',
  '.KK.KGK.........','.....KK.........','................','................'];
S.shield = [
  '................','...KKKKKKKK.....','..KAAACCAAAK....','..KAACCCCAAK....',
  '..KAACGGCAAK....','..KAACGGCAAK....','..KAACCCCAAK....','..KAAACCAAAK....',
  '...KAAAAAAK.....','...KBAAAABK.....','....KBAABK......','.....KBBK.......',
  '......KK........','................','................','................'];
S.idol = [
  '................','.....KKKK.......','....KGGGGK......','....KGKKGK......',
  '....KGGGGK......','.....KGGK.......','...KKGGGGKK.....','..KGGGGGGGGK....',
  '..KGKGGGGKGK....','..KGKGGGGKGK....','...KKGGGGKK.....','....KGGGGK......',
  '...KGGGGGGK.....','..KKKKKKKKKK....','................','................'];
S.vase = [
  '................','.....KKKKK......','....KA...AK.....','.....KKKKK......',
  '.....KAAAK......','....KAAAAAK.....','...KAACCAAAK....','...KAACCAAAK....',
  '...KAAAAAAAK....','...KBAAAAABK....','....KBAAABK.....','.....KBABK......',
  '....KKKKKKK.....','................','................','................'];
S.leaf = [
  '................','..........K.....','.........KAK....','........KAAK....',
  '.......KAAAK....','..KK..KAACAK....','..KAKKAACAAK....','...KAAACAAK.....',
  '....KAACAAK.....','...KAACAAK......','..KAACAAK.......','..KACAAK........',
  '..KKAKK.........','...KK...........','................','................'];
S.boomerang = [
  '................','....KK..........','...KAAK.........','...KAAAK........',
  '....KAAAK.......','.....KAAAK......','......KAAAK.....','.......KAAAK....',
  '........KAAAKK..','.........KAAAAK.','..........KAAAK.','...........KKK..',
  '................','................','................','................'];
S.torch = [
  '................','......CC........','.....CAAC.......','.....CAAAC......',
  '......CAAC......','.....GAAAG......','.....KGGGK......','......KGK.......',
  '......KWK.......','......KWK.......','......KWK.......','......KWK.......',
  '.....KKWKK......','......KKK.......','................','................'];
S.ball = [
  '................','.....KKKKK......','...KKWWWWWKK....','..KWWWKKWWWK....',
  '..KWWKAAKWWK....','.KWWWKAAKWWWK...','.KWKKWKKWKKWK...','.KWKAWWWWAKWK...',
  '.KWKAWWWWAKWK...','..KWKWWWWKWK....','..KWWKKKKWWK....','...KKWWWWKK.....',
  '.....KKKKK......','................','................','................'];
S.pizza = [
  '................','...KKKKKKKKK....','..KGGGGGGGGGK...','..KWAWWWAWWK....',
  '...KWWWWWWK.....','...KWAWWAWK.....','....KWWWWK......','....KWAWWK......',
  '.....KWWK.......','.....KWAK.......','......KWK.......','......KK........',
  '................','................','................','................'];
S.mask = [
  '................','....KKKKKKK.....','...KAAAAAAAK....','..KAAAAAAAAAK...',
  '..KAKKAAAKKAK...','..KAAAAAAAAAK...','..KAAKAAAKAAK...','...KAAKKKAAK....',
  '...KGAAAAAGK....','....KGAAAGK.....','.....KGGGK......','......KKK.......',
  '................','................','................','................'];
S.pyramid = [
  '................','................','.......KK.......','......KGGK......',
  '.....KGGGGK.....','....KGGCGGGK....','...KGGCGGGGGK...','..KGGCGGGGGGK...',
  '.KGGCGGGGGGGGK..','KGGGGGGGGGGGGGK.','KKKKKKKKKKKKKKK.','................',
  '................','................','................','................'];
S.doll = [
  '................','.....KKKK.......','....KAAAAK......','...KACCCCAK.....',
  '...KACWWCAK.....','...KACCCCAK.....','....KAAAAK......','...KAAAAAAK.....',
  '..KAACGGCAAK....','..KAACGGCAAK....','..KAAACCAAAK....','...KAAAAAAK.....',
  '....KKKKKK......','................','................','................'];
S.dragon = [
  '................','....KK...KK.....','...KGGK.KGGK....','...KGGGKGGGK....',
  '....KGGGGGK.....','...KGGKGKGGK....','..KGGGGGGGGGK...','..KGKGGGGGKGK...',
  '...KKGGGGGKK....','....KGGGGGK.....','...KGGKKKGGK....','...KGK...KGK....',
  '....K.....K.....','................','................','................'];
// remaining shapes fall back to variations
S.bottle = S.vase; S.stein = S.vase; S.lamp = S.torch; S.horse = S.doll;
S.helm = S.crown; S.stone = S.gem; S.flower = S.leaf; S.clock = S.coin;
S.sheaf = S.leaf; S.bird = S.dragon; S.rug = S.banner = [
  '................','..KKKKKKKKKKK...','..KACACACACAK...','..KCACACACACK...',
  '..KACGGGGGCAK...','..KCAGCCCGACK...','..KACGCWCGCAK...','..KCAGCCCGACK...',
  '..KACGGGGGCAK...','..KCACACACACK...','..KACACACACAK...','..KKKKKKKKKKK...',
  '................','................','................','................'];
S.menorah = S.torch; S.bat = S.sword; S.gong = S.coin; S.hat = S.pyramid;
S.pearl = S.gem; S.drum = S.stein; S.gourd = S.vase; S.moai = S.idol;
S.disc = S.coin; S.box = S.shield; S.ring = S.coin; S.amulet = S.gem; S.cape = S.banner;

function drawItem(ctx, x0, y0, shape, palette) {
  const rows = S[shape] || S.gem;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const ch = rows[y][x];
      if (!ch || ch === '.') continue;
      ctx.fillStyle = palette[ch] || palette.A;
      ctx.fillRect(x0 + x * 2, y0 + y * 2, 2, 2);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const byId = new Map();
for (const m of meta) {
  const id = String(m.id);
  if (!id || NON_PLAYABLE.has(id)) continue;
  if (!m.name || m.name === 'Disputed Territory' || /^Country \d+$/.test(m.name)) continue;
  if (!byId.has(id)) byId.set(id, { id, name: m.name });
}
const countries = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));

const rowsN = Math.ceil(countries.length / COLS);
const canvas = createCanvas(COLS * CELL, rowsN * CELL);
const ctx = canvas.getContext('2d');
const items = {};
let gi = 0;
countries.forEach((c, slot) => {
  const cur = CURATED[c.id];
  const item = cur || GENERICS[gi++ % GENERICS.length];
  const cx = (slot % COLS) * CELL, cy = Math.floor(slot / COLS) * CELL;
  drawItem(ctx, cx, cy, item.shape, pal(c.id));
  items[c.id] = { slot, name: item.name, country: c.name };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'atlas.png'), canvas.toBuffer('image/png'));
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ cell: CELL, cols: COLS, count: countries.length, items }, null, 1));
console.log('collectables:', countries.length, 'items →', rowsN, 'rows;',
  Object.keys(CURATED).filter(id => byId.has(id)).length, 'curated');
