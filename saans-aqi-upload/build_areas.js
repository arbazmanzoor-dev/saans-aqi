'use strict';
/* Builds data/delhi_wards.geojson: Delhi's wards merged into areas of two or
   three neighbours.

   Why merge: about forty CPCB stations cover Delhi. Interpolating onto 272
   separate wards would suggest detail the readings cannot support; areas of
   two or three wards keep familiar names at a scale the stations can resolve.

   Source: Datameet Municipal Spatial Data, Delhi/Delhi_Wards.geojson — the
   pre-2022 MCD wards plus NDMC and Delhi Cantonment charges, CC BY-SA 2.5
   India. The output is a derivative and carries the same licence.

     node build_areas.js path/to/Delhi_Wards.geojson                       */
const fs   = require('fs');
const path = require('path');
const turf = require('@turf/turf');

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node build_areas.js <Delhi_Wards.geojson>'); process.exit(1); }
const OUT      = path.join(__dirname, 'data', 'delhi_wards.geojson');
const OUT_META = path.join(__dirname, 'data', 'delhi_wards.source.json');
const MAX_WARDS = 3;      // wards per area
const AREA_CAP  = 30e6;   // m²; only a ward bigger than this on its own stays alone
const SIMPLIFY  = 0.00008; // degrees, ~9 m

const titleCase = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim().replace(/\b([a-z])/g, c => c.toUpperCase());
const kindOf = no => /^CANT/i.test(no) ? 'cantonment' : /^NDMC/i.test(no) ? 'ndmc' : 'mcd';

/* ── load ── */
const wards = [];
const skipped = [];
for (const f of JSON.parse(fs.readFileSync(SRC, 'utf8')).features) {
  const p = f.properties || {};
  if (!p.Ward_Name || !f.geometry) { skipped.push(f); continue; }
  wards.push({ name: titleCase(p.Ward_Name), no: String(p.Ward_No), kind: kindOf(String(p.Ward_No)),
               geometry: f.geometry, area: turf.area(f) });
}

/* ── adjacency: the source shares exact vertices along common borders, so the
      number of shared vertices stands in for the length of the shared border ── */
const vkey = c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const owners = new Map();
wards.forEach((w, i) => {
  for (const c of new Set(w.geometry.coordinates[0].map(vkey))) {
    if (!owners.has(c)) owners.set(c, []);
    owners.get(c).push(i);
  }
});
const shared = wards.map(() => new Map());
for (const list of owners.values())
  for (const a of list) for (const b of list)
    if (a !== b) shared[a].set(b, (shared[a].get(b) || 0) + 1);
const touches = (a, b) => (shared[a].get(b) || 0) >= 2;

/* ── group ── */
const sortedAreas = wards.map(w => w.area).sort((a, b) => a - b);
const median = sortedAreas[Math.floor(sortedAreas.length / 2)];
const groupOf = new Array(wards.length).fill(-1);
const groups = [];

// Delhi Cantonment stays one area, whatever its size.
const cant = wards.map((w, i) => i).filter(i => wards[i].kind === 'cantonment');
if (cant.length) { cant.forEach(i => (groupOf[i] = groups.length)); groups.push(cant); }

// Everyone else: smallest wards first, each pulling in its most-connected
// unassigned neighbours of the same kind, within the size cap.
const order = wards.map((w, i) => i).filter(i => groupOf[i] < 0).sort((a, b) => wards[a].area - wards[b].area);
for (const i of order) {
  if (groupOf[i] >= 0) continue;
  const g = [i];
  let total = wards[i].area;
  groupOf[i] = groups.length;
  while (g.length < MAX_WARDS) {
    let best = -1, bestScore = 0;
    for (const m of g)
      for (const [n, count] of shared[m]) {
        if (groupOf[n] >= 0 || count < 2 || wards[n].kind !== wards[i].kind) continue;
        if (total + wards[n].area > AREA_CAP) continue;
        const score = g.reduce((s, x) => s + (shared[x].get(n) || 0), 0);
        if (score > bestScore) { best = n; bestScore = score; }
      }
    if (best < 0) break;
    g.push(best); groupOf[best] = groups.length; total += wards[best].area;
  }
  groups.push(g);
}

