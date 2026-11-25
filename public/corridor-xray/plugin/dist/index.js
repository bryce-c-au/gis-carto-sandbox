const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

function formatChainage(km, startKm = 0) {
  const totalMetres = Math.max(0, Math.round((Number(startKm) + Number(km)) * 1000));
  const kilometres = Math.floor(totalMetres / 1000);
  const metres = totalMetres % 1000;
  return `${kilometres}+${String(metres).padStart(3, "0")}`;
}

function haversineM(a, b) {
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLengthM(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) total += haversineM(coords[i - 1], coords[i]);
  return total;
}

function projectionOrigin(coords) {
  const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  return [lon, lat];
}

function makeProjector(coords) {
  const origin = projectionOrigin(coords);
  const cosLat = Math.max(0.01, Math.cos(origin[1] * DEG));
  return {
    origin,
    project([lon, lat]) {
      return [(lon - origin[0]) * DEG * EARTH_RADIUS_M * cosLat, (lat - origin[1]) * DEG * EARTH_RADIUS_M];
    },
    unproject([x, y]) {
      return [origin[0] + x / (DEG * EARTH_RADIUS_M * cosLat), origin[1] + y / (DEG * EARTH_RADIUS_M)];
    },
  };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function mul(a, s) { return [a[0] * s, a[1] * s]; }
function norm(a) { return Math.hypot(a[0], a[1]); }

function nearestPointOnSegment2D(p, a, b) {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  const t = denom === 0 ? 0 : clamp(dot(sub(p, a), ab) / denom, 0, 1);
  const q = add(a, mul(ab, t));
  return { point: q, t, distance: norm(sub(p, q)) };
}

function nearestPointOnLine(coords, input) {
  const projector = makeProjector([...coords, input]);
  const p = projector.project(input);
  const projected = coords.map(projector.project);
  let best = null;
  let chainageM = 0;
  let priorLengthM = 0;
  for (let i = 1; i < projected.length; i += 1) {
    const a = projected[i - 1];
    const b = projected[i];
    const segmentLength = norm(sub(b, a));
    const hit = nearestPointOnSegment2D(p, a, b);
    if (!best || hit.distance < best.distance) {
      best = { ...hit, segmentIndex: i - 1, pointLngLat: projector.unproject(hit.point) };
      chainageM = priorLengthM + segmentLength * hit.t;
    }
    priorLengthM += segmentLength;
  }
  return { ...best, chainageM };
}

function pointAlongLine(coords, distanceM) {
  if (distanceM <= 0) return coords[0];
  let walked = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const seg = haversineM(coords[i - 1], coords[i]);
    if (walked + seg >= distanceM) {
      const t = seg === 0 ? 0 : (distanceM - walked) / seg;
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
    }
    walked += seg;
  }
  return coords.at(-1);
}

function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }

function segmentIntersection2D(a, b, c, d) {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross2(r, s);
  if (Math.abs(denom) < 1e-10) return null;
  const ca = sub(c, a);
  const t = cross2(ca, s) / denom;
  const u = cross2(ca, r) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: add(a, mul(r, t)), t, u };
}

function crossingAngleDeg(a, b) {
  const an = norm(a); const bn = norm(b);
  if (!an || !bn) return null;
  const cos = clamp(dot(a, b) / (an * bn), -1, 1);
  const raw = Math.acos(cos) / DEG;
  return Math.min(raw, 180 - raw);
}

