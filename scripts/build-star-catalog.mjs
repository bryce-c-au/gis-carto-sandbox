// Derive a compact web catalog from the MIT-licensed Yale Bright Star Catalog JSON:
// https://github.com/brettonw/YaleBrightStarCatalog/blob/master/bsc5-short.json
// Usage: node scripts/build-star-catalog.mjs path/to/bsc5-short.json
import { readFile, writeFile } from 'node:fs/promises';

const source = process.argv[2];
if (!source) throw new Error('Pass the downloaded bsc5-short.json path.');
const stars = JSON.parse(await readFile(source, 'utf8'));
const raDegrees = value => {
  const match = value?.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/);
  return match ? +(15 * (+match[1] + +match[2] / 60 + +match[3] / 3600)).toFixed(5) : NaN;
};
const decDegrees = value => {
  const match = value?.match(/([+-])(\d+)°\s*(\d+)′\s*([\d.]+)″/);
  return match ? +((match[1] === '-' ? -1 : 1) * (+match[2] + +match[3] / 60 + +match[4] / 3600)).toFixed(5) : NaN;
};
const compact = stars.flatMap(star => {
  const ra = raDegrees(star.RA);
  const dec = decDegrees(star.Dec);
  const mag = Number(star.V);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mag) || mag > 6.3) return [];
  return [[ra, dec, mag, Number(star.K) || 5500, star.N || '']];
});
const path = new URL('../public/data/bright-stars.json', import.meta.url);
await writeFile(path, JSON.stringify(compact));
console.log(`Wrote ${compact.length} stars to ${path.pathname}`);
