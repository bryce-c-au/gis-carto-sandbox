import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { PARCEL_URL, ROAD_URL, directionsUrl, expandedBounds, normaliseLotPlan, parcelBounds, queryGeoJSON, rankRoads, roadStatus, type Candidate, type Parcel, type Position, type Road } from './property-navigator';

const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const form = element<HTMLFormElement>('#search-form');
const input = element<HTMLInputElement>('#lotplan');
const status = element<HTMLElement>('#status');
const results = element<HTMLElement>('#search-results');
const panel = element<HTMLElement>('#property-panel');
const candidateList = element<HTMLElement>('#candidate-list');
const destinationSource = element<HTMLElement>('#destination-source');
const destinationCoordinates = element<HTMLElement>('#destination-coordinates');
const navigate = element<HTMLAnchorElement>('#navigate');
const copyCoordinates = element<HTMLButtonElement>('#copy-coordinates');
const resetSuggestion = element<HTMLButtonElement>('#reset-suggestion');
const manualButton = element<HTMLButtonElement>('#manual-point');
const showParcels = element<HTMLInputElement>('#show-parcels');
const parcelOverlayStatus = element<HTMLElement>('#parcel-overlay-status');

const map = L.map('property-map', { zoomControl: false }).setView([-27.47, 153.02], 13);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).addTo(map);

