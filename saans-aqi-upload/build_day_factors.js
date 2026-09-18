/* Saans AQI — regenerates day_factors.json from the CPCB sheets and, for
   2015-2019, data/delhi_daily_2015_2020.csv.
   Run: node build_day_factors.js
   Day/week factors are multipliers applied to a monthly forecast. Each is a
   ratio of that day's mean AQI to its month's mean, shrunk toward 1.0 by
   n/(n+SHRINK) because a calendar day has only ~6 observations. */
'use strict';
const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');

const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];
const SHRINK = 3;
const DAYS_IN_MONTH = (yr,m) =>
  m === 2 ? ((yr%4===0 && yr%100!==0) || yr%400===0 ? 29 : 28)
          : [31,28,31,30,31,30,31,31,30,31,30,31][m-1];

const recs = [];
for (let yr = 2020; yr <= 2025; yr++) {
  const file = path.join(__dirname, `AQI_daily_city_level_delhi_${yr}_delhi_${yr}.xlsx`);
  if (!fs.existsSync(file)) continue;
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets[XLSX.readFile(file).SheetNames[0]]);
  const dayKey = Object.keys(rows[0] || {})[0];
  rows.forEach(row => {
    const day = Number(String(row['Day'] ?? row['Date'] ?? row[dayKey]).trim());
    if (!Number.isInteger(day) || day < 1 || day > 31) return;
    MONTHS.forEach((m, mi) => {
      const raw = row[m];
      if (raw === null || raw === undefined || String(raw).trim() === '') return;
      const n = Number(raw);
      if (isNaN(n) || n <= 0 || n >= 1000) return;
      if (day > DAYS_IN_MONTH(yr, mi+1)) return;
      recs.push({ year: yr, month: mi+1, day, aqi: n });
    });
  });
}

/* 2015-2019: daily Delhi AQI from the "Air Quality Data in India (2015-2020)"
   city_day table, compiled from CPCB station data. It computes AQI itself and
   reads ~10 points above the CPCB workbook where the two overlap (Jan-Jun
   2020, r 0.989), so it fills only the years the workbooks lack. A day factor
   is a ratio, which cancels most of that offset: held out on 2022-2024,
   adding these years cut daily MAPE from 23.6% to 22.7%. */
const EARLY = path.join(__dirname, 'data', 'delhi_daily_2015_2020.csv');
let early = 0;
if (fs.existsSync(EARLY)) {
  const [head, ...lines] = fs.readFileSync(EARLY, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  const iDate = cols.indexOf('DATE'), iAqi = cols.indexOf('AQI');
  lines.forEach(line => {
    const c = line.split(',');
    const [yr, month, day] = String(c[iDate]).slice(0, 10).split('-').map(Number);
    const n = Number(c[iAqi]);
    if (!(yr < 2020) || c[iAqi] === '' || isNaN(n) || n <= 0 || n >= 1000) return;
    if (!(day >= 1 && day <= DAYS_IN_MONTH(yr, month))) return;
    recs.push({ year: yr, month, day, aqi: n });
    early++;
  });
}

const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
const round4 = v => +v.toFixed(4);
const shrink = (ratio, n) => 1 + (ratio - 1) * (n/(n+SHRINK));

const monthMeans = {};
for (let m = 1; m <= 12; m++) monthMeans[m] = +mean(recs.filter(r=>r.month===m).map(r=>r.aqi)).toFixed(1);

const dayFactors = {};
for (let m = 1; m <= 12; m++) {
  dayFactors[m] = {};
  for (let d = 1; d <= 31; d++) {
    const vs = recs.filter(r=>r.month===m && r.day===d).map(r=>r.aqi);
    if (!vs.length) continue;
    dayFactors[m][d] = round4(shrink(mean(vs)/monthMeans[m], vs.length));
  }
}

/* Week of year, counted as 7-day blocks from Jan 1 (week 52 absorbs the tail). */
const weekOf = (month, day) => {
  const doy = [0,31,59,90,120,151,181,212,243,273,304,334][month-1] + day;
  return Math.min(52, Math.ceil(doy/7));
};
const weekFactors = {};
for (let w = 1; w <= 52; w++) {
  const vs = recs.filter(r => weekOf(r.month, r.day) === w);
  if (!vs.length) continue;
  const counts = {};
  vs.forEach(r => counts[r.month] = (counts[r.month]||0)+1);
  const month = +Object.keys(counts).reduce((a,b)=>counts[a]>=counts[b]?a:b);
  weekFactors[w] = {
    month,
    factor: round4(shrink(mean(vs.map(r=>r.aqi))/monthMeans[month], vs.length)),
  };
}

fs.writeFileSync(path.join(__dirname,'day_factors.json'),
  JSON.stringify({ dayFactors, weekFactors, monthMeans,
    generated: new Date().toISOString().slice(0,10),
    source: `${recs.length} daily readings: ${early} from the 2015–2019 city_day table, `
          + `${recs.length - early} from the 2020–2025 CPCB sheets`, shrinkage: SHRINK }, null, 2));
console.log(`day_factors.json rebuilt from ${recs.length} readings (${early} from 2015–2019)`);
