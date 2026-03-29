const { Resvg } = require('@resvg/resvg-js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3] || svgPath.replace('.svg', '.png'));
const size = parseInt(process.argv[4] || '1024');

const svg = fs.readFileSync(svgPath, 'utf-8');

// Render SVG at high resolution
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 2048 },
});

const rendered = resvg.render();
const pngBuffer = rendered.asPng();

// Center in a square canvas with transparent background
sharp(pngBuffer)
  .resize({
    width: size,
    height: size,
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  })
  .ensureAlpha()
  .png({ compressionLevel: 9 })
  .toFile(outPath)
  .then(() => {
    console.log(`Saved ${size}x${size} PNG to ${outPath}`);
    // Verify alpha channel
    return sharp(outPath).metadata();
  })
  .then(meta => {
    console.log(`Channels: ${meta.channels}, hasAlpha: ${meta.hasAlpha}, Format: ${meta.format}`);
  })
  .catch(err => console.error(err));