function lineIntersections(corridorCoords, otherCoords) {
  const projector = makeProjector([...corridorCoords, ...otherCoords]);
  const a = corridorCoords.map(projector.project);
  const b = otherCoords.map(projector.project);
  const hits = [];
  let chainageBefore = 0;
  for (let i = 1; i < a.length; i += 1) {
    const corridorVector = sub(a[i], a[i - 1]);
    const segLength = norm(corridorVector);
    for (let j = 1; j < b.length; j += 1) {
      const otherVector = sub(b[j], b[j - 1]);
      const hit = segmentIntersection2D(a[i - 1], a[i], b[j - 1], b[j]);
      if (hit) {
        hits.push({
          coordinate: projector.unproject(hit.point),
          chainageM: chainageBefore + segLength * hit.t,
          crossingAngleDeg: crossingAngleDeg(corridorVector, otherVector),
          corridorSegmentIndex: i - 1,
          otherSegmentIndex: j - 1,
        });
      }
    }
    chainageBefore += segLength;
  }
  const seen = new Set();
  return hits.filter((hit) => {
    const key = `${hit.coordinate[0].toFixed(7)},${hit.coordinate[1].toFixed(7)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((x, y) => x.chainageM - y.chainageM);
}

function pointInRing(point, ring) {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-20) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function segmentDistance2D(a, b, c, d) {
  const hit = segmentIntersection2D(a, b, c, d);
  if (hit) return { distance: 0, pointOnAB: hit.point, tAB: hit.t };
  const candidates = [
    { x: nearestPointOnSegment2D(c, a, b), onAB: true },
    { x: nearestPointOnSegment2D(d, a, b), onAB: true },
    { x: nearestPointOnSegment2D(a, c, d), onAB: false, fixed: a },
    { x: nearestPointOnSegment2D(b, c, d), onAB: false, fixed: b },
  ];
  candidates.sort((m, n) => m.x.distance - n.x.distance);
  const best = candidates[0];
  if (best.onAB) return { distance: best.x.distance, pointOnAB: best.x.point, tAB: best.x.t };
  return { distance: best.x.distance, pointOnAB: best.fixed, tAB: best.fixed === a ? 0 : 1 };
}

function polygonWithinBuffer(corridorCoords, polygonRing, bufferM) {
  const projector = makeProjector([...corridorCoords, ...polygonRing]);
  const line = corridorCoords.map(projector.project);
  const ring = polygonRing.map(projector.project);
  let best = { distance: Infinity, pointOnLine: line[0], chainageM: 0 };
  let chainageBefore = 0;
  for (let i = 1; i < line.length; i += 1) {
    const segLen = norm(sub(line[i], line[i - 1]));
    for (let j = 1; j < ring.length; j += 1) {
      const test = segmentDistance2D(line[i - 1], line[i], ring[j - 1], ring[j]);
      if (test.distance < best.distance) {
        best = { distance: test.distance, pointOnLine: test.pointOnAB, chainageM: chainageBefore + segLen * test.tAB };
      }
    }
    chainageBefore += segLen;
  }
  const corridorInside = corridorCoords.some((coord) => pointInRing(coord, polygonRing));
  return {
    hit: corridorInside || best.distance <= bufferM,
    distanceM: corridorInside ? 0 : best.distance,
    chainageM: best.chainageM,
    coordinate: projector.unproject(best.pointOnLine),
  };
}

function linePolygonIntervals(corridorCoords, polygonRing) {
  const totalM = lineLengthM(corridorCoords);
  const boundaryHits = lineIntersections(corridorCoords, polygonRing).map((x) => x.chainageM);
  const breakpoints = [0, ...boundaryHits.filter((x) => x > 0.01 && x < totalM - 0.01), totalM]
    .sort((a, b) => a - b)
    .filter((x, i, arr) => i === 0 || Math.abs(x - arr[i - 1]) > 0.05);
  const intervals = [];
  for (let i = 1; i < breakpoints.length; i += 1) {
    const startM = breakpoints[i - 1];
    const endM = breakpoints[i];
    if (endM - startM < 0.05) continue;
    const mid = pointAlongLine(corridorCoords, (startM + endM) / 2);
    if (pointInRing(mid, polygonRing)) {
      intervals.push({
        startM,
        endM,
        lengthM: endM - startM,
        entryCoordinate: pointAlongLine(corridorCoords, startM),
        exitCoordinate: pointAlongLine(corridorCoords, endM),
      });
    }
  }
  return intervals;
}

function makeSimpleBufferPolygon(coords, bufferM) {
  const projector = makeProjector(coords);
  const pts = coords.map(projector.project);
  if (pts.length < 2 || bufferM <= 0) return null;
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i += 1) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dir = sub(next, prev);
    const len = norm(dir) || 1;
    const normal = [-dir[1] / len, dir[0] / len];
    left.push(projector.unproject(add(pts[i], mul(normal, bufferM))));
    right.push(projector.unproject(add(pts[i], mul(normal, -bufferM))));
  }
  const ring = [...left, ...right.reverse(), left[0]];
  return { type: "Feature", properties: { buffer_m: bufferM, note: "Approximate visual corridor buffer" }, geometry: { type: "Polygon", coordinates: [ring] } };
}

function sampleCorridor(coords, requestedIntervalM, maxSamples = 100) {
  const total = lineLengthM(coords);
  const interval = Math.max(25, requestedIntervalM, total / Math.max(2, maxSamples - 1));
  const samples = [];
  for (let d = 0; d < total; d += interval) samples.push({ chainageKm: d / 1000, coordinate: pointAlongLine(coords, d), elevationM: null });
  samples.push({ chainageKm: total / 1000, coordinate: coords.at(-1), elevationM: null });
  return samples.slice(0, maxSamples);
}

function elevationStats(samples) {
  const valid = samples.filter((s) => Number.isFinite(s.elevationM));
  if (!valid.length) return { minElevationM: null, maxElevationM: null, maxSlopePct: null, meanSlopePct: null };
  const slopes = [];
  for (let i = 1; i < valid.length; i += 1) {
    const runM = (valid[i].chainageKm - valid[i - 1].chainageKm) * 1000;
    if (runM <= 0) continue;
    slopes.push(Math.abs((valid[i].elevationM - valid[i - 1].elevationM) / runM * 100));
  }
  return {
    minElevationM: Math.min(...valid.map((s) => s.elevationM)),
    maxElevationM: Math.max(...valid.map((s) => s.elevationM)),
    maxSlopePct: slopes.length ? Math.max(...slopes) : null,
    meanSlopePct: slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : null,
  };
}

function detectSteepSections(samples, thresholdPct = 15) {
  const valid = samples.filter((s) => Number.isFinite(s.elevationM));
  const sections = [];
  let active = null;
  for (let i = 1; i < valid.length; i += 1) {
    const a = valid[i - 1]; const b = valid[i];
    const runM = (b.chainageKm - a.chainageKm) * 1000;
    if (runM <= 0) continue;
    const slopePct = Math.abs((b.elevationM - a.elevationM) / runM * 100);
    if (slopePct >= thresholdPct) {
      if (!active) active = { startKm: a.chainageKm, endKm: b.chainageKm, maxSlopePct: slopePct };
      else { active.endKm = b.chainageKm; active.maxSlopePct = Math.max(active.maxSlopePct, slopePct); }
    } else if (active) {
      sections.push({ ...active, lengthM: (active.endKm - active.startKm) * 1000 });
      active = null;
    }
  }
  if (active) sections.push({ ...active, lengthM: (active.endKm - active.startKm) * 1000 });
  return sections;
}

function makeChainageTicks(coords, intervalM = 1000, startKm = 0) {
  const totalM = lineLengthM(coords);
  const ticks = [];
  for (let d = 0; d <= totalM + 0.01; d += intervalM) {
    ticks.push({ chainageKm: d / 1000, label: formatChainage(d / 1000, startKm), coordinate: pointAlongLine(coords, Math.min(d, totalM)) });
  }
  if (!ticks.length || Math.abs(ticks.at(-1).chainageKm * 1000 - totalM) > 1) {
    ticks.push({ chainageKm: totalM / 1000, label: formatChainage(totalM / 1000, startKm), coordinate: coords.at(-1) });
  }
  return ticks;
}

function corridorBbox(coords) {
  return [Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1])), Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))];
}

function expandBboxM(bbox, metres) {
  const lat = (bbox[1] + bbox[3]) / 2;
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.max(0.1, Math.cos(lat * DEG)));
  return [bbox[0] - dLon, bbox[1] - dLat, bbox[2] + dLon, bbox[3] + dLat];
}

function isLikelyAustralia(coord) {
  return coord[0] >= 112 && coord[0] <= 154.5 && coord[1] >= -44.7 && coord[1] <= -9.0;
}

function mgaZoneForLongitude(lon) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  return clamp(zone, 49, 56);
}

function suggestedGda2020Crs(coord) {
  const zone = mgaZoneForLongitude(coord[0]);
  return { zone, epsg: 7800 + zone, name: `GDA2020 / MGA zone ${zone}` };
}

function estimateJurisdiction([lon, lat]) {
  if (!isLikelyAustralia([lon, lat])) return "Outside Australia";
  if (lat <= -39.0) return "TAS";
  if (lon >= 148.75 && lon <= 149.4 && lat >= -35.95 && lat <= -35.05) return "ACT";
  if (lon < 129) return "WA";
  if (lon < 138 && lat > -26) return "NT";
  if (lon < 141 && lat <= -26) return "SA";
  if (lat > -29.1 && lon >= 138) return "QLD";
  if (lat <= -37.4 && lon >= 141) return "VIC";
  if (lon >= 141 && lat <= -28.0 && lat > -37.8) return "NSW";
  return "Australia";
}

function corridorAustraliaInfo(coords) {
  const mid = pointAlongLine(coords, lineLengthM(coords) / 2);
  const jurisdictions = new Set([coords[0], mid, coords.at(-1)].map(estimateJurisdiction));
  jurisdictions.delete("Australia");
  const crs = suggestedGda2020Crs(mid);
  return {
    midpoint: mid,
    isAustralia: isLikelyAustralia(mid),
    jurisdiction: jurisdictions.size === 1 ? [...jurisdictions][0] : jurisdictions.size > 1 ? `Cross-jurisdiction (${[...jurisdictions].join("/")})` : estimateJurisdiction(mid),
    ...crs,
  };
}




const PANEL_ID = "corridor-xray-au";
let unregisterPanel;
let unregisterMenu;

const OVERLAY = {
  bufferSource: "cxau-buffer-source",
  corridorSource: "cxau-corridor-source",
  eventsSource: "cxau-events-source",
  chainageSource: "cxau-chainage-source",
  bufferFill: "cxau-buffer-fill",
  bufferLine: "cxau-buffer-line",
  corridorCasing: "cxau-corridor-casing",
  corridorLine: "cxau-corridor-line",
  eventsHalo: "cxau-events-halo",
  events: "cxau-events",
  chainageDots: "cxau-chainage-dots",
  chainageLabels: "cxau-chainage-labels",
};

const QLD_SOURCES = {
  roads: {
    name: "QLD Roads & Tracks",
    url: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Transportation/RoadsAndTracks/MapServer/10",
    outFields: "objectid,road_name_full,class,sub_class,surface_type,road_owner,scr_indicator,ste_route_no,nat_route_no",
    custodian: "State of Queensland",
    licence: "CC BY 4.0",
    note: "Queensland Roads and Tracks open data service",
  },
  water: {
    name: "QLD Watercourse Lines",
    url: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/InlandWaters/WaterCoursesAndBodies/MapServer/33",
    outFields: "objectid,name,alternate_name,perenniality,hierarchy,drainage_basin,feature_type,origin,function",
    custodian: "State of Queensland",
    licence: "CC BY 4.0",
    note: "Queensland inland watercourse line mapping",
  },
  protected: {
    name: "QLD Protected Areas & Forests",
    url: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksTerrestrialProtectedAreas/MapServer/10",
    outFields: "objectid,estatename,nameabbrev,esttype,legislated,iucncode,qpwsreg",
    custodian: "State of Queensland",
    licence: "CC BY 4.0",
    note: "Queensland protected areas and forests",
  },
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[c]);
}

function firstGeometry(features, types) {
  return (features || []).find((f) => f?.geometry && types.includes(f.geometry.type)) || null;
}

function getFeatures(app, id) {
  if (!id) return [];
  try { return app.getLayerFeatures?.(id) || []; } catch { return []; }
}

function propertyValue(feature, keys) {
  const p = feature?.properties || {};
  for (const key of keys) {
    const value = p[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return null;
}

function displayName(feature, fallback) {
  return String(propertyValue(feature, [
    "road_name_full", "estatename", "name", "NAME", "Name", "nameabbrev", "feature_name", "FEATURE_NAME", "road_name", "ROAD_NAME", "watercourse", "WATERCOURSE", "alternate_name",
  ]) ?? fallback);
}

function explodeLines(feature) {
  if (!feature?.geometry) return [];
  if (feature.geometry.type === "LineString") return [feature.geometry.coordinates];
  if (feature.geometry.type === "MultiLineString") return feature.geometry.coordinates;
  return [];
}

function explodePolygonRings(feature) {
  if (!feature?.geometry) return [];
  if (feature.geometry.type === "Polygon") return [feature.geometry.coordinates[0]];
  if (feature.geometry.type === "MultiPolygon") return feature.geometry.coordinates.map((p) => p[0]);
  return [];
}

function layerOptions(app) {
  return (app.listLayers?.() || []).map((layer) => {
    const features = getFeatures(app, layer.id).slice(0, 100);
    const kinds = new Set(features.map((f) => f?.geometry?.type).filter(Boolean));
    return { ...layer, kinds };
  });
}

function optionsHtml(layers, predicate) {
  return layers.filter(predicate).map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join("");
}

function getCorridor(app, value) {
  return value === "__drawn__"
    ? firstGeometry(app.getDrawnFeatures?.() || [], ["LineString"])
    : firstGeometry(getFeatures(app, value), ["LineString"]);
}

function roadDetails(feature) {
  const cls = propertyValue(feature, ["class", "CLASS", "road_class"]);
  const stateControlled = propertyValue(feature, ["scr_indicator", "SCR_INDICATOR"]);
  const surface = propertyValue(feature, ["surface_type", "SURFACE_TYPE"]);
  const owner = propertyValue(feature, ["road_owner", "ROAD_OWNER"]);
  const parts = [];
  if (cls) parts.push(String(cls));
  if (String(stateControlled).toUpperCase() === "Y") parts.push("State controlled");
  if (surface) parts.push(String(surface));
  if (owner) parts.push(String(owner));
  return parts.join(" · ");
}

function waterDetails(feature) {
  const hierarchy = propertyValue(feature, ["hierarchy", "HIERARCHY"]);
  const perenniality = propertyValue(feature, ["perenniality", "PERENNIALITY"]);
  const basin = propertyValue(feature, ["drainage_basin", "DRAINAGE_BASIN"]);
  return [hierarchy, perenniality, basin].filter(Boolean).join(" · ");
}

function protectedDetails(feature) {
  const type = propertyValue(feature, ["esttype", "ESTTYPE"]);
  const iucn = propertyValue(feature, ["iucncode", "IUCNCODE"]);
  const legislated = propertyValue(feature, ["legislated", "LEGISLATED"]);
  return [type ? `Estate ${type}` : null, iucn ? `IUCN ${iucn}` : null, legislated].filter(Boolean).join(" · ");
}

function detectCrossings(corridorCoords, features, category) {
  const results = [];
  features.forEach((feature, featureIndex) => {
    explodeLines(feature).forEach((coords, partIndex) => {
      lineIntersections(corridorCoords, coords).forEach((hit, hitIndex) => {
        results.push({
          id: `${category}-${featureIndex}-${partIndex}-${hitIndex}`,
          category,
          eventType: "Crossing",
          name: displayName(feature, `${category} ${featureIndex + 1}`),
          details: category === "Road" ? roadDetails(feature) : waterDetails(feature),
          chainageKm: hit.chainageM / 1000,
          coordinate: hit.coordinate,
          crossingAngleDeg: hit.crossingAngleDeg,
        });
      });
    });
  });
  return results.sort((a, b) => a.chainageKm - b.chainageKm);
}

function detectProtected(corridorCoords, features, bufferM) {
  const events = [];
  const areas = [];
  features.forEach((feature, featureIndex) => {
    const name = displayName(feature, `Protected area ${featureIndex + 1}`);
    const details = protectedDetails(feature);
    const intervals = [];
    let nearest = null;
    explodePolygonRings(feature).forEach((ring) => {
      intervals.push(...linePolygonIntervals(corridorCoords, ring));
      const check = polygonWithinBuffer(corridorCoords, ring, bufferM);
      if (check.hit && (!nearest || check.distanceM < nearest.distanceM)) nearest = check;
    });
    const traversedM = intervals.reduce((sum, i) => sum + i.lengthM, 0);
    if (intervals.length) {
      intervals.forEach((interval, idx) => {
        events.push({
          id: `protected-entry-${featureIndex}-${idx}`,
          category: "Protected area",
          eventType: "Entry",
          name,
          details: `${details}${details ? " · " : ""}${(interval.lengthM / 1000).toFixed(2)} km traversed`,
          chainageKm: interval.startM / 1000,
          coordinate: interval.entryCoordinate,
          areaKey: `p-${featureIndex}`,
        });
        events.push({
          id: `protected-exit-${featureIndex}-${idx}`,
          category: "Protected area",
          eventType: "Exit",
          name,
          details,
          chainageKm: interval.endM / 1000,
          coordinate: interval.exitCoordinate,
          areaKey: `p-${featureIndex}`,
        });
      });
      areas.push({ id: `p-${featureIndex}`, name, details, traversedM, distanceM: 0 });
    } else if (nearest?.hit) {
      events.push({
        id: `protected-near-${featureIndex}`,
        category: "Protected area",
        eventType: "Within buffer",
        name,
        details,
        chainageKm: nearest.chainageM / 1000,
        coordinate: nearest.coordinate,
        distanceM: nearest.distanceM,
        areaKey: `p-${featureIndex}`,
      });
      areas.push({ id: `p-${featureIndex}`, name, details, traversedM: 0, distanceM: nearest.distanceM });
    }
  });
  return { events: events.sort((a, b) => a.chainageKm - b.chainageKm), areas };
}

function detectTerrainEvents(coords, samples, thresholdPct) {
  return detectSteepSections(samples, thresholdPct).map((section, i) => {
    const midKm = (section.startKm + section.endKm) / 2;
    return {
      id: `terrain-${i}`,
      category: "Terrain",
      eventType: "Steep section",
      name: `${section.maxSlopePct.toFixed(1)}% max sampled slope`,
      details: `${(section.lengthM / 1000).toFixed(2)} km section`,
      chainageKm: midKm,
      coordinate: pointAlongLine(coords, midKm * 1000),
      section,
    };
  });
}

async function resolveElevation(app, samples, allowOnline) {
  const map = app.getMap?.();
  if (map?.queryTerrainElevation && map.getTerrain?.()) {
    const resolved = samples.map((s) => ({ ...s, elevationM: map.queryTerrainElevation(s.coordinate) }));
    if (resolved.filter((s) => Number.isFinite(s.elevationM)).length >= Math.ceil(samples.length * 0.8)) {
      return { samples: resolved, source: "GeoLibre terrain" };
    }
  }
  if (allowOnline && samples.length) {
    try {
      const lat = samples.map((s) => s.coordinate[1].toFixed(6)).join(",");
      const lon = samples.map((s) => s.coordinate[0].toFixed(6)).join(",");
      const response = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`);
      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body.elevation) && body.elevation.length === samples.length) {
          return { samples: samples.map((s, i) => ({ ...s, elevationM: Number.isFinite(body.elevation[i]) ? body.elevation[i] : null })), source: "Open-Meteo GLO-90" };
        }
      }
    } catch {}
  }
  return { samples, source: "Unavailable" };
}

