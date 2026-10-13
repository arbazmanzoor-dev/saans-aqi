'use strict';
/* ═══════════════════════════════════════════════════════════
   Saans AQI — Delhi stations from WAQI (aqicn.org)

   A second source of station readings, needed because the first one is not
   always reachable: CPCB's own feed on data.gov.in answers from India and
   refused this app's host for weeks, and before that was down entirely. WAQI
   relays the same CPCB stations and answers from anywhere.

   Two things it is not. It is fewer stations — thirteen against CPCB's
   fifty-eight — so a map built from it is coarser, which is why CPCB stays the
   preferred source whenever it answers. And it reports the US EPA AQI, not
   India's: Mandir Marg on 4 Oct 2026 read 114 on WAQI and 131 on CPCB's scale,
   with the dominant pollutant flipping from PM2.5 to PM10. Publishing the
   American number under an Indian label would be a straight scale error, so
   each sub-index is inverted to a concentration through the US breakpoints
   aqicn documents and rated again on CPCB's.

   Two caveats are deliberate and worth keeping in view:
   · aqicn's published table is the pre-2024 EPA one. The revision moved the
     bands below 35.4 and above 125.4 µg/m³; the 100-150 band, where Delhi
     spends much of the year, is identical either way.
   · Only PM2.5 and PM10 are converted. The gases are rated on 1- and 8-hour
     maxima by the EPA and 24-hour means by CPCB, which is not a conversion but
     a guess. In Delhi, PM leads the index virtually always.
   ═══════════════════════════════════════════════════════════ */
const wards = require('./wards.js');

/* CPCB's Delhi stations as WAQI numbers them. Named slugs rot — delhi/r-k-puram
   and delhi/dwarka-sector-8 both answered "Unknown station" by Oct 2026 — while
   the uids kept working. Checked 4 Oct 2026. The US Embassy site (@7024) is
   left out: it stopped reporting in 2025. */
const UIDS = [2553, 2554, 2556, 10111, 10112, 10113, 10114,
              10115, 10118, 10121, 10124, 10704, 10705];

const STALE_MS = 3 * 3600 * 1000;   // past this a reading is history, not "now"
const MIN_FRESH = 3;                // before a set of stations means anything
const TIMEOUT_MS = 8000;

const US_BP = {
  'PM2.5': [0, 12.0, 35.4, 55.4, 150.4, 250.4, 350.4],
  'PM10':  [0, 54,   154,  254,  354,   424,   604  ],
};
const US_INDEX = [0, 50, 100, 150, 200, 300, 500];

function usConcentration(sub, bp) {
  for (let k = 1; k < US_INDEX.length; k++)
    if (sub <= US_INDEX[k])
      return bp[k-1] + (sub - US_INDEX[k-1]) * (bp[k] - bp[k-1]) / (US_INDEX[k] - US_INDEX[k-1]);
  return bp[bp.length - 1];
}

/* null when the station carries neither PM reading — a National AQI without PM
   is not a number this app should publish. */
function naqiFrom(iaqi) {
  let worst = null, lead = null;
  for (const [pol, key] of [['PM2.5', 'pm25'], ['PM10', 'pm10']]) {
    const sub = Number(iaqi && iaqi[key] && iaqi[key].v);
    if (!Number.isFinite(sub) || sub < 0) continue;
    const naqi = wards.subIndex(usConcentration(sub, US_BP[pol]), wards.BREAKPOINTS[pol]);
    if (worst === null || naqi > worst) { worst = naqi; lead = pol; }
  }
  return worst === null ? null : { aqi: Math.round(worst), dominant: lead };
}

async function one(uid, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.waqi.info/feed/@${uid}/?token=${encodeURIComponent(token)}`,
                          { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (j.status !== 'ok' || !j.data) return null;
    return j.data;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

/* Every Delhi station WAQI will give us, rated on India's scale, with the
   stale ones dropped and counted rather than quietly averaged in. */
async function stations(token = process.env.WAQI_TOKEN) {
  if (!token || token === 'demo') return { stations: [], answered: 0, reason: 'no_token' };
  const now = Date.now();
  const got = await Promise.all(UIDS.map(uid => one(uid, token)));
  const seen = [];
  for (const d of got) {
    if (!d) continue;
    const rated = naqiFrom(d.iaqi);
    const geo = d.city && d.city.geo;
    const obs = Date.parse((d.time && d.time.iso) || '');
    if (!rated || !Array.isArray(geo) || geo.length < 2) continue;
    seen.push({
      name: String((d.city && d.city.name) || 'Delhi').replace(/,\s*India$/, ''),
      lat: Number(geo[0]), lon: Number(geo[1]),
      aqi: rated.aqi, dominant: rated.dominant,
      updated: (d.time && d.time.iso) || null,
      age: Number.isFinite(obs) ? now - obs : Infinity,
    });
  }
  const fresh = seen.filter(s => s.age <= STALE_MS && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  return {
    stations: fresh.map(({ age, ...s }) => s),
    answered: seen.length,
    freshest: seen.length ? Math.min(...seen.map(s => s.age)) : null,
    reason: fresh.length >= MIN_FRESH ? null : (seen.length ? 'stale' : 'no_answer'),
  };
}

module.exports = { stations, naqiFrom, usConcentration, UIDS, MIN_FRESH, STALE_MS };
