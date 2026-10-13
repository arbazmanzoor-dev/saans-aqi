'use strict';
/* ═══════════════════════════════════════════════════════════
   Saans AQI — the day's measured AQI, saved as it is read

   This project's history comes from CPCB's annual workbooks, which arrive long
   after the year they describe. Every live reading the app already fetches is a
   measurement of today, so writing it down closes that gap going forward
   instead of waiting a year for a spreadsheet.

   Three rules make the saved record trustworthy:
   · Only real station readings are kept — never the seasonal fallback, never
     the keyless model estimate, never test data. A row here is a measurement.
   · The last reading of a day wins. Each is a 24-hour mean, so the latest one
     covers the most of that day, which is what CPCB's daily figure is.
   · Dates are Delhi dates, derived from the reading rather than from the
     host's idea of today.

   Storage is db.js: Postgres in production, SQLite locally.
   ═══════════════════════════════════════════════════════════ */
const db = require('./db.js');

const DDL_PG = `
CREATE TABLE IF NOT EXISTS daily_readings (
  date     TEXT PRIMARY KEY,
  aqi      INTEGER NOT NULL,
  stations INTEGER,
  source   TEXT NOT NULL,
  observed TEXT,
  recorded TEXT NOT NULL)`;
const DDL_SQLITE = DDL_PG + ';';

let ready = null;
function init() {
  if (!ready) ready = db.exec(DDL_PG, DDL_SQLITE);
  return ready;
}

/* "2026-10-04" in Delhi, from the reading's own timestamp where it has one. */
function delhiDate(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  const d = new Date(Number.isFinite(t) ? t : Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/* Returns the row written, {error} if the write failed, or null if the reading
   was not the kind we keep. The caller logs the error once, so a silent failure
   to record cannot look like a quiet success. */
async function record(reading) {
  if (!reading || reading.fallback || reading.test) return null;
  if (!(reading.count > 0) || !(reading.aqi > 0)) return null;
  const row = {
    date: delhiDate(reading.updated), aqi: Math.round(reading.aqi),
    stations: reading.count || null, source: String(reading.source || 'live'),
    observed: reading.updated || null, recorded: new Date().toISOString(),
  };
  try {
    await init();
    await db.run(
      `INSERT INTO daily_readings (date, aqi, stations, source, observed, recorded)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (date) DO UPDATE SET
         aqi = EXCLUDED.aqi, stations = EXCLUDED.stations, source = EXCLUDED.source,
         observed = EXCLUDED.observed, recorded = EXCLUDED.recorded`,
      [row.date, row.aqi, row.stations, row.source, row.observed, row.recorded]);
    return row;
  } catch (e) {
    return { error: e.message };
  }
}

/* Daily rows shaped like the workbook records, so the rest of the app can treat
   both the same way. Cached: the forecast page asks for these on every scope
   change, and a database round trip per call would be absurd for a table that
   changes twice an hour at most. */
let cache = [], cacheAt = 0;
const CACHE_MS = 60 * 1000;

async function refresh() {
  try {
    await init();
    const rows = await db.all('SELECT date, aqi FROM daily_readings ORDER BY date');
    cache = rows.map(r => {
      const [y, m, d] = String(r.date).split('-').map(Number);
      return { year: y, month: m, day: d, aqi: db.num(r.aqi), recorded: true };
    });
    cacheAt = Date.now();
  } catch (e) {
    console.error(`⚠️  could not read saved readings: ${e.message}`);
  }
  return cache;
}

/* Synchronous by design: the prediction routes are full of synchronous record
   handling, and an await per call would spread through all of them for a list
   that is refreshed on a timer anyway. */
const recs = () => cache;
const count = () => cache.length;

async function all() {
  await init();
  return db.all('SELECT * FROM daily_readings ORDER BY date');
}

module.exports = { init, record, recs, count, all, refresh, delhiDate, CACHE_MS };