async function fetchArcgisGeoJson(layerUrl, bbox, outFields, statusFn) {
  const pageSize = 2000;
  const maxFeatures = 20000;
  const all = [];
  for (let offset = 0; offset < maxFeatures; offset += pageSize) {
    const params = new URLSearchParams({
      where: "1=1",
      outFields,
      geometry: bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: "true",
      geometryPrecision: "6",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "geojson",
    });
    const response = await fetch(`${layerUrl}/query?${params.toString()}`);
    if (!response.ok) throw new Error(`Queensland service returned HTTP ${response.status}.`);
    const body = await response.json();
    if (body?.error) throw new Error(body.error.message || "Queensland ArcGIS service query failed.");
    const features = Array.isArray(body?.features) ? body.features : [];
    all.push(...features);
    statusFn?.(`${all.length.toLocaleString()} features loaded...`);
    if (features.length < pageSize) break;
  }
  if (all.length >= maxFeatures) throw new Error(`Query exceeded ${maxFeatures.toLocaleString()} features. Use a shorter corridor or load a clipped dataset manually.`);
  return { type: "FeatureCollection", features: all };
}


function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function styleNewGeoLibreLayers(app, beforeIds, category) {
  const map = app.getMap?.();
  if (!map) return;
  let layers = [];
  for (let i = 0; i < 10; i++) {
    await wait(35);
    layers = (map.getStyle?.().layers || []).filter((layer) => !beforeIds.has(layer.id));
    if (layers.length) break;
  }
  for (const layer of layers) {
    try {
      if (layer.type === "line") {
        map.setLayoutProperty(layer.id, "line-cap", "round");
        map.setLayoutProperty(layer.id, "line-join", "round");
        if (category === "roads") {
          map.setPaintProperty(layer.id, "line-color", "#8d99aa");
          map.setPaintProperty(layer.id, "line-opacity", 0.58);
          map.setPaintProperty(layer.id, "line-width", ["case", ["==", ["upcase", ["to-string", ["coalesce", ["get", "scr_indicator"], ""]]], "Y"], 2.0, 1.05]);
        } else if (category === "water") {
          map.setPaintProperty(layer.id, "line-color", "#38bdf8");
          map.setPaintProperty(layer.id, "line-opacity", 0.72);
          map.setPaintProperty(layer.id, "line-width", 1.35);
        } else if (category === "protected") {
          map.setPaintProperty(layer.id, "line-color", "#34d399");
          map.setPaintProperty(layer.id, "line-opacity", 0.68);
          map.setPaintProperty(layer.id, "line-width", 1.2);
        }
      } else if (layer.type === "fill" && category === "protected") {
        map.setPaintProperty(layer.id, "fill-color", "#34d399");
        map.setPaintProperty(layer.id, "fill-opacity", 0.09);
        map.setPaintProperty(layer.id, "fill-outline-color", "#34d399");
      } else if (layer.type === "circle") {
        map.setPaintProperty(layer.id, "circle-radius", 3.5);
        map.setPaintProperty(layer.id, "circle-opacity", 0.65);
        map.setPaintProperty(layer.id, "circle-color", category === "water" ? "#38bdf8" : category === "protected" ? "#34d399" : "#8d99aa");
      }
    } catch {}
  }
}

