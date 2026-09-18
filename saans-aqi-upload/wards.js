'use strict';
/* Ward-wise AQI for Delhi.

   Stations: CPCB's real-time feed on data.gov.in, which needs a free key in
   DATA_GOV_IN_KEY. Each record is one pollutant at one station: its min, max
   and average over the last 24 hours, with the station's coordinates.

   Wards: MCD boundaries from data/delhi_wards.geojson.

   A ward's number is interpolated from the stations around it. That makes it
   an estimate, not a reading, so every ward carries the distance to its
   nearest station, and nothing is invented when the feed is unavailable. */
const fs   = require('fs');
const path = require('path');

const RESOURCE   = '3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69';   // "Real time Air Quality Index from various locations"
const WARDS_FILE = path.join(__dirname, 'data', 'delhi_wards.geojson');
const CACHE_MS   = 30 * 60 * 1000;   // the feed updates hourly
const RETRY_MS   = 5 * 60 * 1000;    // after a hard failure (e.g. a rejected key), don't hammer the feed
const BLIP_MS    = 30 * 1000;        // after a dropped connection or server error, try again soon
const RETRY_PAUSE_MS = 1500;         // between the first attempt and the retry
const STALE_MS   = 3 * 3600 * 1000;  // drop stations this far behind the newest
const NEIGHBOURS = 4;

/* CPCB National AQI breakpoints for 24-hour means, µg/m³. CO and O₃ are left
   out: CPCB rates them on 8-hour maxima, which this feed does not carry.
   CPCB leaves the Severe band open-ended; its top edge here is only a cap. */
const INDEX = [0, 50, 100, 200, 300, 400, 500];
const BREAKPOINTS = {
  'PM2.5': [0, 30, 60, 90, 120, 250, 500],
  'PM10':  [0, 50, 100, 250, 350, 430, 600],
  'NO2':   [0, 40, 80, 180, 280, 400, 800],
  'SO2':   [0, 40, 80, 380, 800, 1600, 2400],
  'NH3':   [0, 200, 400, 800, 1200, 1800, 2400],
};

function subIndex(value, bp) {
  for (let k = 1; k < bp.length; k++)
    if (value <= bp[k])
      return INDEX[k-1] + (value - bp[k-1]) * (INDEX[k] - INDEX[k-1]) / (bp[k] - bp[k-1]);
  return 500;
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : null; };

// "14-09-2026 13:00:00", India Standard Time
function parseWhen(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+05:30`) : NaN;
}

function km(a, b) {
  const p = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * p / 2) ** 2
          + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin((b.lon - a.lon) * p / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/* ── stations ─────────────────────────────────────────────────────────── */
/* data.gov.in drops the odd request. A dropped connection, a timeout or a 5xx
   gets one retry after a short pause; a 4xx (a bad key, say) does not, because
   asking again will not change the answer. Errors never carry the URL: it
   holds the key. */
const isBlip = status => status === 429 || status >= 500;

async function fetchPage(url) {
  for (let attempt = 1; ; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let err;
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.records)) return j.records;
      err = new Error(`data.gov.in answered ${r.status}${j.error ? ` (${j.error})` : ''}`);
      err.transient = isBlip(r.status);
    } catch (e) {
      err = new Error(e.name === 'AbortError' ? 'data.gov.in timed out'
        : `could not reach data.gov.in${e.cause && e.cause.code ? ` (${e.cause.code})` : ''}`);
      err.transient = true;
    } finally { clearTimeout(timer); }
    if (!err.transient || attempt >= 2) throw err;
    console.log(`↻  data.gov.in: ${err.message} — retrying once`);
    await new Promise(ok => setTimeout(ok, RETRY_PAUSE_MS));
  }
}

async function fetchRecords(key) {
  const records = [];
  const limit = 500;
  for (let offset = 0; offset < 5000; offset += limit) {
    const url = `https://api.data.gov.in/resource/${RESOURCE}?api-key=${encodeURIComponent(key)}`
              + `&format=json&limit=${limit}&offset=${offset}&filters%5Bstate%5D=Delhi`;
    const page = await fetchPage(url);
    records.push(...page);
    if (page.length < limit) break;
  }
  return records;
}

/* One AQI per station, the CPCB way: the highest sub-index, and only when at
   least three pollutants report and one of them is PM2.5 or PM10. */
