// Pixel-level analysis: where does the user's background image actually render?
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/31259/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/sharp');

const shot = await sharp('.page-shot.png').raw().toBuffer({ resolveWithObject: true });
const { data: px, info } = shot;
const { width: W, height: H, channels: C } = info;
console.log('screenshot:', W + 'x' + H);

// source image
const dataUrl = readFileSync('.bg-image.txt', 'utf8');
const b64 = dataUrl.split(',')[1];
const src = await sharp(Buffer.from(b64, 'base64')).raw().toBuffer({ resolveWithObject: true });
const { data: spx, info: sinfo } = src;
console.log('source image:', sinfo.width + 'x' + sinfo.height);

const sample = (img, w, h, ch, x, y) => {
  const i = (y * w + x) * ch;
  return [img[i], img[i + 1], img[i + 2]];
};

// compare source (scaled to viewport via cover) with screenshot regions
// backgroundSize: cover -> scale = max(W/sw, H/sh)
const sw = sinfo.width, sh = sinfo.height;
const scale = Math.max(W / sw, H / sh);
const cw = sw * scale, ch = sh * scale;
const ox = (W - cw) / 2, oy = (H - ch) / 2;
const srcAt = (x, y) => {
  const sx = Math.floor((x - ox) / scale);
  const sy = Math.floor((y - oy) / scale);
  if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) return null;
  return sample(spx, sw, sh, sinfo.channels, sx, sy);
};

// sample grid across the viewport; compare screenshot pixel vs expected source pixel
const regions = [
  ['sidebar-top', 40, 100], ['sidebar-mid', 40, 400], ['sidebar-bottom', 40, 700],
  ['content-top', 800, 100], ['content-mid', 800, 400], ['content-bottom', 800, 700],
  ['center', 633, 450],
  ['bottom-edge', 633, H - 30],
];
console.log('\nregion        screenshot  source(cover-scaled)  match');
for (const [name, x, y] of regions) {
  const got = sample(px, W, H, C, x, y);
  const exp = srcAt(x, y);
  let match = 'n/a';
  if (exp) {
    const diff = Math.abs(got[0] - exp[0]) + Math.abs(got[1] - exp[1]) + Math.abs(got[2] - exp[2]);
    match = diff < 120 ? 'MATCH' : 'diff=' + diff;
  }
  console.log(name.padEnd(14), got.join(','), ' ', exp ? exp.join(',') : '  none       ', ' ', match);
}

// full-page coverage estimate: fraction of pixels where screenshot differs a lot from source (sample grid 20px)
let diffCount = 0, total = 0;
for (let y = 0; y < H; y += 20) {
  for (let x = 0; x < W; x += 20) {
    const exp = srcAt(x, y);
    if (!exp) continue;
    const got = sample(px, W, H, C, x, y);
    const diff = Math.abs(got[0] - exp[0]) + Math.abs(got[1] - exp[1]) + Math.abs(got[2] - exp[2]);
    total++;
    if (diff > 150) diffCount++;
  }
}
console.log('\ncoverage: sampled', total, 'points, differing:', diffCount, '(' + (100 * diffCount / total).toFixed(1) + '%)');
process.exit(0);