async function addStyledGeoJsonLayer(app, name, data, sourcePath, category) {
  const map = app.getMap?.();
  const before = new Set((map?.getStyle?.().layers || []).map((layer) => layer.id));
  const id = app.addGeoJsonLayer(name, data, sourcePath);
  if (map) await styleNewGeoLibreLayers(app, before, category);
  return id;
}

function removeMapLibreOverlay(app) {
  const map = app.getMap?.();
  if (!map) return;
  const layerIds = [OVERLAY.chainageLabels, OVERLAY.chainageDots, OVERLAY.events, OVERLAY.eventsHalo, OVERLAY.corridorLine, OVERLAY.corridorCasing, OVERLAY.bufferLine, OVERLAY.bufferFill];
  const sourceIds = [OVERLAY.chainageSource, OVERLAY.eventsSource, OVERLAY.corridorSource, OVERLAY.bufferSource];
  for (const id of layerIds) {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch {}
  }
  for (const id of sourceIds) {
    try { if (map.getSource(id)) map.removeSource(id); } catch {}
  }
}

function renderMapLibreOverlay(app, corridorFeature, bufferFeature, events, ticks, startKm) {
  const map = app.getMap?.();
  if (!map || !map.getStyle?.()) return false;
  removeMapLibreOverlay(app);
  try {
    if (bufferFeature) {
      map.addSource(OVERLAY.bufferSource, { type: "geojson", data: { type: "FeatureCollection", features: [bufferFeature] } });
      map.addLayer({
        id: OVERLAY.bufferFill,
        type: "fill",
        source: OVERLAY.bufferSource,
        paint: { "fill-color": "#ff7a45", "fill-opacity": 0.075 },
      });
      map.addLayer({
        id: OVERLAY.bufferLine,
        type: "line",
        source: OVERLAY.bufferSource,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ff7a45", "line-opacity": 0.4, "line-width": 1.2 },
      });
    }

    map.addSource(OVERLAY.corridorSource, { type: "geojson", data: { type: "FeatureCollection", features: [corridorFeature] } });
    map.addLayer({
      id: OVERLAY.corridorCasing,
      type: "line",
      source: OVERLAY.corridorSource,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#18222d", "line-opacity": 0.92, "line-width": 6.5 },
    });
    map.addLayer({
      id: OVERLAY.corridorLine,
      type: "line",
      source: OVERLAY.corridorSource,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ff7a45", "line-opacity": 1, "line-width": 3.6 },
    });

    const eventsData = eventGeoJson(events, startKm);
    map.addSource(OVERLAY.eventsSource, { type: "geojson", data: eventsData });
    const categoryColor = ["match", ["get", "category"], "Road", "#94a3b8", "Watercourse", "#38bdf8", "Protected area", "#34d399", "Terrain", "#f59e0b", "#ffffff"];
    map.addLayer({
      id: OVERLAY.eventsHalo,
      type: "circle",
      source: OVERLAY.eventsSource,
      paint: { "circle-radius": 7.5, "circle-color": "#111827", "circle-opacity": 0.72 },
    });
    map.addLayer({
      id: OVERLAY.events,
      type: "circle",
      source: OVERLAY.eventsSource,
      paint: {
        "circle-radius": ["match", ["get", "category"], "Protected area", 5.7, "Terrain", 5.2, 4.7],
        "circle-color": categoryColor,
        "circle-opacity": 0.96,
        "circle-stroke-color": "#f8fafc",
        "circle-stroke-width": 1.1,
      },
    });

    const ticksData = ticksGeoJson(ticks);
    map.addSource(OVERLAY.chainageSource, { type: "geojson", data: ticksData });
    map.addLayer({
      id: OVERLAY.chainageDots,
      type: "circle",
      source: OVERLAY.chainageSource,
      minzoom: 9,
      paint: { "circle-radius": 2.6, "circle-color": "#f8fafc", "circle-stroke-color": "#18222d", "circle-stroke-width": 1.4, "circle-opacity": 0.94 },
    });
    map.addLayer({
      id: OVERLAY.chainageLabels,
      type: "symbol",
      source: OVERLAY.chainageSource,
      minzoom: 10,
      layout: {
        "text-field": ["get", "chainage"],
        "text-size": 10,
        "text-offset": [0, 1.35],
        "text-anchor": "top",
        "text-allow-overlap": false,
      },
      paint: { "text-color": "#f8fafc", "text-halo-color": "#18222d", "text-halo-width": 1.3, "text-halo-blur": 0.3 },
    });
    return true;
  } catch {
    removeMapLibreOverlay(app);
    return false;
  }
}