// A ward left alone because its neighbours were taken joins the smallest
// touching area of its kind, allowing one extra ward, within the cap.
const areaOf = t => groups[t].reduce((sum, x) => sum + wards[x].area, 0);
for (let gi = 0; gi < groups.length; gi++) {
  const g = groups[gi];
  if (g.length !== 1 || wards[g[0]].kind === 'cantonment') continue;
  const i = g[0];
  let target = -1;
  for (const [n] of shared[i]) {
    const t = groupOf[n];
    if (t === gi || !touches(i, n) || wards[n].kind !== wards[i].kind || groups[t].length > MAX_WARDS) continue;
    if (areaOf(t) + wards[i].area > AREA_CAP) continue;
    if (target < 0 || groups[t].length < groups[target].length) target = t;
  }
  if (target >= 0) { groups[target].push(i); groupOf[i] = target; groups[gi] = []; }
}

/* ── build features ── */
const areas = groups.filter(g => g.length).map(g => {
  const members = g.map(i => wards[i]).sort((a, b) => b.area - a.area);
  const merged = members.length === 1
    ? turf.feature(members[0].geometry)
    : turf.union(turf.featureCollection(members.map(m => turf.feature(m.geometry))));
  const geometry = turf.truncate(turf.simplify(merged, { tolerance: SIMPLIFY }), { precision: 5 }).geometry;
  const kind = members[0].kind;
  const name = kind === 'cantonment' ? 'Delhi Cantonment' : members[0].name;
  const c = turf.centroid(turf.feature(geometry)).geometry.coordinates;
  return { name, kind, members, geometry, lon: c[0], lat: c[1] };
});

// NDMC charges have no locality names of their own.
const ndmc = areas.filter(a => a.kind === 'ndmc').sort((a, b) => b.lat - a.lat);
ndmc.forEach((a, k) => { a.name = ndmc.length > 1 ? `New Delhi (NDMC) ${k + 1}` : 'New Delhi (NDMC)'; });

// Repeated names get their second ward's name as well.
const seen = new Map();
areas.forEach(a => seen.set(a.name, (seen.get(a.name) || 0) + 1));
areas.forEach(a => { if (seen.get(a.name) > 1 && a.members[1]) a.name = `${a.name} & ${a.members[1].name}`; });

// Ids run north to south in 0.05° bands, then west to east.
areas.sort((a, b) => Math.round((b.lat - a.lat) / 0.05) || a.lon - b.lon);
const features = areas.map((a, k) => ({
  type: 'Feature',
  properties: { area_id: `A${String(k + 1).padStart(3, '0')}`, area_name: a.name,
                wards: a.members.map(m => m.kind === 'ndmc' ? m.no.replace(/^NDMC_/i, 'NDMC charge ')
                                        : m.kind === 'cantonment' ? m.no.replace(/^CANT_/i, 'Cantonment charge ')
                                        : m.name) },
  geometry: a.geometry,
}));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
fs.writeFileSync(OUT_META, JSON.stringify({
  label: 'Datameet Municipal Spatial Data — pre-2022 MCD wards, merged into areas of two or three',
  licence: 'CC BY-SA 2.5 India',
  url: 'https://github.com/datameet/Municipal_Spatial_Data/tree/master/Delhi',
  built: new Date().toISOString().slice(0, 10),
  areas: features.length, wards: wards.length,
}, null, 2) + '\n');

/* ── report ── */
const sizes = {};
areas.forEach(a => { sizes[a.members.length] = (sizes[a.members.length] || 0) + 1; });
console.log(`${wards.length} wards → ${features.length} areas · wards per area ${JSON.stringify(sizes)}`);
const biggest = Math.max(...areas.map(a => a.members.reduce((sum, m) => sum + m.area, 0)));
console.log(`single-ward areas: ${areas.filter(a => a.members.length === 1).map(a => `${a.name} ${(a.members[0].area / 1e6).toFixed(0)} km²`).join(', ') || 'none'}`);
console.log(`median ward ${(median / 1e6).toFixed(2)} km² · largest area ${(biggest / 1e6).toFixed(1)} km² · output ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB → ${path.relative(__dirname, OUT)}`);
console.log('NDMC charges:', wards.filter(w => w.kind === 'ndmc').map(w => `${w.name} (${w.no})`).join(', '));
for (const f of skipped) {
  const c = turf.centroid(f).geometry.coordinates;
  console.log(`left out an unnamed polygon: ${(turf.area(f) / 1e6).toFixed(1)} km² centred ${c[1].toFixed(3)}, ${c[0].toFixed(3)}`);
}
const multi = features.filter(f => f.geometry.type === 'MultiPolygon').map(f => f.properties.area_name);
if (multi.length) console.log(`areas in more than one piece (${multi.length}):`, multi.slice(0, 10).join(', '));
