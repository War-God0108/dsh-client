// Generate the DSH CLIENT app icon: deep-sea cockpit diamond on navy grid.
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/31259/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/sharp');

const S = 1024; // master canvas
const svg = `
<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="#0e1a26"/>
      <stop offset="55%" stop-color="#0a1119"/>
      <stop offset="100%" stop-color="#060a0f"/>
    </radialGradient>
    <linearGradient id="dia" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5ff0e8"/>
      <stop offset="100%" stop-color="#1f9d97"/>
    </linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="18" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- navy cockpit background -->
  <rect width="${S}" height="${S}" fill="url(#bg)"/>

  <!-- sonar rings -->
  <g fill="none" stroke="#16303f" stroke-width="6">
    <circle cx="512" cy="470" r="340"/>
    <circle cx="512" cy="470" r="262"/>
    <circle cx="512" cy="470" r="184"/>
  </g>
  <!-- crosshair ticks -->
  <g stroke="#1d3f52" stroke-width="6">
    <line x1="512" y1="96" x2="512" y2="150"/>
    <line x1="512" y1="790" x2="512" y2="844"/>
    <line x1="138" y1="470" x2="192" y2="470"/>
    <line x1="832" y1="470" x2="886" y2="470"/>
  </g>

  <!-- faint grid -->
  <g stroke="#12222f" stroke-width="3" opacity="0.8">
    <line x1="256" y1="130" x2="256" y2="810"/>
    <line x1="768" y1="130" x2="768" y2="810"/>
    <line x1="130" y1="256" x2="894" y2="256"/>
    <line x1="130" y1="684" x2="894" y2="684"/>
  </g>

  <!-- the diamond glyph -->
  <g filter="url(#glow)">
    <polygon points="512,196 788,470 512,744 236,470" fill="none" stroke="url(#dia)" stroke-width="34" stroke-linejoin="round"/>
  </g>
  <!-- inner node -->
  <circle cx="512" cy="470" r="46" fill="url(#dia)"/>
  <circle cx="512" cy="470" r="18" fill="#05100f"/>
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