function profileSvg(samples, events, startKm) {
  const valid = samples.filter((s) => Number.isFinite(s.elevationM));
  if (valid.length < 2) return `<div class="cx-empty">No elevation profile available.</div>`;
  const w = 420, h = 150, left = 16, right = 10, top = 12, bottom = 26;
  const maxX = Math.max(...valid.map((s) => s.chainageKm));
  const minY = Math.min(...valid.map((s) => s.elevationM));
  const maxY = Math.max(...valid.map((s) => s.elevationM));
  const x = (v) => left + (v / Math.max(.0001, maxX)) * (w - left - right);
  const y = (v) => h - bottom - ((v - minY) / Math.max(1, maxY - minY)) * (h - top - bottom);
  const pts = valid.map((s) => `${x(s.chainageKm).toFixed(1)},${y(s.elevationM).toFixed(1)}`).join(" ");
  const areaPts = `${left},${h-bottom} ${pts} ${x(maxX).toFixed(1)},${h-bottom}`;
  const grid = [0.25, 0.5, 0.75].map((f) => {
    const gx = left + f * (w-left-right);
    return `<line x1="${gx}" y1="${top}" x2="${gx}" y2="${h-bottom}" class="cx-profile-grid"/>`;
  }).join("");
  const marks = events.slice(0, 140).map((e) => {
    const ex = x(e.chainageKm).toFixed(1);
    return `<line class="cx-profile-event" data-event-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category)}" x1="${ex}" y1="${h-bottom-1}" x2="${ex}" y2="${h-bottom-8}"><title>${escapeHtml(`${formatChainage(e.chainageKm,startKm)} ${e.category}: ${e.name}`)}</title></line>`;
  }).join("");
  const strip = events.slice(0, 180).map((e) => `<i class="cx-strip-event" data-category="${escapeHtml(e.category)}" style="left:${Math.max(0, Math.min(100, e.chainageKm/Math.max(.0001,maxX)*100)).toFixed(2)}%" title="${escapeHtml(`${formatChainage(e.chainageKm,startKm)} · ${e.category}`)}"></i>`).join("");
  return `<div class="cx-profile-wrap">
    <svg class="cx-profile" viewBox="0 0 ${w} ${h}" role="img" aria-label="Corridor elevation profile">
      <defs><linearGradient id="cxProfileGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity=".14"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      ${grid}
      <line x1="${left}" y1="${h-bottom}" x2="${w-right}" y2="${h-bottom}" class="cx-axis"/>
      <polygon points="${areaPts}" class="cx-profile-area"/>
      <polyline points="${pts}" fill="none" class="cx-profile-line" stroke-width="2"/>
      ${marks}
      <text x="${left}" y="${h-7}" class="cx-svg-text">${escapeHtml(formatChainage(0,startKm))}</text>
      <text x="${w-right}" y="${h-7}" text-anchor="end" class="cx-svg-text">${escapeHtml(formatChainage(maxX,startKm))}</text>
      <text x="${left}" y="${top}" class="cx-svg-text">${Math.round(maxY)} m</text>
      <text x="${left}" y="${h-bottom-4}" class="cx-svg-text">${Math.round(minY)} m</text>
    </svg>
    <div class="cx-strip"><span class="cx-strip-label">X-RAY</span><span class="cx-strip-track">${strip}</span></div>
  </div>`;
}

function metric(label, value, tone = "") { return `<div class="cx-metric"${tone ? ` data-tone="${escapeHtml(tone)}"` : ""}><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`; }

function filterButton(label, value, active) {
  return `<button type="button" data-cx-filter="${escapeHtml(value)}" class="${active === value ? "is-active" : ""}">${escapeHtml(label)}</button>`;
}

