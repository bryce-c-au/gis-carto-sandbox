import test from 'node:test';
import assert from 'node:assert/strict';
import { directionsUrl, nearestRoadPoint, normaliseLotPlan, rankRoads, roadStatus } from '../src/scripts/property-navigator.ts';

const parcel = { type: 'Feature', properties: { lotplan: '4RP102393' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] } };
const road = (name, latitude, extra = {}) => ({ type: 'Feature', properties: { road_name_full: name, op_status_ind: 'Operational', user_access: 'Public', trafficability: 'Trafficable', class: 'Local', ...extra }, geometry: { type: 'LineString', coordinates: [[-0.001, latitude], [0.002, latitude]] } });

test('accepts standard lot/plan forms without allowing arbitrary query text', () => {
  assert.equal(normaliseLotPlan('4 RP102393'), '4RP102393');
  assert.equal(normaliseLotPlan('12/SP345678'), '12SP345678');
  assert.equal(normaliseLotPlan("4RP102393' OR 1=1"), null);
});

test('measures to the parcel boundary, not its centre or road vertices', () => {
  const nearest = nearestRoadPoint(parcel, road('Frontage', -0.0001));
  assert.ok(nearest);
  assert.ok(Math.abs(nearest.distance - 11.132) < 0.1);
  assert.ok(nearest.point[0] >= 0 && nearest.point[0] <= 0.001);
  assert.ok(Math.abs(nearest.point[1] + 0.0001) < 1e-8);
});

test('prefers a plausible frontage over a closer restricted road', () => {
  const ranked = rankRoads(parcel, [road('Restricted', 0.00102, { user_access: 'Restricted' }), road('Frontage', -0.0001), road('Farther', -0.0003)]);
  assert.equal(ranked[0].road.properties.road_name_full, 'Frontage');
  assert.equal(ranked.length, 2);
});

test('handles multipart roads and no road geometry', () => {
  const multipart = road('Multipart', 0.01);
  multipart.geometry = { type: 'MultiLineString', coordinates: [[[-0.001, 0.01], [0.002, 0.01]], [[-0.001, -0.0002], [0.002, -0.0002]]] };
  assert.ok(nearestRoadPoint(parcel, multipart).distance < 23);
  assert.equal(nearestRoadPoint(parcel, { ...multipart, geometry: { type: 'MultiLineString', coordinates: [] } }), null);
});

test('flags proposed roads and creates a coordinate destination', () => {
  assert.equal(roadStatus(road('Unbuilt', 0, { op_status_ind: 'Proposed' })).suitable, false);
  assert.equal(directionsUrl([153.0692, -27.49945]), 'https://www.google.com/maps/dir/?api=1&destination=-27.499450,153.069200&travelmode=driving');
});
