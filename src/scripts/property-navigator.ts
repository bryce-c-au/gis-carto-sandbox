export type Position = [number, number]; // longitude, latitude
export type PolygonGeometry = { type: 'Polygon'; coordinates: Position[][] } | { type: 'MultiPolygon'; coordinates: Position[][][] };
export type LineGeometry = { type: 'LineString'; coordinates: Position[] } | { type: 'MultiLineString'; coordinates: Position[][] };
export type Parcel = { type: 'Feature'; geometry: PolygonGeometry; properties: { lotplan: string; lot?: string; plan?: string; locality?: string; parcel_state?: string } };
export type Road = { type: 'Feature'; geometry: LineGeometry; properties: { road_name_full?: string; class?: string; sub_class?: string; op_status_ind?: string; user_access?: string; trafficability?: string; road_id?: string; segment_id?: string } };
export type Candidate = { road: Road; point: Position; parcelPoint: Position; distance: number; status: string; score: number };

export const PARCEL_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/QSCF_LandParcelPropertyFramework/FeatureServer/120/query';
export const ROAD_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Transportation/RoadsAndTracks/MapServer/10/query';

export function normaliseLotPlan(input: string): string | null {
  const value = input.toUpperCase().replace(/^(LOT\s*)/i, '').replace(/\bPLAN\b/gi, '').replace(/[\s/\\-]+/g, '');
  return /^\d{1,5}[A-Z]{1,5}\d[A-Z0-9]{0,9}$/.test(value) && value.length <= 15 ? value : null;
}

export async function queryGeoJSON<T>(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<T[]> {
  const query = new URLSearchParams({ ...params, f: 'geojson', outSR: '4326', returnGeometry: 'true' });
  const response = await fetch(`${url}?${query}`, { signal });
  if (!response.ok) throw new Error(`Queensland map service returned HTTP ${response.status}.`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Queensland map service returned an error.');
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Queensland map service returned an unexpected response.');
  return data.features as T[];
}

export function parcelRings(parcel: Parcel): Position[][] {
  return parcel.geometry.type === 'Polygon' ? parcel.geometry.coordinates : parcel.geometry.coordinates.flat();
}

export function parcelBounds(parcel: Parcel): [number, number, number, number] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const ring of parcelRings(parcel)) for (const [longitude, latitude] of ring) {
    west = Math.min(west, longitude); south = Math.min(south, latitude);
    east = Math.max(east, longitude); north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

export function expandedBounds(parcel: Parcel, metres: number): string {
  const [west, south, east, north] = parcelBounds(parcel);
  const midLat = (south + north) / 2;
  const latitude = metres / 111_320;
  const longitude = metres / (111_320 * Math.max(0.1, Math.cos(midLat * Math.PI / 180)));
  return [west - longitude, south - latitude, east + longitude, north + latitude].join(',');
}

type XY = { x: number; y: number };
function project(point: Position, latitude: number): XY {
  return { x: point[0] * 111_320 * Math.cos(latitude * Math.PI / 180), y: point[1] * 111_320 };
}
function unproject(point: XY, latitude: number): Position {
  return [point.x / (111_320 * Math.cos(latitude * Math.PI / 180)), point.y / 111_320];
}
function dot(a: XY, b: XY) { return a.x * b.x + a.y * b.y; }
function subtract(a: XY, b: XY): XY { return { x: a.x - b.x, y: a.y - b.y }; }
function add(a: XY, b: XY, t: number): XY { return { x: a.x + b.x * t, y: a.y + b.y * t }; }
function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

// Closest points between finite parcel-edge and road-centreline segments.
function closestSegments(a: XY, b: XY, c: XY, d: XY): { parcel: XY; road: XY; distance: number } {
  const u = subtract(b, a), v = subtract(d, c), w = subtract(a, c);
  const A = dot(u, u), B = dot(u, v), C = dot(v, v), D = dot(u, w), E = dot(v, w);
  const denominator = A * C - B * B;
  let s = denominator > 1e-9 ? clamp((B * E - C * D) / denominator) : 0;
  let t = C > 1e-9 ? clamp((B * s + E) / C) : 0;
  s = A > 1e-9 ? clamp((B * t - D) / A) : 0;
  t = C > 1e-9 ? clamp((B * s + E) / C) : 0;
  const parcel = add(a, u, s), road = add(c, v, t);
  return { parcel, road, distance: Math.hypot(parcel.x - road.x, parcel.y - road.y) };
}

export function nearestRoadPoint(parcel: Parcel, road: Road): { point: Position; parcelPoint: Position; distance: number } | null {
  const lines = road.geometry.type === 'LineString' ? [road.geometry.coordinates] : road.geometry.coordinates;
  const rings = parcelRings(parcel);
  const latitude = (parcelBounds(parcel)[1] + parcelBounds(parcel)[3]) / 2;
  let nearest: ReturnType<typeof closestSegments> | null = null;
  for (const ring of rings) for (let i = 1; i < ring.length; i++) {
    const a = project(ring[i - 1], latitude), b = project(ring[i], latitude);
    for (const line of lines) for (let j = 1; j < line.length; j++) {
      const match = closestSegments(a, b, project(line[j - 1], latitude), project(line[j], latitude));
      if (!nearest || match.distance < nearest.distance) nearest = match;
    }
  }
  return nearest ? { point: unproject(nearest.road, latitude), parcelPoint: unproject(nearest.parcel, latitude), distance: nearest.distance } : null;
}

export function roadStatus(road: Road): { suitable: boolean; label: string; penalty: number } {
  const p = road.properties;
  const operation = (p.op_status_ind || '').toLowerCase();
  const access = (p.user_access || '').toLowerCase();
  const category = `${p.class || ''} ${p.sub_class || ''}`.toLowerCase();
  const traffic = (p.trafficability || '').toLowerCase();
  if (/propos|unconstruct|non.operat|closed|disused/.test(operation)) return { suitable: false, label: 'Not operational or proposed', penalty: 1000 };
  if (/restrict|private|no public|permit/.test(access) || /pedestrian|walkway|footpath|cycleway|bikeway|busway|restricted/.test(category)) return { suitable: false, label: 'Access may be restricted', penalty: 1000 };
  if (/no vehicle|non.vehicle|impassable/.test(traffic)) return { suitable: false, label: 'Not trafficable by vehicle', penalty: 1000 };
  const uncertain = !operation || operation.includes('unknown') || !access || access.includes('unknown') || !traffic || traffic.includes('unknown');
  return { suitable: true, label: uncertain ? 'Mapped road; vehicle access unverified' : 'Mapped operational road; entrance unverified', penalty: uncertain ? 15 : 0 };
}

export function rankRoads(parcel: Parcel, roads: Road[]): Candidate[] {
  const candidates = roads.flatMap(road => {
    const nearest = nearestRoadPoint(parcel, road);
    const status = roadStatus(road);
    if (!nearest || !status.suitable) return [];
    return [{ road, ...nearest, status: status.label, score: nearest.distance + status.penalty }];
  });
  candidates.sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = (candidate.road.properties.road_id || candidate.road.properties.road_name_full || JSON.stringify(candidate.point)).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

export function directionsUrl(point: Position): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${point[1].toFixed(6)},${point[0].toFixed(6)}&travelmode=driving`;
}