function eventDescription(e) {
  const extras = [];
  if (e.eventType) extras.push(e.eventType);
  if (Number.isFinite(e.crossingAngleDeg)) extras.push(`${e.crossingAngleDeg.toFixed(0)}° crossing`);
  if (Number.isFinite(e.distanceM) && e.distanceM > 0) extras.push(`${e.distanceM.toFixed(0)} m from centreline`);
  if (e.details) extras.push(e.details);
  return extras.join(" · ");
}

function renderSources(state) {
  const used = state.usedSources || [];
  const rows = used.length ? used.map((s) => `<div class="cx-source"><strong>${escapeHtml(s.name)}</strong><span>${escapeHtml(s.custodian)} · ${escapeHtml(s.licence)}</span><small>${escapeHtml(s.note || "")}</small></div>`).join("") : `<div class="cx-empty">Loaded project layers are user supplied. Use the Queensland pack to record built-in source provenance.</div>`;
  return `<details class="cx-sources"><summary>Sources & provenance</summary>${rows}<div class="cx-source"><strong>Elevation</strong><span>${escapeHtml(state.elevationSource || "Not run")}</span><small>Elevation is screening-grade unless you provide an authoritative project DEM/terrain source.</small></div></details>`;
}

function renderResults(root, state, app) {
  const el = root.querySelector("[data-cx-results]");
  if (!state.analysis) {
    el.innerHTML = `<div class="cx-empty">Draw or load an alignment, choose data layers, then run X-Ray AU.</div>`;
    return;
  }
  const a = state.analysis;
  const allEvents = a.events;
  const visible = state.filter === "All" ? allEvents : allEvents.filter((e) => e.category === state.filter);
  const protectedTraversedM = a.protectedAreas.reduce((sum, x) => sum + x.traversedM, 0);
  const roadEvents = a.crossings.filter((x) => x.category === "Road");
  const waterEvents = a.crossings.filter((x) => x.category === "Watercourse");
  const stateControlled = roadEvents.filter((x) => /State controlled/i.test(x.details || "")).length;
  const perennial = waterEvents.filter((x) => /Perennial/i.test(x.details || "")).length;
  const rows = visible.length ? visible.slice(0, 250).map((e) => `<button type="button" class="cx-result-row" data-event-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category)}">
      <i class="cx-event-mark" aria-hidden="true"></i>
      <code>${escapeHtml(formatChainage(e.chainageKm, a.startKm))}</code>
      <span class="cx-event-body"><strong>${escapeHtml(e.category)} · ${escapeHtml(e.name)}</strong><small>${escapeHtml(eventDescription(e))}</small></span>
    </button>`).join("") : `<div class="cx-empty">No events in this category.</div>`;

  el.innerHTML = `
    <section class="cx-analysis-head">
      <div class="cx-analysis-head-top">
        <div class="cx-analysis-title"><strong>Corridor analysis complete</strong><span>${escapeHtml(a.auInfo.jurisdiction)} · ${escapeHtml(a.auInfo.name)} · EPSG:${a.auInfo.epsg}</span></div>
        <span class="cx-au-badge"><i class="cx-au-dot"></i>AU</span>
      </div>
      <div class="cx-head-stats">
        <div class="cx-head-stat"><span>Length</span><strong>${a.lengthKm.toFixed(2)} km</strong></div>
        <div class="cx-head-stat"><span>Events</span><strong>${allEvents.length}</strong></div>
        <div class="cx-head-stat"><span>End chainage</span><strong>${escapeHtml(formatChainage(a.lengthKm, a.startKm))}</strong></div>
      </div>
    </section>

    <section class="cx-section"><h3>Terrain <small>${escapeHtml(state.elevationSource)}</small></h3><div class="cx-grid">
      ${metric("Elevation", a.stats.minElevationM == null ? "-" : `${a.stats.minElevationM.toFixed(0)}-${a.stats.maxElevationM.toFixed(0)} m`, "terrain")}
      ${metric("Max sampled slope", a.stats.maxSlopePct == null ? "-" : `${a.stats.maxSlopePct.toFixed(1)}%`, "terrain")}
      ${metric(`Steep >${a.steepThresholdPct}%`, `${a.terrainEvents.length} section(s)`, "terrain")}
      ${metric("Profile interval", `${a.elevationIntervalM.toFixed(0)} m`)}
    </div>${profileSvg(a.samples, allEvents, a.startKm)}</section>

    <section class="cx-section"><h3>Australian X-Ray <small>${a.bufferM.toFixed(0)} m buffer</small></h3><div class="cx-grid">
      ${metric("Road crossings", `${roadEvents.length}${stateControlled ? ` (${stateControlled} state)` : ""}`, "road")}
      ${metric("Watercourses", `${waterEvents.length}${perennial ? ` (${perennial} perennial)` : ""}`, "water")}
      ${metric("Protected areas", String(a.protectedAreas.length), "protected")}
      ${metric("Protected traversed", `${(protectedTraversedM/1000).toFixed(2)} km`, "protected")}
    </div>
      <div class="cx-legend"><span class="cx-legend-item"><i class="cx-legend-dot road"></i>Road</span><span class="cx-legend-item"><i class="cx-legend-dot water"></i>Water</span><span class="cx-legend-item"><i class="cx-legend-dot protected"></i>Protected</span><span class="cx-legend-item"><i class="cx-legend-dot terrain"></i>Terrain</span></div>
      <div class="cx-advisory">Assessment area ${a.areaKm2.toFixed(2)} km² · Start ${escapeHtml(formatChainage(0, a.startKm))}. Screening calculations use local metric approximations on GeoJSON coordinates; validate engineering-grade measurements in ${escapeHtml(a.auInfo.name)}.</div>
    </section>

    <section class="cx-section"><h3>Event navigator <small>${visible.length}/${allEvents.length}</small></h3>
      <div class="cx-filters">${filterButton("All","All",state.filter)}${filterButton("Roads","Road",state.filter)}${filterButton("Water","Watercourse",state.filter)}${filterButton("Protected","Protected area",state.filter)}${filterButton("Terrain","Terrain",state.filter)}</div>
      <div class="cx-results-list">${rows}</div>
    </section>
    <section class="cx-section"><div class="cx-actions"><button type="button" data-cx-export-csv>Export CSV</button><button type="button" data-cx-export-geojson>Export GeoJSON</button></div></section>
    ${renderSources(state)}`;

  el.querySelectorAll("[data-cx-filter]").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.cxFilter;
    renderResults(root, state, app);
  }));
  el.querySelectorAll("[data-event-id]").forEach((node) => node.addEventListener("click", () => {
    const e = allEvents.find((x) => x.id === node.dataset.eventId);
    if (e) focusEvent(app, e);
  }));
  el.querySelector("[data-cx-export-csv]")?.addEventListener("click", () => exportCsv(a));
  el.querySelector("[data-cx-export-geojson]")?.addEventListener("click", () => exportGeoJson(a));
}

function focusEvent(app, event) {
  const [lon, lat] = event.coordinate;
  const pad = 0.006;
  app.fitBounds?.([lon - pad, lat - pad, lon + pad, lat + pad]);
}

