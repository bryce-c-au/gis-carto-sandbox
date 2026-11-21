// Build the homepage silhouette from Natural Earth 1:50m Admin-0 countries
// (public domain: https://www.naturalearthdata.com/about/terms-of-use/).
// Usage: node scripts/build-australia-outline.mjs path/to/ne_50m_admin_0_countries.geojson
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const source = process.argv[2];
if (!source) throw new Error('Pass the Natural Earth countries GeoJSON path.');
const data = JSON.parse(await readFile(source, 'utf8'));
const australia = data.features.find(feature => feature.properties.ADMIN === 'Australia');
if (!australia) throw new Error('Australia feature not found.');

const width = 2400, height = 2365;
const west = 113.0, east = 158.0, north = -9.5, south = -56.2;
const x = longitude => (longitude - west) / (east - west) * width;
const y = latitude => (north - latitude) / (north - south) * height;
const polygons = australia.geometry.type === 'MultiPolygon' ? australia.geometry.coordinates : [australia.geometry.coordinates];
const paths = polygons.map(polygon => polygon.map(ring => ring.map(([lon, lat], index) =>
  `${index ? 'L' : 'M'}${x(lon).toFixed(1)} ${y(lat).toFixed(1)}`).join(' ') + 'Z').join(' '));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><g fill="#18232d" stroke="#647e87" stroke-width="4" stroke-linejoin="round" stroke-opacity=".8">${paths.map(path => `<path d="${path}"/>`).join('')}</g></svg>`;
await writeFile(new URL('../public/images/australia-outline.svg', import.meta.url), svg);
const outline = await sharp(Buffer.from(svg)).png().toBuffer();
await sharp(outline)
  .composite([{ input: fileURLToPath(new URL('../public/images/sky-atlas-card.webp', import.meta.url)), blend: 'screen' }])
  .webp({ quality: 90, effort: 6 })
  .toFile(fileURLToPath(new URL('../public/images/sky-atlas-card-outlined.webp', import.meta.url)));
console.log(`Wrote ${paths.length} Natural Earth polygons and the outlined card image`);
