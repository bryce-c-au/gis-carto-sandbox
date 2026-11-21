// Render a static portfolio preview from the bundled Yale Bright Star Catalog.
// Representative view: Carnarvon Gorge, 22 November 2026, 9 pm Brisbane time.
import { readFile, writeFile } from 'node:fs/promises';

const stars = JSON.parse(await readFile(new URL('../public/data/bright-stars.json', import.meta.url), 'utf8'));
const width = 1200, height = 750, pitch = 0.35, latitude = -25.06, longitude = 148.25;
const time = new Date('2026-11-22T21:00:00+10:00');
const jd = time.getTime() / 86400000 + 2440587.5;
const sidereal = (280.46061837 + 360.98564736629 * (jd - 2451545) + longitude) % 360;
const radians = degrees => degrees * Math.PI / 180;
const phi = radians(latitude);
const focal = height / (2 * Math.tan(radians(72 / 2)));
const circles = [];
for (const [ra, dec, magnitude, kelvin] of stars) {
  const delta = radians(dec), hourAngle = radians(sidereal - ra);
  const up = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle);
  if (up <= 0) continue;
  const east = -Math.cos(delta) * Math.sin(hourAngle);
  const north = Math.sin(delta) * Math.cos(phi) - Math.cos(delta) * Math.sin(phi) * Math.cos(hourAngle);
  const south = -north;
  const depth = up * Math.sin(pitch) + south * Math.cos(pitch);
  if (depth <= 0) continue;
  const x = width / 2 - east / depth * focal;
  const y = height / 2 - (up * Math.cos(pitch) - south * Math.sin(pitch)) / depth * focal;
  if (x < 0 || x > width || y < 0 || y > 580) continue;
  const radius = magnitude < 0.5 ? 3.3 : magnitude < 2 ? 2.3 : magnitude < 4 ? 1.4 : 0.8;
  const fill = kelvin < 4000 ? '#ffd2a1' : kelvin > 9000 ? '#b9d4ff' : '#fff2dc';
  const opacity = magnitude > 4 ? 0.6 : 0.9;
  circles.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}" fill="${fill}" opacity="${opacity}"/>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><defs><radialGradient id="sky" cx="50%" cy="90%" r="95%"><stop stop-color="#254251"/><stop offset=".5" stop-color="#0d1d31"/><stop offset="1" stop-color="#040b17"/></radialGradient></defs><rect width="1200" height="750" fill="url(#sky)"/>${circles.join('')}<path d="M0 566 Q600 555 1200 566 L1200 750 H0Z" fill="#111b22"/><path d="M0 566 Q600 555 1200 566" fill="none" stroke="#70939a" stroke-opacity=".65" stroke-width="2"/><text x="600" y="548" text-anchor="middle" fill="#86d5de" font-family="Arial,sans-serif" font-size="27" font-weight="bold">S</text></svg>`;
await writeFile(new URL('../public/images/night-sky-card.svg', import.meta.url), svg);
console.log(`Wrote ${circles.length} stars to night-sky-card.svg`);
