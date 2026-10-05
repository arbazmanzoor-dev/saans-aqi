'use strict';
/* ═══════════════════════════════════════════════════════════
   Saans AQI — the day's measured AQI, saved as it is read

   This project's history comes from CPCB's annual workbooks, which arrive long
   after the year they describe: the daily record ends 31 March 2025 while the
   site runs in October 2026. Every live reading the app already fetches is a
   measurement of today, so writing it down closes that gap going forward
   instead of waiting a year for a spreadsheet.

   Three rules make the saved record trustworthy:
   · Only real station readings are kept — never the seasonal fallback, never
     the keyless model estimate, never test data. A row here is a measurement.
   · The last reading of a day wins. Each is a 24-hour mean, so the latest one
     covers the most of that day, which is what CPCB's daily figure is.
   · Dates are Delhi dates. The server pins its timezone, and this re-derives
     the date from the reading rather than trusting the host's idea of today.
   ═══════════════════════════════════════════════════════════ */
const path = require('path');
const fs   = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.SAANS_DB || path.join(__dirname, 'data', 'saans.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
/* Two connections share this file (alerts.js holds the other), so let a writer
   wait rather than fail, and keep readers unblocked while one writes. */
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 4000;
CREATE TABLE IF NOT EXISTS daily_readings (
  date     TEXT PRIMARY KEY,
  aqi      INTEGER NOT NULL,
  stations INTEGER,
  source   TEXT NOT NULL,
  observed TEXT,
  recorded TEXT NOT NULL);
`);

/* "2026-10-04" in Delhi, from the reading's own timestamp where it has one. */
function delhiDate(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  const d = new Date(Number.isFinite(t) ? t : Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/* Returns the row written, or null with a reason — the caller logs it once so a
   silent failure to record cannot look like a quiet success. */
function record(reading) {
  if (!reading || reading.fallback || reading.test) return null;
  if (!(reading.count > 0) || !(reading.aqi > 0)) return null;
  const date = delhiDate(reading.updated);
  const row = {
    date, aqi: Math.round(reading.aqi), stations: reading.count || null,
    source: String(reading.source || 'live'), observed: reading.updated || null,
    recorded: new Date().toISOString(),
  };
  try {
    db.prepare(`INSERT INTO daily_readings (date, aqi, stations, source, observed, recorded)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                  aqi=excluded.aqi, stations=excluded.stations, source=excluded.source,
                  observed=excluded.observed, recorded=excluded.recorded`)
      .run(row.date, row.aqi, row.stations, row.source, row.observed, row.recorded);
    return row;
  } catch (e) {
    return { error: e.message };
  }
}

/* Daily rows shaped like the workbook records, so the rest of the app can treat
   both the same way. */
function recs() {
  try {
    return db.prepare('SELECT date, aqi FROM daily_readings ORDER BY date').all()
      .map(r => {
        const [y, m, d] = r.date.split('-').map(Number);
        return { year: y, month: m, day: d, aqi: r.aqi, recorded: true };
      });
  } catch (e) { return []; }
}

function all() {
  try { return db.prepare('SELECT * FROM daily_readings ORDER BY date').all(); }
  catch (e) { return []; }
}

function count() {
  try { return db.prepare('SELECT COUNT(*) AS n FROM daily_readings').get().n; }
  catch (e) { return 0; }
}

module.exports = { record, recs, all, count, delhiDate, DB_PATH };