let parcel: Parcel | null = null;
let candidates: Candidate[] = [];
let selectedSuggestion: Candidate | null = null;
let destination: Position | null = null;
let manualMode = false;
let requestController: AbortController | null = null;
let parcelLayer: L.GeoJSON | null = null;
let roadsLayer: L.GeoJSON | null = null;
let destinationMarker: L.Marker | null = null;
let gpsMarker: L.CircleMarker | null = null;
const candidateMarkers = L.layerGroup().addTo(map);
map.createPane('parcel-context').style.zIndex = '350';
let surroundingParcels: L.GeoJSON | null = null;
let parcelOverlayController: AbortController | null = null;
let parcelOverlayTimer: ReturnType<typeof setTimeout> | null = null;
const PARCEL_LIMIT = 750;
const validParcels = (features: Parcel[]) => features.filter(feature =>
  feature?.properties?.lotplan && feature.geometry &&
  (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') &&
  feature.geometry.coordinates.length,
);
const validRoads = (features: Road[]) => features.filter(feature =>
  feature?.properties && feature.geometry &&
  (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') &&
  feature.geometry.coordinates.length,
);

function clearSurroundingParcels() {
  if (parcelOverlayTimer) clearTimeout(parcelOverlayTimer);
  parcelOverlayTimer = null;
  parcelOverlayController?.abort();
  parcelOverlayController = null;
  surroundingParcels?.remove();
  surroundingParcels = null;
}
function scheduleSurroundingParcels() {
  if (parcelOverlayTimer) clearTimeout(parcelOverlayTimer);
  parcelOverlayController?.abort();
  if (!showParcels.checked || map.getZoom() < 17) {
    clearSurroundingParcels();
    parcelOverlayStatus.textContent = showParcels.checked ? 'Zoom to level 17 for lot boundaries; lot numbers appear at level 18.' : 'Lot boundaries hidden.';
    return;
  }
  parcelOverlayTimer = setTimeout(() => void loadSurroundingParcels(), 350);
}
async function loadSurroundingParcels() {
  const controller = new AbortController();
  parcelOverlayController = controller;
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  parcelOverlayStatus.textContent = 'Loading surrounding lot boundaries…';
  try {
    const response = await queryGeoJSON<Parcel>(PARCEL_URL, {
      where: '1=1', geometry: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'lotplan,lot,plan', resultRecordCount: String(PARCEL_LIMIT),
    }, signal(controller));
    if (controller.signal.aborted || !showParcels.checked || map.getZoom() !== zoom) return;
    if (response.length >= PARCEL_LIMIT) {
      surroundingParcels?.remove();
      surroundingParcels = null;
      parcelOverlayStatus.textContent = 'Too many lots in view. Zoom in further to see boundaries.';
      return;
    }
    let labels = 0;
    const features = validParcels(response);
    const overlay = L.geoJSON(features as GeoJSON.Feature[], {
      pane: 'parcel-context',
      style: { color: '#17637d', weight: 1.4, opacity: 0.85, fillOpacity: 0, interactive: false },
      onEachFeature(feature, layer) {
        if (zoom < 18 || labels >= 150 || !feature.properties?.lot) return;
        const featureBounds = (layer as L.Polygon).getBounds();
        const topLeft = map.latLngToContainerPoint(featureBounds.getNorthWest());
        const bottomRight = map.latLngToContainerPoint(featureBounds.getSouthEast());
        if (bottomRight.x - topLeft.x < 48 || bottomRight.y - topLeft.y < 25) return;
        layer.bindTooltip(String(feature.properties.lot), { permanent: true, direction: 'center', className: 'lot-number-label', opacity: 0.95, interactive: false });
        labels++;
      },
    }).addTo(map);
    surroundingParcels?.remove();
    surroundingParcels = overlay;
    parcelOverlayStatus.textContent = zoom >= 18 ? `${features.length} lot outlines · ${labels} lot numbers in view` : `${features.length} lot outlines · zoom in for lot numbers`;
  } catch (error) {
    if (!controller.signal.aborted) parcelOverlayStatus.textContent = 'Lot boundary layer unavailable. Search and parcel selection still work.';
  }
}
map.on('moveend', scheduleSurroundingParcels);
showParcels.addEventListener('change', scheduleSurroundingParcels);

function say(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}
function signal(controller: AbortController) {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
}
function cancelRequests() {
  requestController?.abort();
  requestController = new AbortController();
  return requestController;
}
function resetLayers() {
  parcelLayer?.remove();
  roadsLayer?.remove();
  destinationMarker?.remove();
  candidateMarkers.clearLayers();
  parcelLayer = roadsLayer = null;
  destinationMarker = null;
  candidates = [];
  selectedSuggestion = null;
  destination = null;
  manualMode = false;
  manualButton.setAttribute('aria-pressed', 'false');
  manualButton.textContent = 'Select point manually';
  navigate.classList.add('disabled');
  navigate.setAttribute('aria-disabled', 'true');
  navigate.removeAttribute('href');
  copyCoordinates.disabled = true;
  resetSuggestion.disabled = true;
  destinationSource.textContent = 'Choose a road suggestion or place a point manually.';
  destinationCoordinates.textContent = '—';
  candidateList.replaceChildren();
}
function markerIcon(manual: boolean) {
  return L.divIcon({ className: '', html: `<div class="property-map-pin${manual ? ' manual' : ''}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}
function setDestination(point: Position, source: string, manual: boolean) {
  destination = point;
  destinationSource.textContent = source;
  destinationCoordinates.textContent = `${point[1].toFixed(6)}, ${point[0].toFixed(6)}`;
  navigate.href = directionsUrl(point);
  navigate.classList.remove('disabled');
  navigate.removeAttribute('aria-disabled');
  copyCoordinates.disabled = false;
  resetSuggestion.disabled = !selectedSuggestion || !manual;
  destinationMarker?.remove();
  destinationMarker = L.marker([point[1], point[0]], { icon: markerIcon(manual), draggable: manual }).addTo(map);
  destinationMarker.bindTooltip(manual ? 'Manual destination — drag to adjust' : 'Suggested road coordinate');
  if (manual) destinationMarker.on('dragend', () => {
    const moved = destinationMarker!.getLatLng();
    setDestination([moved.lng, moved.lat], 'Manually selected destination', true);
  });
}
function renderCandidates() {
  candidateList.replaceChildren();
  candidateMarkers.clearLayers();
  if (!candidates.length) {
    candidateList.textContent = 'No suitable mapped road was found nearby. Select a destination manually on the map.';
    return;
  }
  candidates.forEach((candidate, index) => {
    const name = candidate.road.properties.road_name_full || 'Unnamed road';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'candidate';
    button.innerHTML = `<strong></strong><small></small>`;
    button.querySelector('strong')!.textContent = `${index + 1}. ${name} · ${Math.round(candidate.distance)} m`;
    button.querySelector('small')!.textContent = `${candidate.road.properties.class || 'Road'} · ${candidate.status}`;
    button.addEventListener('click', () => selectSuggestion(candidate));
    candidateList.append(button);
    L.circleMarker([candidate.point[1], candidate.point[0]], { radius: 5, color: '#fff', fillColor: '#49c58f', fillOpacity: 1, weight: 2 })
      .bindTooltip(name).on('click', event => { L.DomEvent.stopPropagation(event.originalEvent); selectSuggestion(candidate); }).addTo(candidateMarkers);
  });
  selectSuggestion(candidates[0]);
}
function selectSuggestion(candidate: Candidate) {
  selectedSuggestion = candidate;
  manualMode = false;
  manualButton.setAttribute('aria-pressed', 'false');
  manualButton.textContent = 'Select point manually';
  const name = candidate.road.properties.road_name_full || 'Unnamed mapped road';
  setDestination(candidate.point, `Suggested point on ${name}; entrance not confirmed.`, false);
  candidateList.querySelectorAll('.candidate').forEach((button, index) => button.classList.toggle('active', candidates[index] === candidate));
}
async function loadRoads(selected: Parcel, controller: AbortController) {
  for (const radius of [100, 250, 500]) {
    const response = await queryGeoJSON<Road>(ROAD_URL, {
      where: '1=1', geometry: expandedBounds(selected, radius), geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'road_name_full,class,sub_class,op_status_ind,user_access,trafficability,road_id,segment_id', resultRecordCount: '2000',
    }, signal(controller));
    if (controller.signal.aborted) return;
    if (response.length >= 2000) {
      candidateList.textContent = 'Too many roads were returned for this parcel. Select a destination manually.';
      say('Road service limit reached; automated suggestions are unavailable for this parcel.', true);
      return;
    }
    const roads = validRoads(response);
    roadsLayer?.remove();
    roadsLayer = L.geoJSON(roads as GeoJSON.Feature[], {
      style: feature => ({ color: roadStatus(feature as Road).suitable ? '#e6a259' : '#a47a79', weight: 2.5, opacity: 0.85, dashArray: roadStatus(feature as Road).suitable ? undefined : '5 5' }),
      onEachFeature: (feature, layer) => layer.bindTooltip((feature.properties?.road_name_full || 'Unnamed road') + ' · ' + (feature.properties?.op_status_ind || 'Status unknown')),
    }).addTo(map);
    candidates = rankRoads(selected, roads).filter(candidate => candidate.distance <= radius);
    if (candidates.length || radius === 500) {
      renderCandidates();
      if (candidates.length) say(`${candidates.length} nearby road option${candidates.length === 1 ? '' : 's'} found. Review access before navigating.`);
      else say('No suitable mapped road within 500 m of the parcel. Place a destination manually.', true);
      return;
    }
  }
}
async function selectParcel(selected: Parcel) {
  const controller = cancelRequests();
  resetLayers();
  parcel = selected;
  results.hidden = true;
  panel.hidden = false;
  input.value = selected.properties.lotplan;
  element<HTMLElement>('#property-title').textContent = selected.properties.lotplan;
  element<HTMLElement>('#property-locality').textContent = [selected.properties.locality, selected.properties.parcel_state].filter(Boolean).join(' · ');
  parcelLayer = L.geoJSON(selected as GeoJSON.Feature, { style: { color: '#167bbb', weight: 3, fillColor: '#3c9fd5', fillOpacity: 0.23 } }).addTo(map);
  const [west, south, east, north] = parcelBounds(selected);
  map.fitBounds([[south, west], [north, east]], { padding: [55, 55], maxZoom: 17 });
  say('Property found. Checking mapped roads nearby…');
  try { await loadRoads(selected, controller); }
  catch (error) { if (!controller.signal.aborted) { candidateList.textContent = 'Road data unavailable. You can still place a manual destination.'; say(error instanceof Error ? error.message : 'Road data unavailable.', true); } }
}
function showResults(parcels: Parcel[]) {
  results.replaceChildren();
  results.hidden = parcels.length <= 1;
  if (parcels.length === 1) { void selectParcel(parcels[0]); return; }
  say(`${parcels.length} matching parcels. Choose one.`);
  for (const match of parcels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${match.properties.lotplan} · ${match.properties.locality || 'Queensland'}`;
    button.addEventListener('click', () => void selectParcel(match));
    results.append(button);
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const lotplan = normaliseLotPlan(input.value);
  if (!lotplan) { say('Enter a lot/plan such as 4RP102393 or 12SP345678.', true); input.focus(); return; }
  const controller = cancelRequests();
  results.hidden = true;
  say(`Searching for ${lotplan}…`);
  try {
    const matches = validParcels(await queryGeoJSON<Parcel>(PARCEL_URL, { where: `lotplan='${lotplan}'`, outFields: 'lotplan,lot,plan,locality,parcel_state', resultRecordCount: '25' }, signal(controller)));
    if (controller.signal.aborted) return;
    if (!matches.length) { say(`No Queensland parcel found for ${lotplan}. Check the lot and plan characters.`, true); return; }
    showResults(matches);
  } catch (error) { if (!controller.signal.aborted) say(error instanceof Error ? error.message : 'Property search failed.', true); }
});
map.on('click', async event => {
  if (manualMode) { setDestination([event.latlng.lng, event.latlng.lat], 'Manually selected destination', true); return; }
  const controller = cancelRequests();
  say('Checking parcel at this point…');
  try {
    const matches = validParcels(await queryGeoJSON<Parcel>(PARCEL_URL, {
      geometry: `${event.latlng.lng},${event.latlng.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'lotplan,lot,plan,locality,parcel_state', resultRecordCount: '25',
    }, signal(controller)));
    if (controller.signal.aborted) return;
    if (!matches.length) { say('No parcel found at that point. Zoom in and tap a property parcel.', true); return; }
    showResults(matches);
  } catch (error) { if (!controller.signal.aborted) say(error instanceof Error ? error.message : 'Parcel lookup failed.', true); }
});
manualButton.addEventListener('click', () => {
  if (!parcel) return;
  manualMode = !manualMode;
  manualButton.setAttribute('aria-pressed', String(manualMode));
  manualButton.textContent = manualMode ? 'Tap map to place destination' : 'Select point manually';
  if (manualMode) say('Tap a road or intersection on the map to place a destination. You can drag the marker to refine it.');
});
resetSuggestion.addEventListener('click', () => { if (selectedSuggestion) selectSuggestion(selectedSuggestion); });
element<HTMLButtonElement>('#copy-lotplan').addEventListener('click', async () => { if (parcel) { await navigator.clipboard.writeText(parcel.properties.lotplan); say('Lot/plan copied.'); } });
copyCoordinates.addEventListener('click', async () => { if (destination) { await navigator.clipboard.writeText(`${destination[1].toFixed(6)}, ${destination[0].toFixed(6)}`); say('Destination coordinates copied.'); } });
element<HTMLButtonElement>('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) { say('This browser does not support GPS location.', true); return; }
  say('Requesting your location…');
  navigator.geolocation.getCurrentPosition(position => {
    const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
    gpsMarker?.remove();
    gpsMarker = L.circleMarker(latlng, { radius: 9, color: '#fff', weight: 3, fillColor: '#387ff5', fillOpacity: 1 }).addTo(map).bindTooltip('Your approximate location');
    map.setView(latlng, 16);
    say(`Showing your location (±${Math.round(position.coords.accuracy)} m).`);
  }, error => say(error.code === 1 ? 'Location permission denied. Search and manual selection still work.' : 'Could not determine your location. Search still works.', true), { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 });
});