function stationsFrom(records) {
  const byName = new Map();
  for (const rec of records) {
    const name = String(rec.station || '').trim();
    const lat = num(rec.latitude), lon = num(rec.longitude);
    if (!name || lat === null || lon === null) continue;
    if (!byName.has(name)) byName.set(name, { name, lat, lon, when: NaN, values: {} });
    const s = byName.get(name);
    const id = String(rec.pollutant_id || '').toUpperCase().replace('PM2_5', 'PM2.5');
    const avg = num(rec.avg_value ?? rec.pollutant_avg);
    if (BREAKPOINTS[id] && avg !== null) s.values[id] = avg;
    const when = parseWhen(rec.last_update);
    if (Number.isFinite(when) && !(when <= s.when)) s.when = when;
  }

  const rated = [];
  for (const s of byName.values()) {
    const ids = Object.keys(s.values);
    if (ids.length < 3 || !(ids.includes('PM2.5') || ids.includes('PM10'))) continue;
    let aqi = 0, dominant = null;
    for (const id of ids) {
      const v = subIndex(s.values[id], BREAKPOINTS[id]);
      if (v > aqi) { aqi = v; dominant = id; }
    }
    rated.push({ name: s.name, lat: s.lat, lon: s.lon, aqi: Math.round(aqi), dominant,
                 pollutants: s.values, updated: Number.isFinite(s.when) ? new Date(s.when).toISOString() : null });
  }

  const newest = Math.max(...rated.map(s => Date.parse(s.updated) || 0));
  return rated.filter(s => s.updated && newest - Date.parse(s.updated) <= STALE_MS);
}

/* ── wards ────────────────────────────────────────────────────────────── */
const NAME_KEYS = ['area_name', 'Ward_Name', 'WARD_NAME', 'ward_name', 'WardName', 'name', 'Name', 'NAME'];
const NO_KEYS   = ['area_id', 'Ward_No', 'WARD_NO', 'ward_no', 'Ward_Number', 'WardNo', 'ward_number', 'id', 'code'];
const pick = (props, keys) => { for (const k of keys) if (props[k] != null && props[k] !== '') return props[k]; return null; };

// Area-weighted centroid of the outer rings; planar is fine at city scale.
function centroid(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
              : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  let area = 0, cx = 0, cy = 0;
  for (const poly of polys) {
    const ring = poly[0] || [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      area += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
  }
  if (!area) return null;
  return { lon: cx / (3 * area), lat: cy / (3 * area) };
}

/* Read once per file change. Every feature gains saans_id and saans_name, so
   the map's shapes and the interpolated values agree on which ward is which.
   An optional delhi_wards.source.json beside it carries the attribution. */
let geoCache = null, geoMtime = 0;
function readBoundaries() {
  let stat;
  try { stat = fs.statSync(WARDS_FILE); } catch (e) { return null; }
  if (geoCache && stat.mtimeMs === geoMtime) return geoCache;
  const raw = JSON.parse(fs.readFileSync(WARDS_FILE, 'utf8'));
  const round = c => typeof c[0] === 'number' ? [+c[0].toFixed(5), +c[1].toFixed(5)] : c.map(round);
  const features = [], wards = [];
  (raw.features || []).forEach((f, i) => {
    const c = f.geometry && centroid(f.geometry);
    if (!c) return;
    const props = f.properties || {};
    const id = String(pick(props, NO_KEYS) ?? i + 1);
    const name = String(pick(props, NAME_KEYS) ?? `Ward ${i + 1}`);
    const includes = Array.isArray(props.wards) ? props.wards.map(String) : [name];
    features.push({ type: 'Feature', properties: { saans_id: id, saans_name: name, saans_includes: includes },
                    geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } });
    wards.push({ id, name, includes, ...c });
  });
  let source = null;
  try { source = JSON.parse(fs.readFileSync(WARDS_FILE.replace(/\.geojson$/, '.source.json'), 'utf8')); } catch (e) {}
  geoCache = { geo: { type: 'FeatureCollection', features }, wards, source };
  geoMtime = stat.mtimeMs;
  return geoCache;
}
const loadWards  = () => readBoundaries()?.wards || null;
const boundaries = () => readBoundaries()?.geo || null;

/* Inverse-distance weighting from the nearest stations. */
function interpolate(point, stations) {
  const near = stations.map(s => ({ s, d: km(point, s) })).sort((a, b) => a.d - b.d).slice(0, NEIGHBOURS);
  if (near[0].d < 0.3)
    return { aqi: near[0].s.aqi, nearestKm: +near[0].d.toFixed(1), from: [near[0].s.name] };
  let wsum = 0, vsum = 0;
  for (const { s, d } of near) { const w = 1 / (d * d); wsum += w; vsum += w * s.aqi; }
  return { aqi: Math.round(vsum / wsum), nearestKm: +near[0].d.toFixed(1), from: near.map(n => n.s.name) };
}