function eventGeoJson(events, startKm) {
  return {
    type: "FeatureCollection",
    features: events.map((e) => ({
      type: "Feature",
      properties: {
        category: e.category,
        event_type: e.eventType,
        name: e.name,
        details: e.details || "",
        chainage: formatChainage(e.chainageKm, startKm),
        chainage_km: +(startKm + e.chainageKm).toFixed(3),
        crossing_angle_deg: Number.isFinite(e.crossingAngleDeg) ? +e.crossingAngleDeg.toFixed(1) : null,
        distance_m: Number.isFinite(e.distanceM) ? +e.distanceM.toFixed(1) : 0,
      },
      geometry: { type: "Point", coordinates: e.coordinate },
    })),
  };
}

function ticksGeoJson(ticks) {
  return { type: "FeatureCollection", features: ticks.map((t) => ({ type: "Feature", properties: { chainage: t.label, chainage_km: t.chainageKm }, geometry: { type: "Point", coordinates: t.coordinate } })) };
}

function downloadBlob(name, type, text) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
}

function exportCsv(analysis) {
  const headers = ["chainage","chainage_km","category","event_type","name","details","crossing_angle_deg","distance_m","longitude","latitude"];
  const rows = analysis.events.map((e) => [
    formatChainage(e.chainageKm, analysis.startKm),
    (analysis.startKm + e.chainageKm).toFixed(3), e.category, e.eventType, e.name, e.details || "",
    Number.isFinite(e.crossingAngleDeg) ? e.crossingAngleDeg.toFixed(1) : "",
    Number.isFinite(e.distanceM) ? e.distanceM.toFixed(1) : "",
    e.coordinate[0].toFixed(7), e.coordinate[1].toFixed(7),
  ]);
  downloadBlob("corridor-xray-au-events.csv", "text/csv;charset=utf-8", [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n"));
}

function exportGeoJson(analysis) {
  downloadBlob("corridor-xray-au-events.geojson", "application/geo+json", JSON.stringify(eventGeoJson(analysis.events, analysis.startKm), null, 2));
}

function getProcessedCorridor(app, selectValue, reverse) {
  const f = getCorridor(app, selectValue);
  if (!f) return null;
  return { ...f, geometry: { ...f.geometry, coordinates: reverse ? [...f.geometry.coordinates].reverse() : [...f.geometry.coordinates] } };
}

function guessLayerId(layers, terms) {
  const hit = layers.find((l) => terms.some((t) => String(l.name || "").toLowerCase().includes(t)));
  return hit?.id || "";
}

function createPanel(app, container) {
  container.classList.add("corridor-xray-panel");
  const state = { analysis: null, elevationSource: "Not run", filter: "All", usedSources: [], qldLayerIds: {} };
  container.innerHTML = `
    <div class="cx-hero"><div class="cx-hero-copy"><strong>Corridor X-Ray AU</strong><span>Australian corridor intelligence for GeoLibre</span></div><span class="cx-version">v0.3</span></div>
    <details class="cx-setup" open>
      <summary>Analysis setup</summary>
      <div class="cx-setup-body"><div class="cx-form">
        <label>Alignment<select data-cx-corridor></select></label>
        <div class="cx-two"><label>Start chainage (km)<input data-cx-start type="number" min="0" step="0.1" value="0"></label><label>Buffer each side (m)<input data-cx-buffer type="number" min="0" step="50" value="250"></label></div>
        <div class="cx-two"><label>Elevation interval (m)<input data-cx-elev type="number" min="50" step="50" value="250"></label><label>Steep threshold (%)<input data-cx-steep type="number" min="1" step="1" value="15"></label></div>
        <div class="cx-two"><label>Chainage ticks (m)<input data-cx-ticks type="number" min="100" step="100" value="1000"></label><label class="cx-check cx-check-box"><input data-cx-reverse type="checkbox"> Reverse alignment</label></div>
        <div class="cx-au-loader"><div><strong>Queensland public data pack</strong><span>Roads, watercourses and protected areas clipped to your corridor.</span></div><button data-cx-qld type="button">Load QLD pack</button></div>
        <label>Road layer<select data-cx-roads></select></label>
        <label>Watercourse layer<select data-cx-water></select></label>
        <label>Protected area layer<select data-cx-protected></select></label>
        <label class="cx-check"><input data-cx-online type="checkbox" checked> Allow online elevation fallback</label>
        <label class="cx-check"><input data-cx-add type="checkbox" checked> Show styled X-Ray overlay and chainage</label>
        <div class="cx-actions"><button data-cx-refresh type="button">Refresh layers</button><button data-cx-run class="cx-primary" type="button">Run X-Ray</button></div>
        <div data-cx-status class="cx-status"></div>
      </div></div>
    </details>
    <div data-cx-results></div>
    <div class="cx-footnote">Screening tool only. Not an engineering survey, environmental approval assessment or route-selection model. Validate against authoritative project data before decision-making.</div>`;

  const corridor = container.querySelector("[data-cx-corridor]");
  const roads = container.querySelector("[data-cx-roads]");
  const water = container.querySelector("[data-cx-water]");
  const protectedSel = container.querySelector("[data-cx-protected]");
  const status = container.querySelector("[data-cx-status]");

  function refresh(preferred = {}) {
    const layers = layerOptions(app);
    const line = (l) => l.kinds.has("LineString") || l.kinds.has("MultiLineString");
    const poly = (l) => l.kinds.has("Polygon") || l.kinds.has("MultiPolygon");
    const old = { corridor: corridor.value, roads: roads.value, water: water.value, protected: protectedSel.value };
    corridor.innerHTML = `<option value="__drawn__">GeoEditor drawn line</option>${optionsHtml(layers, line)}`;
    roads.innerHTML = `<option value="">None</option>${optionsHtml(layers, line)}`;
    water.innerHTML = `<option value="">None</option>${optionsHtml(layers, line)}`;
    protectedSel.innerHTML = `<option value="">None</option>${optionsHtml(layers, poly)}`;
    const setIfExists = (select, value) => { if (value && [...select.options].some((o) => o.value === value)) select.value = value; };
    setIfExists(corridor, preferred.corridor || old.corridor);
    setIfExists(roads, preferred.roads || old.roads || guessLayerId(layers, ["road", "transport"]));
    setIfExists(water, preferred.water || old.water || guessLayerId(layers, ["watercourse", "hydro", "river", "creek"]));
    setIfExists(protectedSel, preferred.protected || old.protected || guessLayerId(layers, ["protected", "park", "reserve"]));
    status.textContent = `${layers.length} layer(s) inspected.`;
  }

  async function loadQueenslandPack() {
    const btn = container.querySelector("[data-cx-qld]");
    btn.disabled = true;
    try {
      const f = getProcessedCorridor(app, corridor.value, container.querySelector("[data-cx-reverse]").checked);
      if (!f) throw new Error("Draw or select an alignment before loading the Queensland data pack.");
      const coords = f.geometry.coordinates;
      const auInfo = corridorAustraliaInfo(coords);
      if (!auInfo.isAustralia) throw new Error("The selected alignment does not appear to be in Australia.");
      if (!String(auInfo.jurisdiction).includes("QLD")) throw new Error(`Queensland pack not loaded because the corridor is estimated as ${auInfo.jurisdiction}. Load local jurisdiction data manually for now.`);
      const bufferM = Math.max(500, Number(container.querySelector("[data-cx-buffer]").value) || 250);
      const bbox = expandBboxM(corridorBbox(coords), bufferM + 500);
      const loaded = {};
      for (const [key, source] of Object.entries(QLD_SOURCES)) {
        status.textContent = `Loading ${source.name}...`;
        const data = await fetchArcgisGeoJson(source.url, bbox, source.outFields, (msg) => { status.textContent = `${source.name}: ${msg}`; });
        loaded[key] = await addStyledGeoJsonLayer(app, `${source.name} · Corridor X-Ray AU`, data, source.url, key);
      }
      state.qldLayerIds = loaded;
      state.usedSources = Object.values(QLD_SOURCES);
      refresh({ roads: loaded.roads, water: loaded.water, protected: loaded.protected });
      status.textContent = "Queensland pack loaded and selected. Run X-Ray AU.";
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally { btn.disabled = false; }
  }

  async function run() {
    const btn = container.querySelector("[data-cx-run]");
    btn.disabled = true;
    status.textContent = "Running Australian corridor analysis...";
    try {
      const reverse = container.querySelector("[data-cx-reverse]").checked;
      const f = getProcessedCorridor(app, corridor.value, reverse);
      if (!f) throw new Error("No single LineString alignment found. Draw one with GeoEditor or select a line layer.");
      const coords = f.geometry.coordinates;
      const bufferM = Number(container.querySelector("[data-cx-buffer]").value);
      const elevationIntervalM = Number(container.querySelector("[data-cx-elev]").value);
      const steepThresholdPct = Number(container.querySelector("[data-cx-steep]").value);
      const tickIntervalM = Number(container.querySelector("[data-cx-ticks]").value);
      const startKm = Number(container.querySelector("[data-cx-start]").value);
      if (!Number.isFinite(bufferM) || bufferM < 0) throw new Error("Buffer must be zero or greater.");
      if (!Number.isFinite(elevationIntervalM) || elevationIntervalM < 50) throw new Error("Elevation interval must be at least 50 m.");
      if (!Number.isFinite(steepThresholdPct) || steepThresholdPct <= 0) throw new Error("Steep threshold must be greater than zero.");
      if (!Number.isFinite(tickIntervalM) || tickIntervalM < 100) throw new Error("Chainage tick interval must be at least 100 m.");
      if (!Number.isFinite(startKm) || startKm < 0) throw new Error("Start chainage must be zero or greater.");

      const auInfo = corridorAustraliaInfo(coords);
      if (!auInfo.isAustralia) throw new Error("Corridor X-Ray AU expects a corridor in Australia.");
      const roadHits = detectCrossings(coords, getFeatures(app, roads.value), "Road");
      const waterHits = detectCrossings(coords, getFeatures(app, water.value), "Watercourse");
      const protectedResult = detectProtected(coords, getFeatures(app, protectedSel.value), bufferM);
      const raw = sampleCorridor(coords, elevationIntervalM, 100);
      const elev = await resolveElevation(app, raw, container.querySelector("[data-cx-online]").checked);
      const stats = elevationStats(elev.samples);
      const terrainEvents = detectTerrainEvents(coords, elev.samples, steepThresholdPct);
      const lenM = lineLengthM(coords);
      const crossings = [...roadHits, ...waterHits].sort((a, b) => a.chainageKm - b.chainageKm);
      const events = [...crossings, ...protectedResult.events, ...terrainEvents].sort((a, b) => a.chainageKm - b.chainageKm);
      const ticks = makeChainageTicks(coords, tickIntervalM, startKm);
      state.analysis = {
        lengthKm: lenM / 1000,
        bufferM,
        areaKm2: (2 * bufferM * lenM + Math.PI * bufferM * bufferM) / 1e6,
        crossings,
        protectedEvents: protectedResult.events,
        protectedAreas: protectedResult.areas,
        terrainEvents,
        events,
        samples: elev.samples,
        stats,
        ticks,
        startKm,
        elevationIntervalM,
        steepThresholdPct,
        auInfo,
      };
      state.elevationSource = elev.source;
      state.filter = "All";

      const showOverlay = container.querySelector("[data-cx-add]").checked;
      const visualBuffer = makeSimpleBufferPolygon(coords, bufferM);
      if (showOverlay) {
        const styled = renderMapLibreOverlay(app, f, visualBuffer, events, ticks, startKm);
        if (!styled) {
          if (visualBuffer) app.addGeoJsonLayer("CX AU Corridor Buffer (approx.)", { type: "FeatureCollection", features: [visualBuffer] });
          app.addGeoJsonLayer("CX AU Events", eventGeoJson(events, startKm));
          app.addGeoJsonLayer("CX AU Chainage", ticksGeoJson(ticks));
        }
      } else {
        removeMapLibreOverlay(app);
      }
      app.fitBounds?.(corridorBbox(coords));
      renderResults(container, state, app);
      container.querySelector(".cx-setup")?.removeAttribute("open");
      status.textContent = `Complete: ${events.length} event(s) · ${auInfo.jurisdiction} · EPSG:${auInfo.epsg} suggested.`;
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    } finally { btn.disabled = false; }
  }

  const refreshBtn = container.querySelector("[data-cx-refresh]");
  const runBtn = container.querySelector("[data-cx-run]");
  const qldBtn = container.querySelector("[data-cx-qld]");
  const onRefresh = () => refresh();
  refreshBtn.addEventListener("click", onRefresh);
  runBtn.addEventListener("click", run);
  qldBtn.addEventListener("click", loadQueenslandPack);
  refresh();
  renderResults(container, state, app);
  return () => {
    refreshBtn.removeEventListener("click", onRefresh);
    runBtn.removeEventListener("click", run);
    qldBtn.removeEventListener("click", loadQueenslandPack);
    removeMapLibreOverlay(app);
  };
}

const plugin = {
  id: "corridor-xray-au",
  name: "Corridor X-Ray AU",
  version: "0.3.0",
  engines: ["maplibre", "cesium"],
  activate(app) {
    unregisterPanel = app.registerRightPanel?.({ id: PANEL_ID, title: "Corridor X-Ray AU", defaultWidth: 450, dock: "replace-style", render: (container) => createPanel(app, container) });
    unregisterMenu = app.registerToolbarMenu?.({ id: "corridor-xray-au-menu", label: "Corridor X-Ray AU", items: [{ id: "open", label: "Open X-Ray AU panel", onSelect: () => app.openRightPanel?.(PANEL_ID) }] });
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate(app) {
    app.closeRightPanel?.(PANEL_ID);
    unregisterMenu?.(); unregisterPanel?.();
    unregisterMenu = undefined; unregisterPanel = undefined;
  },
};

export { plugin };
export default plugin;
