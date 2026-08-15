// Generate the Deepseek Harness app icon: the official white whale
// (build/whale.svg, from the DSH web UI favicon) on a deep navy rounded square.
import { createRequire } from 'node:module';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/31259/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/sharp');

const S = 1024; // master canvas

// Pull the whale path out of build/whale.svg
const whaleSrc = await readFile('build/whale.svg', 'utf8');
const dMatch = whaleSrc.match(/<path[^>]*\bd="([^"]+)"/);
if (!dMatch) throw new Error('whale.svg: path element not found');
const WHALE_PATH = dMatch[1];

// Scale the 50x50 whale onto the canvas (~78% of it, optically centered)
const scale = (S * 0.78) / 50;
const offset = (S - 50 * scale) / 2;

const svg = `
<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="85%">
      <stop offset="0%" stop-color="#13212f"/>
      <stop offset="60%" stop-color="#0b1017"/>
      <stop offset="100%" stop-color="#06090d"/>
    </radialGradient>
  </defs>

  <!-- deep navy rounded square -->
  <rect x="24" y="24" width="976" height="976" rx="210" fill="url(#bg)"/>

  <!-- the white whale -->
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(4)})">
    <path d="${WHALE_PATH}" fill="#ffffff"/>
  </g>
</svg>`;

await mkdir('build', { recursive: true });
await writeFile('build/icon.svg', svg);

// PNG sizes for various uses
for (const size of [256, 512, 1024]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(`build/icon-${size}.png`);
}

// ICO with multiple sizes (16..256) for Windows
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoBuffers = await Promise.all(
  icoSizes.map((s) => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()),
);
await writeIco('build/icon.ico', icoSizes, icoBuffers);
console.log('icons written: build/icon.ico, build/icon-{256,512,1024}.png');

/** Minimal ICO writer (PNG-compressed entries, Vista+). */
async function writeIco(path, sizes, pngBuffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + 16 * sizes.length;
  for (let i = 0; i < sizes.length; i++) {
    const e = Buffer.alloc(16);
    const s = sizes[i];
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(pngBuffers[i].length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += pngBuffers[i].length;
  }
  await writeFile(path, Buffer.concat([header, ...entries, ...pngBuffers]));
}