/* ── the endpoint's payload ───────────────────────────────────────────── */
let cache = null, cacheTime = 0;
/* Invented stations for the test switch, at real CPCB sites so the map spreads
   plausibly. Only reachable when SAANS_TEST_AQI is set, and flagged test:true. */
const TEST_SITES = [
  ['Anand Vihar', 28.6469, 77.3162, 1.18], ['ITO', 28.6285, 77.2410, 1.06],
  ['Dwarka Sector 8', 28.5710, 77.0719, 0.82], ['Punjabi Bagh', 28.6740, 77.1310, 1.02],
  ['R K Puram', 28.5632, 77.1868, 0.88], ['Mandir Marg', 28.6365, 77.2010, 0.95],
  ['Rohini', 28.7325, 77.1198, 1.10], ['Narela', 28.8227, 77.1020, 1.14],
  ['Okhla Phase 2', 28.5308, 77.2711, 1.04], ['Najafgarh', 28.5700, 76.9340, 0.80],
  ['Shadipur', 28.6514, 77.1580, 0.98], ['Bawana', 28.7762, 77.0510, 1.20],
];
function testStations(base) {
  const now = new Date().toISOString();
  return TEST_SITES.map(([name, lat, lon, k]) => ({
    name: `${name} (test)`, lat, lon,
    aqi: Math.max(10, Math.min(500, Math.round(base * k))),
    dominant: 'PM2.5', pollutants: {}, updated: now }));
}

async function wardAQI() {
  const test = Math.round(Number(process.env.SAANS_TEST_AQI) || 0);
  const key = process.env.DATA_GOV_IN_KEY || '';
  const wards = loadWards();
  const base = { wardCount: wards ? wards.length : 0, boundarySource: readBoundaries()?.source || null };
  if (test > 0 && wards && wards.length) {
    const stations = testStations(test);
    return { ...base, available: true, test: true,
      updated: new Date().toISOString(),
      source: 'TEST DATA — SAANS_TEST_AQI, not measurements',
      method: `invented readings at ${stations.length} real station sites, interpolated the same way real ones would be`,
      stations,
      wards: wards.map(w => ({ id: w.id, name: w.name, includes: w.includes, ...interpolate(w, stations) })) };
  }
  if (!key)
    return { ...base, available: false, reason: 'no_key',
             message: 'Ward-wise AQI needs CPCB station readings. Set DATA_GOV_IN_KEY (free at data.gov.in) and restart.' };
  if (!wards || !wards.length)
    return { ...base, available: false, reason: 'no_boundaries',
             message: `No ward boundaries at ${path.relative(__dirname, WARDS_FILE)}.` };

  const hold = cache && (cache.available ? CACHE_MS : cache.transient ? BLIP_MS : RETRY_MS);
  if (cache && Date.now() - cacheTime < hold) return cache;
  try {
    const stations = stationsFrom(await fetchRecords(key));
    if (stations.length < 3) {
      cache = { ...base, available: false, reason: 'too_few_stations', stationCount: stations.length,
                message: `Only ${stations.length} Delhi station${stations.length === 1 ? '' : 's'} reporting enough pollutants right now.` };
    } else {
      const newest = Math.max(...stations.map(s => Date.parse(s.updated)));
      cache = { ...base, available: true,
        updated: new Date(newest).toISOString(),
        source: 'CPCB real-time feed via data.gov.in',
        method: `National AQI per station from 24-hour means of PM2.5, PM10, NO₂, SO₂ and NH₃; each area interpolated from its ${NEIGHBOURS} nearest stations (inverse-distance weighting)`,
        stations,
        wards: wards.map(w => ({ id: w.id, name: w.name, includes: w.includes, ...interpolate(w, stations) })) };
    }
  } catch (e) {
    cache = { ...base, available: false, reason: 'feed_error', transient: !!e.transient,
              message: `${e.message}.${e.transient ? ' Trying again in 30 seconds.' : ''}` };
  }
  cacheTime = Date.now();
  return cache;
}

module.exports = { wardAQI, loadWards, boundaries, stationsFrom, subIndex, BREAKPOINTS, WARDS_FILE };
