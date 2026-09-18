'use strict';
const express = require('express');
const cors    = require('cors');
const XLSX    = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const alerts  = require('./alerts');
const wards   = require('./wards');
const nextday = require('./nextday');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ── Static files with correct MIME ──
app.get('/app.js',    (req,res)=>{res.setHeader('Content-Type','application/javascript');res.sendFile(path.join(__dirname,'app.js'));});
app.get('/style.css', (req,res)=>{res.setHeader('Content-Type','text/css');              res.sendFile(path.join(__dirname,'style.css'));});
app.get('/auth.html', (req,res)=>{res.setHeader('Content-Type','text/html');             res.sendFile(path.join(__dirname,'auth.html'));});
// The map library ships with the app (npm leaflet@1.9.4) rather than from a CDN,
// so the Ward Map never waits on a third-party host. The files never change.
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'),
  { maxAge: '30d', immutable: true, fallthrough: false }));

// ═══════════════════════════════════════════════════════════
//  DATA LOADING
// ═══════════════════════════════════════════════════════════
const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

const DAYS_IN_MONTH = (yr, m) =>
  m === 2 ? ((yr%4===0 && yr%100!==0) || yr%400===0 ? 29 : 28)
          : [31,28,31,30,31,30,31,31,30,31,30,31][m-1];

/* CPCB sheets carry summary rows below day 31 ("Moderate", "Severe",
   "% of Availability", ...) and the 2020 sheet labels its first column
   "Date" (as strings "01".."31") instead of "Day". Accept a row only when
   its first column is a real calendar day, or those summary counts get
   stored as AQI readings. */
let allRecords = [];
const yearCoverage = {};
for (let yr = 2020; yr <= 2025; yr++) {
  const file = path.join(__dirname, `AQI_daily_city_level_delhi_${yr}_delhi_${yr}.xlsx`);
  if (!fs.existsSync(file)) continue;
  const wb   = XLSX.readFile(file);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const dayKey = Object.keys(rows[0] || {})[0];   // "Day" or "Date"
  let kept = 0, skipped = 0;
  rows.forEach(row => {
    const day = Number(String(row['Day'] ?? row['Date'] ?? row[dayKey]).trim());
    if (!Number.isInteger(day) || day < 1 || day > 31) { skipped++; return; }
    MONTHS.forEach((m, mi) => {
      const raw = row[m];
      if (raw === null || raw === undefined || String(raw).trim() === '') return;
      const n = Number(raw);
      if (isNaN(n) || n <= 0 || n >= 1000) return;
      if (day > DAYS_IN_MONTH(yr, mi+1)) return;
      allRecords.push({ year: yr, month: mi+1, day, aqi: n });
      kept++;
    });
  });
  yearCoverage[yr] = kept;
  if (skipped) console.log(`   ${yr}: ${kept} readings (${skipped} non-day rows ignored)`);
}
console.log(`✅ Data loaded: ${allRecords.length} records`);

// Monthly stats
const monthlyStats = {};
for (let m = 1; m <= 12; m++) {
  const vs = allRecords.filter(r => r.month === m).map(r => r.aqi).sort((a,b)=>a-b);
  const mean   = vs.reduce((a,b)=>a+b,0)/vs.length;
  const median = vs[Math.floor(vs.length/2)];
  const std    = Math.sqrt(vs.reduce((s,v)=>s+(v-mean)**2,0)/vs.length);
  monthlyStats[m] = { mean:+mean.toFixed(1), std:+std.toFixed(1), median:+median.toFixed(1), count:vs.length };
}

// Global stats
const globalMean = allRecords.reduce((s,r)=>s+r.aqi,0)/allRecords.length;
const globalStd  = Math.sqrt(allRecords.reduce((s,r)=>s+(r.aqi-globalMean)**2,0)/allRecords.length);
const sortedAqi   = allRecords.map(r=>r.aqi).sort((a,b)=>a-b);
const globalStats = { mean:+globalMean.toFixed(1), std:+globalStd.toFixed(1),
                      median: sortedAqi[Math.floor(sortedAqi.length/2)] };

// Yearly regression — fitted on complete years only. A part-year (2025 stops
// in March) is winter-heavy and would tilt the trend upward on its own.
const years = [2020,2021,2022,2023,2024,2025].filter(yr => yearCoverage[yr] > 0);
const yearlyMeans = {};
years.forEach(yr => {
  const vs = allRecords.filter(r=>r.year===yr).map(r=>r.aqi);
  yearlyMeans[yr] = +(vs.reduce((a,b)=>a+b,0)/vs.length).toFixed(1);
});
const MIN_DAYS_FOR_TREND = 300;
const trendYears = years.filter(yr => yearCoverage[yr] >= MIN_DAYS_FOR_TREND);
const partialYears = years.filter(yr => yearCoverage[yr] < MIN_DAYS_FOR_TREND);

// Year×month matrix
const yearMonthMatrix = {};
years.forEach(yr => {
  yearMonthMatrix[yr] = {};
  for (let m=1;m<=12;m++) {
    const vs = allRecords.filter(r=>r.year===yr&&r.month===m).map(r=>r.aqi);
    yearMonthMatrix[yr][m] = vs.length ? +(vs.reduce((a,b)=>a+b,0)/vs.length).toFixed(1) : null;
  }
});

/* ── Analytics: ten years for the charts ─────────────────────────────────────
   Everything above and below this block that forecasts stays on the CPCB
   workbooks. The Analytics page alone adds 2015-2019 from
   data/delhi_daily_2015_2020.csv — the "Air Quality Data in India" city_day
   table, compiled from CPCB station data. That table computes its own AQI: it
   reads ~10 above the workbooks where the two overlap (Jan-Jun 2020), and it
   runs past CPCB's 500 ceiling on some days, which are capped at 500 here so
   every year sits on the scale the bands use. */
const analytics = (() => {
  const file = path.join(__dirname, 'data', 'delhi_daily_2015_2020.csv');
  const early = [];
  let capped = 0;
  if (fs.existsSync(file)) {
    const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const cols = head.split(',');
    const iDate = cols.indexOf('DATE'), iAqi = cols.indexOf('AQI');
    lines.forEach(line => {
      const c = line.split(',');
      const [yr, month, day] = String(c[iDate]).slice(0, 10).split('-').map(Number);
      const n = Number(c[iAqi]);
      if (!(yr < 2020) || c[iAqi] === '' || isNaN(n) || n <= 0 || n >= 1000) return;
      if (!(day >= 1 && day <= DAYS_IN_MONTH(yr, month))) return;
      if (n > 500) capped++;
      early.push({ year: yr, month, day, aqi: Math.min(n, 500) });
    });
  }
  const recs = early.concat(allRecords);
  const mean = vs => vs.reduce((a, b) => a + b, 0) / vs.length;
  const coverage = {};
  recs.forEach(r => { coverage[r.year] = (coverage[r.year] || 0) + 1; });
  const yrs = Object.keys(coverage).map(Number).sort((a, b) => a - b);

  const monthly = {};
  for (let m = 1; m <= 12; m++) {
    const vs = recs.filter(r => r.month === m).map(r => r.aqi);
    monthly[m] = { mean: +mean(vs).toFixed(1), count: vs.length };
  }
  const yearlyMeans = {}, matrix = {};
  yrs.forEach(yr => {
    const inYear = recs.filter(r => r.year === yr);
    yearlyMeans[yr] = +mean(inYear.map(r => r.aqi)).toFixed(1);
    matrix[yr] = {};
    for (let m = 1; m <= 12; m++) {
      const vs = inYear.filter(r => r.month === m).map(r => r.aqi);
      matrix[yr][m] = vs.length ? +mean(vs).toFixed(1) : null;
    }
  });
  const maxAqi = recs.reduce((mx, r) => Math.max(mx, r.aqi), 0);
  const earlyYears = [...new Set(early.map(r => r.year))];
  return {
    recs, totalRecords: recs.length, global: { mean: +mean(recs.map(r => r.aqi)).toFixed(1) },
    monthly, yearlyMeans, yearCoverage: coverage, yearMonthMatrix: matrix, maxAqi,
    daysAtMax: recs.filter(r => r.aqi === maxAqi).length,
    trendYears: yrs.filter(yr => coverage[yr] >= MIN_DAYS_FOR_TREND),
    partialYears: yrs.filter(yr => coverage[yr] < MIN_DAYS_FOR_TREND),
    sources: {
      early: early.length ? { from: Math.min(...earlyYears), to: Math.max(...earlyYears), readings: early.length, capped,
                              label: '“Air Quality Data in India” city_day table, compiled from CPCB station data' } : null,
      cpcb: { from: years[0], to: years[years.length - 1], readings: allRecords.length, label: 'CPCB daily city workbooks' },
    },
  };
})();
if (analytics.sources.early)
  console.log(`📊 Analytics: ${analytics.totalRecords} readings, ${analytics.sources.early.from}–${years[years.length-1]} `
    + `(${analytics.sources.early.capped} early readings capped at 500)`);

// ── ML Lookup ──
let ML_LOOKUP = {}, ML_META = {};
try {
  const mlData = JSON.parse(fs.readFileSync(path.join(__dirname,'ml_lookup.json'),'utf8'));
  ML_LOOKUP = mlData.lookup || {};
  ML_META   = mlData;
  const wf = mlData.walk_forward?.blend;
  console.log(`🤖 ML lookup loaded — ${Object.keys(ML_LOOKUP).length} entries`
    + (wf ? ` · walk-forward MAPE ${wf.mape}%, R² ${wf.r2}` : '')
    + (mlData.generated ? ` · trained ${mlData.generated}` : ''));
} catch(e) { console.log('⚠️  ML lookup not found'); }

// ═══════════════════════════════════════════════════════════
//  LEVEL + SEASONAL SHAPE — the statistical model
// ═══════════════════════════════════════════════════════════
/* A monthly forecast is level(year) x shape(month), the same decomposition
   train_ml.py uses and with the same constants.

   What this replaces: an ordinary least-squares line fitted per month straight
   through the daily readings and extrapolated without bound. Every recent
   slope points upward because the 2020 lockdown dip sits at the start of the
   window, so November came out at 390 for 2026 and 470 for 2035 against a
   321-377 record. Theil-Sen resists that one low year, and damping stops a
   weak slope compounding over a ten-year horizon. */
const LEVEL_YEARS   = 6;    // complete years behind the level trend
const SHAPE_YEARS   = 5;    // complete years behind the seasonal shape
const DAMPING       = 0.8;  // trend damping per year past the last complete one
const BACKTEST_FROM = 5;    // first year held out in the walk-forward

/* The workbooks start in 2020, so six of their years would still end inside
   COVID. ml_lookup.json carries 2015-2019 monthly means — use them for the
   trend where present, and fall back to the workbooks alone when not. */
const monthlySeries = {};
Object.entries(ML_META.monthly_aqi_history || {}).forEach(([key, value]) => {
  if (+key.split('_')[0] < 2020) monthlySeries[key] = value;
});
years.forEach(yr => {
  for (let m = 1; m <= 12; m++)
    if (yearMonthMatrix[yr][m] != null) monthlySeries[`${yr}_${m}`] = yearMonthMatrix[yr][m];
});

const seriesYears = [...new Set(Object.keys(monthlySeries).map(k => +k.split('_')[0]))]
  .sort((a,b) => a-b);
const completeSeriesYears = seriesYears.filter(yr => {
  let n = 0;
  for (let m = 1; m <= 12; m++) if (monthlySeries[`${yr}_${m}`] != null) n++;
  return n === 12;
});
const annualLevels = {};
completeSeriesYears.forEach(yr => {
  let sum = 0;
  for (let m = 1; m <= 12; m++) sum += monthlySeries[`${yr}_${m}`];
  annualLevels[yr] = sum/12;
});

const median = arr => {
  const s = [...arr].sort((a,b) => a-b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h-1]+s[h])/2;
};

function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i++)
    for (let j = i+1; j < xs.length; j++)
      if (xs[j] !== xs[i]) slopes.push((ys[j]-ys[i])/(xs[j]-xs[i]));
  const slope = slopes.length ? median(slopes) : 0;
  return { slope, intercept: median(xs.map((x,i) => ys[i] - slope*x)) };
}

function fitLevel(completeYrs, levels) {
  const recent = completeYrs.slice(-LEVEL_YEARS);
  const { slope, intercept } = theilSen(recent, recent.map(yr => levels[yr]));
  const anchorYear = completeYrs[completeYrs.length-1];
  return { slope, intercept, anchorYear, anchorLevel: intercept + slope*anchorYear,
           yearsUsed: recent };
}

/* Bounded by construction: the damped series sums to at most slope/(1-DAMPING),
   so a 2035 forecast can never run away from a 2026 one. */
function projectLevel(yr, fit) {
  const steps = Math.max(0, yr - fit.anchorYear);
  let damped = 0;
  for (let i = 0; i < steps; i++) damped += DAMPING**i;
  return fit.anchorLevel + fit.slope*damped;
}

function fitShape(completeYrs, levels, series) {
  const shape = {}, counts = {};
  const use = completeYrs.slice(-SHAPE_YEARS);
  for (let m = 1; m <= 12; m++) {
    const ratios = use.map(yr => series[`${yr}_${m}`]/levels[yr]).filter(Number.isFinite);
    shape[m]  = ratios.length ? ratios.reduce((a,b) => a+b, 0)/ratios.length : 1;
    counts[m] = ratios.length;
  }
  return { shape, counts };
}

/* Months are equally spaced, so the first two Fourier harmonics of the shape
   have a closed form — a smooth seasonal curve fitted to the data. This is the
   'seasonal' method, replacing a hardcoded cosine that put Delhi's peak in
   August (380) and its cleanest air in January (97), exactly backwards. */
function harmonicShape(shape) {
  const r = Array.from({length:12}, (_,i) => shape[i+1]);
  const a0 = r.reduce((a,b) => a+b, 0)/12;
  const coefficients = [1,2].map(k => {
    let a = 0, b = 0;
    r.forEach((v,i) => { a += v*Math.cos(2*Math.PI*k*i/12);
                         b += v*Math.sin(2*Math.PI*k*i/12); });
    return { k, a: a/6, b: b/6 };
  });
  const out = {};
  for (let m = 1; m <= 12; m++) {
    const i = m-1;
    out[m] = a0 + coefficients.reduce((sum,c) =>
      sum + c.a*Math.cos(2*Math.PI*c.k*i/12) + c.b*Math.sin(2*Math.PI*c.k*i/12), 0);
  }
  return out;
}

const levelFit    = fitLevel(completeSeriesYears, annualLevels);
const shapeFit    = fitShape(completeSeriesYears, annualLevels, monthlySeries);
const monthShape  = shapeFit.shape;
const smoothShape = harmonicShape(monthShape);
const slope       = levelFit.slope;        // kept under the old names for /api/stats
const intercept   = levelFit.intercept;

/* Walk-forward: refit level and shape on earlier years only, then forecast a
   held-out year. The reported error and the confidence interval come from
   this, not from replaying the fit over its own training data. */
const statBacktest = (() => {
  const pairs = [];
  for (const testYear of completeSeriesYears.slice(BACKTEST_FROM)) {
    const past  = completeSeriesYears.filter(yr => yr < testYear);
    const fit   = fitLevel(past, annualLevels);
    const shape = fitShape(past, annualLevels, monthlySeries).shape;
    const level = projectLevel(testYear, fit);
    for (let m = 1; m <= 12; m++) {
      const actual = monthlySeries[`${testYear}_${m}`];
      if (actual != null) pairs.push([level*shape[m], actual]);
    }
  }
  if (!pairs.length) return { mape:null, relSigma:0.25, r2:null, n:0, yearsTested:[] };
  const rel  = pairs.map(([p,a]) => (p-a)/a);
  const acts = pairs.map(([,a]) => a);
  const mean = acts.reduce((a,b) => a+b, 0)/acts.length;
  const ssRes = pairs.reduce((s,[p,a]) => s + (a-p)**2, 0);
  const ssTot = acts.reduce((s,a) => s + (a-mean)**2, 0);
  return {
    mape: +(100*rel.reduce((s,e) => s+Math.abs(e), 0)/rel.length).toFixed(2),
    relSigma: +Math.sqrt(rel.reduce((s,e) => s+e*e, 0)/rel.length).toFixed(4),
    r2: +(1 - ssRes/ssTot).toFixed(4),
    n: pairs.length,
    yearsTested: completeSeriesYears.slice(BACKTEST_FROM),
  };
})();
const r2 = statBacktest.r2 ?? 0;

console.log(`📈 Level trend: ${slope >= 0 ? '+' : ''}${slope.toFixed(2)} AQI/yr `
  + `(robust, ${levelFit.yearsUsed[0]}–${levelFit.anchorYear}), damping ${DAMPING}`);
console.log(`📐 Statistical model walk-forward: MAPE ${statBacktest.mape}% · `
  + `R² ${statBacktest.r2} (held-out ${statBacktest.yearsTested.join(', ')})`);

// ── Day factors ──
let DAY_FACTORS = {}, WEEK_FACTORS = {};
try {
  const df = JSON.parse(fs.readFileSync(path.join(__dirname,'day_factors.json'),'utf8'));
  DAY_FACTORS  = df.dayFactors  || {};
  WEEK_FACTORS = df.weekFactors || {};
  console.log(`📅 Day factors loaded — ${Object.values(DAY_FACTORS).reduce((s,m)=>s+Object.keys(m).length,0)} entries`);
} catch(e) { console.log('⚠️  Day factors not found'); }

// ── Weather model ──
let weatherData = {};
try {
  const lines = fs.readFileSync(path.join(__dirname,'open-meteo-28_58N77_19E214m.csv'),'utf8').split('\n');
  const di = lines.findIndex(l=>l.includes('temperature_2m_mean')&&l.includes('temperature_2m_max'));
  for (let i=di+1;i<lines.length;i++) {
    const c=lines[i].split(',');
    if(!c[0]||!c[0].match(/^\d{4}/)) continue;
    weatherData[c[0].trim()]={temp_mean:parseFloat(c[1]),humidity:parseFloat(c[4]),wind_max:parseFloat(c[5]),precip:parseFloat(c[6])};
  }
  console.log(`🌤️  Weather data loaded: ${Object.keys(weatherData).length} days`);
} catch(e) { console.log('⚠️  Weather data not found'); }

// ═══════════════════════════════════════════════════════════
//  PREDICTION HELPERS
// ═══════════════════════════════════════════════════════════
function getDayFactor(month, day) {
  const mf = DAY_FACTORS[month] || DAY_FACTORS[String(month)] || {};
  const f  = mf[day] || mf[String(day)];
  if (!f) return 1.0;
  return Math.min(Math.max(f, 0.7), 1.4);
}

function getWeekFactor(week) {
  const wf = WEEK_FACTORS[week] || WEEK_FACTORS[String(week)];
  if (!wf) return { month: Math.ceil(week/4.33), factor: 1.0 };
  return { month: wf.month, factor: Math.min(Math.max(wf.factor, 0.7), 1.4) };
}

function predictMonth(month, targetYear, method) {
  const m  = month || 1;
  const yr = targetYear || 2026;
  const ms = monthlyStats[m];

  // An observed year keeps its own level; only the future is projected.
  const level = annualLevels[yr] != null ? annualLevels[yr] : projectLevel(yr, levelFit);

  let predicted, ratio;
  if (method === 'seasonal') {
    ratio = smoothShape[m];                       // smooth two-harmonic curve
  } else if (method === 'bayes') {
    // The month's own ratio pulled toward the smooth curve; a month observed
    // in few years leans on the curve instead of on its own thin sample.
    const n = shapeFit.counts[m] || 0, prior = 2;
    ratio = (n*monthShape[m] + prior*smoothShape[m])/(n + prior);
  } else if (method === 'normal') {
    ratio = monthShape[m];                        // climatology, trend held flat
  } else {
    ratio = monthShape[m];                        // 'ensemble' / 'regression'
  }
  predicted = (method === 'normal' ? levelFit.anchorLevel : level) * ratio;

  predicted = Math.max(1, Math.round(predicted));
  /* Interval from the model's own held-out error, not from the spread of daily
     readings — a monthly mean is not as uncertain as a single day. */
  const sigma   = statBacktest.relSigma || 0.25;
  const ciLower = Math.max(0, Math.round(predicted*(1 - 1.96*sigma)));
  const ciUpper = Math.round(predicted*(1 + 1.96*sigma));

  return {
    success: true, predicted, ciLower, ciUpper,
    r2: statBacktest.r2, mape: statBacktest.mape,
    level: +level.toFixed(1), seasonalRatio: +ratio.toFixed(3),
    historicalMean: ms.mean, historicalStd: ms.std, historicalMedian: ms.median,
    month: m, targetYear: yr, method: method || 'ensemble',
  };
}

function predict(type, month, day, week, targetYear, method) {
  const yr = targetYear || 2026;

  if (type === 'year') {
    const allM = Array.from({length:12},(_,i)=>predictMonth(i+1,yr,method));
    const avg  = Math.round(allM.reduce((s,r)=>s+r.predicted,0)/12);
    return { ...allM[0], predicted: avg, month: null };
  }

  if (type === 'week') {
    const wf   = getWeekFactor(week||20);
    const base = predictMonth(wf.month, yr, method);
    return { ...base, predicted: Math.max(1,Math.round(base.predicted*wf.factor)),
      ciLower: Math.max(0,Math.round(base.ciLower*wf.factor)),
      ciUpper: Math.round(base.ciUpper*wf.factor) };
  }

  if (type === 'day') {
    const m      = month||1;
    const base   = predictMonth(m, yr, method);
    const factor = getDayFactor(m, day||1);
    return { ...base, predicted: Math.max(1,Math.round(base.predicted*factor)),
      ciLower: Math.max(0,Math.round(base.ciLower*factor)),
      ciUpper: Math.round(base.ciUpper*factor) };
  }

  return predictMonth(month||1, yr, method);
}

function predictML(month, targetYear) {
  const m   = parseInt(month)||1;
  const yr  = parseInt(targetYear)||2026;
  const key = `${yr}_${m}`;
  const ms  = monthlyStats[m]||{};
  if (ML_LOOKUP[key]) {
    const r = ML_LOOKUP[key];
    // Member names depend on which third model was available at training time
    // (xgb when xgboost is installed, hgb otherwise); pass through what exists.
    const members = {};
    (ML_META.model_names || ['rf','xgb','gb']).forEach(n => {
      if (r[n] != null) members[n] = r[n];
    });
    return { success:true, predicted:r.predicted, ...members,
      models:ML_META.model_names, confidence:r.confidence, r2:r.r2,
      source: r.source === 'observed' ? 'observed' : 'ml_ensemble',
      ciLower:Math.max(0,Math.round(r.predicted-1.96*(ms.std||80))),
      ciUpper:Math.round(r.predicted+1.96*(ms.std||80)),
      historicalMean:ms.mean||globalStats.mean, historicalStd:ms.std||globalStats.std };
  }
  return { success:true, ...predictMonth(m,yr,'ensemble'), source:'statistical_fallback' };
}

// ═══════════════════════════════════════════════════════════
//  REAL-TIME AQI — WAQI API
// ═══════════════════════════════════════════════════════════
const WAQI_TOKEN = process.env.WAQI_TOKEN || 'demo';
/* ── Test switch ─────────────────────────────────────────────────────────────
   SAANS_TEST_AQI=320 npm start feeds one made-up reading through the same path
   a real station feed would take, so the ward map and tomorrow's forecast can
   be exercised without a key. It is off unless the variable is set, everything
   it touches is flagged test:true so the UI can say so, and it never counts as
   a live reading for alerts — nobody gets a text because of invented data. */
const TEST_AQI = (() => {
  const v = Number(process.env.SAANS_TEST_AQI);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(500, Math.round(v));
})();
/* Real CPCB sites, so the map spreads plausibly; the numbers are invented. */
const TEST_SITES = [
  ['Anand Vihar', 28.6469, 77.3162, 1.18], ['ITO', 28.6285, 77.2410, 1.06],
  ['Dwarka Sector 8', 28.5710, 77.0719, 0.82], ['Punjabi Bagh', 28.6740, 77.1310, 1.02],
  ['R K Puram', 28.5632, 77.1868, 0.88], ['Mandir Marg', 28.6365, 77.2010, 0.95],
  ['Rohini', 28.7325, 77.1198, 1.10], ['Narela', 28.8227, 77.1020, 1.14],
  ['Okhla Phase 2', 28.5308, 77.2711, 1.04], ['Najafgarh', 28.5700, 76.9340, 0.80],
  ['Shadipur', 28.6514, 77.1580, 0.98], ['Bawana', 28.7762, 77.0510, 1.20],
];
const testStations = () => TEST_SITES.map(([name, lat, lon, k]) => ({
  station: `${name} (test)`, name: `${name} (test)`, lat, lon,
  aqi: Math.max(10, Math.min(500, Math.round(TEST_AQI * k))),
  dominant: 'PM2.5', updated: new Date().toISOString(),
}));
if (TEST_AQI) console.log(`🧪 TEST MODE — SAANS_TEST_AQI=${TEST_AQI}. Readings are INVENTED, `
  + 'flagged test:true, and cannot trigger an alert. Unset the variable for real behaviour.');

const DELHI_STATIONS = [
  'delhi/anand-vihar','delhi/ito','delhi/dwarka-sector-8',
  'delhi/punjabi-bagh','delhi/r-k-puram','delhi/mandir-marg',
];
let rtCache = null, rtCacheTime = 0;
const RT_CACHE_MS = 30*60*1000;

// Derived from the loaded sheets so it can never drift from the data again.
const MONTH_AVGS = Object.fromEntries(
  Object.entries(monthlyStats).map(([m,st]) => [m, st.mean]));

function buildFallback() {
  const m = new Date().getMonth()+1;
  return { success:false, fallback:true, aqi:Math.round(MONTH_AVGS[m]||187),
    stations:[], count:0, updated:new Date().toISOString(),
    source:'Historical average for this month (set WAQI_TOKEN env var for live data)' };
}

async function fetchStations() {
  if (TEST_AQI) {
    const stations = testStations();
    return { success:true, test:true, aqi:TEST_AQI, stations, count:stations.length,
             updated:new Date().toISOString(), source:'TEST DATA — SAANS_TEST_AQI, not a measurement',
             band: (v => (BANDS.find(([max]) => v <= max) || BANDS[5])[1])(TEST_AQI) };
  }
  if (rtCache && Date.now()-rtCacheTime < RT_CACHE_MS) return rtCache;

  /* CPCB's own stations first, when a data.gov.in key is set: the same feed the
     ward map uses, rated on India's scale from 24-hour means. The city reading
     is the mean of the stations, as CPCB's bulletin does. WAQI is the fallback. */
  if (process.env.DATA_GOV_IN_KEY) {
    const w = await wards.wardAQI();
    if (w.available && !w.test && w.stations.length >= 3) {
      const avg = Math.round(w.stations.reduce((s, x) => s + x.aqi, 0) / w.stations.length);
      rtCache = { success:true, aqi:avg,
        stations: w.stations.map(x => ({ station: x.name, aqi: x.aqi })),
        count: w.stations.length, updated: w.updated,
        source: `live · ${w.stations.length} CPCB stations (data.gov.in)`,
        band: (v => (BANDS.find(([max]) => v <= max) || BANDS[5])[1])(avg) };
      rtCacheTime = Date.now();
      return rtCache;
    }
  }
  if (WAQI_TOKEN === 'demo') return buildFallback();
  try {
    const results = await Promise.allSettled(
      DELHI_STATIONS.map(async station => {
        const ctrl  = new AbortController();
        const timer = setTimeout(()=>ctrl.abort(), 6000);
        try {
          const r = await fetch(`https://api.waqi.info/feed/${station}/?token=${WAQI_TOKEN}`,{signal:ctrl.signal});
          clearTimeout(timer);
          return r.json();
        } catch(e) { clearTimeout(timer); throw e; }
      })
    );
    const valid = results
      .filter(r=>r.status==='fulfilled'&&r.value?.status==='ok')
      .map(r=>({ station:r.value.data.city?.name||'Delhi', aqi:parseInt(r.value.data.aqi) }))
      .filter(r=>!isNaN(r.aqi)&&r.aqi>0);
    if (!valid.length) return buildFallback();
    const avgAqi = Math.round(valid.reduce((s,r)=>s+r.aqi,0)/valid.length);
    rtCache = { success:true, aqi:avgAqi, stations:valid, count:valid.length,
      updated:new Date().toISOString(), source:'WAQI API',
      band: (v => (BANDS.find(([max]) => v <= max) || BANDS[5])[1])(avgAqi) };
    rtCacheTime = Date.now();
    return rtCache;
  } catch(e) { return buildFallback(); }
}

/* ── Keyless fallback: Open-Meteo's CAMS air-quality model ────────────────
   Not a station reading — a satellite-driven model. Validated against this
   project's CPCB readings (Aug 2022-Mar 2025), converted raw it reads Delhi's
   winter ~89 points too clean. So:
   · OM_CAL corrects its level:  real ≈ exp(a + b·ln model), fitted on 2022-23.
     Held out on 2024-25 that cut its bias from -47 to -12.
   · OM_TRUST is how much of its departure from normal is worth believing,
     also fitted on 2022-23. At 0.2 it trimmed held-out error from 46 to 42
     today and 46 to 43 tomorrow — useful, but a ground station is worth ~6x.
   It never counts as live: an estimate must not trigger a public alert. */
const OM_CAL   = { a: 2.458, b: 0.565 };
const OM_TRUST = 0.2;
const NAQI_BP = {   // CPCB National AQI breakpoints, 24-hour means, µg/m³
  pm25: { c:[0,30,60,90,120,250,500], i:[0,50,100,200,300,400,500] },
  pm10: { c:[0,50,100,250,350,430,600], i:[0,50,100,200,300,400,500] },
};
function naqiSub(v, bp) {
  for (let k = 1; k < bp.c.length; k++)
    if (v <= bp.c[k]) return bp.i[k-1] + (v - bp.c[k-1]) * (bp.i[k] - bp.i[k-1]) / (bp.c[k] - bp.c[k-1]);
  return 500;
}
let omCache = null, omCacheTime = 0;
async function fetchModelEstimate() {
  if (omCache && Date.now() - omCacheTime < RT_CACHE_MS) return omCache;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=28.6139&longitude=77.2090'
              + '&hourly=pm10,pm2_5&past_days=1&forecast_days=1&timezone=Asia%2FKolkata';
    const j = await (await fetch(url, { signal: ctrl.signal })).json();
    // hourly times are IST wall-clock; take the 24 hours ending now
    const nowIST = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 13);
    const end = j.hourly.time.findIndex(t => t.slice(0, 13) === nowIST);
    if (end < 0) return null;
    const pick = arr => arr.slice(Math.max(0, end - 23), end + 1).filter(v => v != null);
    const p25 = pick(j.hourly.pm2_5), p10 = pick(j.hourly.pm10);
    if (p25.length < 18 || p10.length < 18) return null;
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const raw = Math.max(1, Math.max(naqiSub(avg(p25), NAQI_BP.pm25), naqiSub(avg(p10), NAQI_BP.pm10)));
    omCache = {
      aqi: Math.round(Math.exp(OM_CAL.a + OM_CAL.b * Math.log(raw))),
      raw: Math.round(raw), pm25: +avg(p25).toFixed(1), pm10: +avg(p10).toFixed(1),
      hours: p25.length, trust: OM_TRUST, updated: new Date().toISOString(),
      source: 'Open-Meteo air-quality model, calibrated to CPCB',
    };
    omCacheTime = Date.now();
    return omCache;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

/* Live stations when there are some; otherwise the monthly average, with the
   calibrated model estimate attached separately so nothing mistakes it for live. */
async function fetchRealtimeAQI() {
  const rt = await fetchStations();
  if (rt.fallback) rt.estimate = await fetchModelEstimate();
  return rt;
}

// ═══════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════

// Stats
app.get('/api/stats', (req,res) => {
  /* The projected level is damped, so it is not a straight line — the chart
     reads these values rather than re-deriving them from slope/intercept. */
  const levelProjection = {};
  for (let yr = levelFit.anchorYear; yr <= levelFit.anchorYear + 11; yr++)
    levelProjection[yr] = +projectLevel(yr, levelFit).toFixed(1);

  // display fields cover all ten years; the model fields below stay CPCB-only
  const A = analytics;
  res.json({ totalRecords:A.totalRecords, global:A.global, monthly:A.monthly,
    yearlyMeans:A.yearlyMeans, yearCoverage:A.yearCoverage,
    trendYears:A.trendYears, partialYears:A.partialYears,
    maxAqi:A.maxAqi, daysAtMax:A.daysAtMax, sources:A.sources,
    levelModel:{ slope:+slope.toFixed(4), anchorYear:levelFit.anchorYear,
                 anchorLevel:+levelFit.anchorLevel.toFixed(1), damping:DAMPING,
                 yearsUsed:levelFit.yearsUsed, method:'Theil–Sen' },
    levelProjection, seasonalShape:monthShape,
    yearlyRegression:{slope:+slope.toFixed(4),intercept:+intercept.toFixed(2),r2:statBacktest.r2},
    modelAccuracy:{ walkForward:statBacktest }, yearMonthMatrix:A.yearMonthMatrix });
});

// Predict (statistical)
app.post('/api/predict', (req,res) => {
  const {type,month,day,week,targetYear,method} = req.body;
  try { res.json(predict(type,month,day,week,targetYear,method||'ensemble')); }
  catch(e) { res.status(500).json({success:false,error:e.message}); }
});

// Forecast (12 months)
app.get('/api/forecast/:year', (req,res) => {
  const yr     = parseInt(req.params.year);
  const method = req.query.method||'ensemble';
  const rows   = Array.from({length:12},(_,i)=>({
    month:i+1, monthName:MONTHS[i],
    ...predictMonth(i+1,yr,method)
  }));
  res.json(rows);
});

// Daily records
app.get('/api/daily/:year/:month', (req,res) => {
  const yr=parseInt(req.params.year), mo=parseInt(req.params.month);
  const recs = analytics.recs.filter(r=>r.year===yr&&r.month===mo)
    .sort((a,b)=>a.day-b.day).map(r=>({day:r.day,aqi:r.aqi}));
  res.json(recs);
});

// ML predict — mirrors the scope handling of /api/predict
app.post('/api/predict-ml', (req,res) => {
  const {month,targetYear,type,day,week} = req.body;
  const m  = parseInt(month)||1;
  const yr = parseInt(targetYear)||2026;

  if (type === 'year') {
    // An annual average is the mean of the twelve months, not whichever month
    // the (hidden) month selector happened to be left on.
    const all  = Array.from({length:12},(_,i)=>predictML(i+1,yr));
    const mean = pick => Math.round(all.reduce((s,r)=>s+(r[pick]||0),0)/12);
    const members = {};
    (ML_META.model_names || []).forEach(n => {
      if (all.every(r => r[n] != null)) members[n] = mean(n);   // annual, not January's
    });
    return res.json({ ...all[0], ...members, predicted:mean('predicted'),
      month:null, targetYear:yr, type:'year',
      historicalMean:globalStats.mean, historicalStd:globalStats.std,
      ciLower:mean('ciLower'), ciUpper:mean('ciUpper') });
  }

  if (type === 'week' && week) {
    // The week carries its own month — week 45 is November whatever the month
    // selector says.
    const wf   = getWeekFactor(parseInt(week));
    const base = predictML(wf.month, yr);
    return res.json({ ...base, month:wf.month, targetYear:yr, type:'week',
      predicted: Math.max(1,Math.round(base.predicted*wf.factor)),
      ciLower:   Math.max(0,Math.round((base.ciLower||0)*wf.factor)),
      ciUpper:   Math.round((base.ciUpper||500)*wf.factor) });
  }

  const base = predictML(m,yr);
  if (type === 'day' && day) {
    const f = getDayFactor(m,parseInt(day));
    return res.json({ ...base, month:m, targetYear:yr, type:'day',
      predicted: Math.max(1,Math.round(base.predicted*f)),
      ciLower:   Math.max(0,Math.round((base.ciLower||0)*f)),
      ciUpper:   Math.round((base.ciUpper||500)*f) });
  }
  res.json({ ...base, month:m, targetYear:yr, type:'month' });
});

// ML forecast (12 months)
app.get('/api/ml-forecast/:year', (req,res) => {
  const yr  = parseInt(req.params.year);
  const rows = Array.from({length:12},(_,i) => {
    const m  = i+1;
    const ml = predictML(m,yr);
    const ms = monthlyStats[m]||{};
    return { month:m, monthName:MONTHS[m-1], ...ml,
      ciLower:Math.max(0,Math.round(ml.predicted-1.96*(ms.std||80))),
      ciUpper:Math.round(ml.predicted+1.96*(ms.std||80)) };
  });
  res.json(rows);
});

/* ── Short-range forecast anchored on today's reading ────────────────────
   Air today says a lot about air tomorrow and little about next week. The
   anchor is today's departure from the seasonal norm (in log terms); each day
   ahead keeps PERSISTENCE of it, so the forecast fades back to seasonal.

   PERSISTENCE is the lag-1 autocorrelation of that daily departure, fitted on
   2020-22 CPCB readings. Held out on 2023-24 it cut next-day error from 44 to
   30 AQI points and three-day error from 44 to 40, with no gain by day seven —
   which is also why the outlook stops at seven days.

   `trust` scales how much of a source's departure is believed: a ground-station
   reading is taken at face value; a modelled estimate earns a lower weight. */
const PERSISTENCE = 0.744;

function anchoredDays(seasonal, anchor) {
  const departure = Math.log(anchor.aqi) - Math.log(seasonal[0].seasonal);
  return seasonal.map((d, h) => ({
    ...d,
    aqi: Math.max(1, Math.round(d.seasonal * Math.exp(anchor.trust * departure * PERSISTENCE ** h))),
    anchored: true,
  }));
}

/* Seven-day outlook. Seasonal by default; anchored on a live reading when one
   exists and the outlook starts today (an anchor says nothing about a date
   picked in the past or future). */
app.get('/api/week', async (req,res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date();
  if (isNaN(from)) return res.status(400).json({ error:'Bad from date' });
  const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const seasonal = Array.from({length:7}, (_,i) => {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate()+i);
    const m = d.getMonth()+1, day = d.getDate(), yr = d.getFullYear();
    const base = predictML(m, yr);
    const factor = getDayFactor(m, day);
    const value = Math.max(1, Math.round(base.predicted * factor));
    return { date: `${yr}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
             weekday: WD[d.getDay()], day, month: m, year: yr,
             aqi: value, seasonal: value, factor: +factor.toFixed(3),
             today: i === 0, anchored: false };
  });

  let anchor = null;
  if (!req.query.from) {
    const rt = await fetchRealtimeAQI();
    if (!rt.fallback && rt.count > 0)
      anchor = { aqi: rt.aqi, kind: 'live', trust: 1, test: !!rt.test,
                 source: rt.source || `live · ${rt.count} ground stations` };
    else if (rt.estimate)
      anchor = { aqi: rt.estimate.aqi, kind: 'estimate', trust: rt.estimate.trust,
                 source: rt.estimate.source };
  }

  const days = anchor ? anchoredDays(seasonal, anchor) : seasonal;

  /* Tomorrow is the one day where the weather beats seasonal decay, so swap in
     the next-day model when it can run: a live station reading, and an outlook
     that starts today. Days after it keep fading to the seasonal norm. */
  let nextDay = null;
  if (anchor && anchor.kind === 'live' && days.length > 1) {
    const t = await nextday.tomorrowAQI({ aqi: anchor.aqi, live: true });
    if (t.available && t.date === days[1].date) {
      days[1] = { ...days[1], aqi: t.aqi, low: t.low, high: t.high,
                  drivers: t.drivers, source: 'nextday-model' };
      nextDay = { used: true, mae: t.accuracy.mae, versusRule: t.accuracy.versusRule,
                  years: t.accuracy.years, drivers: t.drivers };
    } else {
      nextDay = { used: false, reason: t.reason || 'date_mismatch' };
    }
  }

  res.json({
    days, anchored: !!anchor, anchor, persistence: PERSISTENCE, nextDay,
    source: anchor ? `${anchor.source}, fading to seasonal`
                     + (nextDay && nextDay.used ? '; tomorrow from the weather-driven model' : '')
                   : (ML_META.model_names ? 'ml_ensemble × day factor' : 'statistical × day factor'),
  });
});

// ML meta
app.get('/api/ml-meta', (req,res) => {
  res.json({ success:true,
    models: ML_META.model_names || [],
    weights: ML_META.weights || {},
    walk_forward: ML_META.walk_forward || {},
    level_model: ML_META.level_model || {},
    features: ML_META.features || [],
    training_records: ML_META.training_records || 0,
    generated: ML_META.generated || null,
    total_lookup: Object.keys(ML_LOOKUP).length });
});

// Real-time AQI
app.get('/api/realtime', async (req,res) => {
  const data = await fetchRealtimeAQI();
  res.json(data);
});

// ═══════════════════════════════════════════════════════════
//  PUBLIC ALERTS
// ═══════════════════════════════════════════════════════════
const BANDS = [[50,'Good'],[100,'Satisfactory'],[200,'Moderate'],
               [300,'Poor'],[400,'Very Poor'],[9999,'Severe']];
const bandLabel = aqi => (BANDS.find(([max]) => aqi <= max) || BANDS[5])[1];

/* The reading an alert would be built on, and how much it can be trusted.
   A modelled monthly average is not grounds for telling Delhi to stay indoors,
   so the two are never conflated. */
async function alertBasis() {
  const rt = await fetchRealtimeAQI();
  const live = !rt.fallback && rt.count > 0 && !rt.test;   // test data is not a reading
  return { aqi: rt.aqi, band: bandLabel(rt.aqi), live, test: !!rt.test,
           basis: rt.test ? 'TEST DATA — not a measurement'
                : live ? (rt.source || `live · ${rt.count} stations`) : 'modelled monthly average (no live feed)',
           stations: rt.stations || [], updated: rt.updated };
}

app.post('/api/alerts/subscribe', (req,res) => {
  const { phone, language, threshold } = req.body || {};
  const r = alerts.subscribe(phone, language, threshold);
  if (!r.ok) return res.status(422).json({ success:false, error:r.error });
  res.json({ success:true, already:r.already, subscribers: alerts.countSubscribers(),
             note:'Your number is stored only as a salted one-way hash.' });
});

/* What a broadcast would say and who it would reach. Writes nothing, so the
   preview and the recorded send come out of the same code. */
app.get('/api/alerts/preview', async (req,res) => {
  const language = req.query.language || 'en';
  const b = await alertBasis();
  const aqi = req.query.aqi ? parseInt(req.query.aqi) : b.aqi;
  const band = bandLabel(aqi);
  const composed = alerts.compose(aqi, band, language);
  res.json({ success:true, aqi, band, ...composed,
             warranted: alerts.warranted(aqi), alertFrom: alerts.ALERT_FROM,
             reach: alerts.reach(composed.language, aqi),
             provider: alerts.provider(), dataBasis: b.basis, live: b.live });
});

app.get('/api/alerts/log', (req,res) =>
  res.json({ broadcasts: alerts.listBroadcasts(parseInt(req.query.limit) || 25) }));

/* A dry run records what would have gone out. A real send needs an operator
   token, a live reading and a configured gateway — and even then returns 501,
   because delivery is not built: numbers are stored as one-way hashes, so
   there is nothing to hand a provider. Nothing is ever logged as sent. */
app.post('/api/alerts/broadcast', async (req,res) => {
  const { language = 'en', dry_run = true, aqi: override } = req.body || {};
  const b = await alertBasis();
  const aqi = Number.isInteger(override) ? override : b.aqi;
  const band = bandLabel(aqi);
  const composed = alerts.compose(aqi, band, language);
  const reach = alerts.reach(composed.language, aqi);

  if (!dry_run) {
    const want = process.env.SAANS_BROADCAST_TOKEN;
    if (!want) return res.status(503).json({ error:
      'Real broadcasts are switched off: SAANS_BROADCAST_TOKEN is not set on the server.' });
    const given = req.get('X-Saans-Token') || '';
    const ok = given.length === want.length &&
      require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!ok) return res.status(401).json({ error:'A real broadcast needs a valid X-Saans-Token header.' });
    if (Number.isInteger(override)) return res.status(400).json({ error:
      'A typed-in AQI can only be broadcast as a dry run — it is not a reading.' });
    if (b.test) return res.status(409).json({ error:
      'Test mode is on (SAANS_TEST_AQI): the reading is invented, so it cannot be broadcast. ' +
      'Unset the variable and use a real feed.' });
    if (!b.live) return res.status(409).json({ error:
      'No live reading: a real broadcast would carry a modelled monthly average. ' +
      'Set WAQI_TOKEN and retry, or send as a dry run.' });
    if (!alerts.warranted(aqi)) return res.status(409).json({ error:
      `AQI ${aqi} is below the alert threshold of ${alerts.ALERT_FROM}. ` +
      'Alerting on a routine day teaches people to ignore the ones that matter.' });
    if (!alerts.provider()) return res.status(503).json({ error:
      'No SMS gateway configured. Set MSG91_AUTHKEY or TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.' });
    return res.status(501).json({ error:
      'Delivery is not implemented: subscriber numbers are stored as one-way hashes, so there ' +
      'is nothing to send to. Real delivery needs encrypted numbers, a send queue, delivery ' +
      'receipts and (in India) DLT registration of the sender ID and template.' });
  }

  const job_id = 'bc_' + require('crypto').randomBytes(6).toString('hex');
  const rec = { job_id, ts: alerts.now(), aqi, band, language: composed.language,
                message: composed.message, segments: composed.segments,
                encoding: composed.encoding, recipients: reach.targeted,
                status:'simulated', dry_run:true, basis: b.basis };
  alerts.logBroadcast(rec);
  res.status(202).json({ ...rec, success:true, dry_run:true, provider:'none (dry run)',
    reach, warranted: alerts.warranted(aqi),
    segmentsBilled: composed.segments * reach.targeted });
});

// ═══════════════════════════════════════════════════════════
//  AI ASSISTANT
// ═══════════════════════════════════════════════════════════
/* Credentials resolve at request time (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
   or an `ant auth login` profile), so a missing key surfaces on the first
   chat call rather than here. chatError() turns that into a clear 503. */
const anthropic = new Anthropic();
const CHAT_MODEL = 'claude-opus-5';

/* Two chat providers, picked in .env. CHAT_PROVIDER=gemini|anthropic chooses one;
   unset, Gemini wins when its key is present (its API has a free tier), else
   Anthropic. Both get the same system prompt, so the answers rest on the same
   Delhi figures and the same rules. */
const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-3.6-flash';   // 2.5 Flash is closed to new keys
const CHAT_PROVIDER = (process.env.CHAT_PROVIDER || (GEMINI_KEY ? 'gemini' : 'anthropic')).toLowerCase();
const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
if (CHAT_PROVIDER === 'gemini')
  console.log(GEMINI_KEY ? `💬 Chat: Gemini (${GEMINI_MODEL})`
                         : '⚠️  CHAT_PROVIDER=gemini but no GEMINI_API_KEY — /api/chat will report it is not set up');
else
  console.log(hasAnthropicKey ? `💬 Chat: Anthropic (${CHAT_MODEL})`
                              : '⚠️  No chat key (GEMINI_API_KEY or ANTHROPIC_API_KEY) — /api/chat will report it is not set up');
const LANGS = { en:'English', hi:'Hindi (Devanagari script)',
                pa:'Punjabi (Gurmukhi script)', ur:'Urdu' };

/* What the assistant can say about right now. Every source here is already
   cached upstream (30 minutes), and none of it may break a chat: a failure just
   means the prompt says the figure is unavailable. */
async function chatContext() {
  const ctx = {};
  const work = (async () => {
    const rt = await fetchRealtimeAQI();
    ctx.rt = rt;
    if (!rt.fallback && rt.count > 0) ctx.tomorrow = await nextday.tomorrowAQI({ aqi: rt.aqi, live: true });
  })();
  await Promise.race([work.catch(e => { ctx.error = e.message; }),
                      new Promise(ok => setTimeout(ok, 8000))]);
  return ctx;
}

const istTime = iso => new Date(iso).toLocaleTimeString('en-IN',
  { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });

function liveSection(ctx) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
  const rt = ctx.rt;
  let today;
  if (rt && rt.test)
    today = `TEST MODE — the reading ${rt.aqi} is invented for testing. Tell the user plainly that it is test data, not real air.`;
  else if (rt && !rt.fallback && rt.count > 0)
    today = `Delhi AQI now: ${rt.aqi} (${bandLabel(rt.aqi)}) — the average of ${rt.count} CPCB ground stations, `
          + `updated ${istTime(rt.updated)} IST. This is a live measurement.`;
  else if (rt && rt.estimate)
    today = `No live station reading right now. A satellite-based model estimates Delhi near ${rt.estimate.aqi} `
          + `(${bandLabel(rt.estimate.aqi)}); call it an estimate, not a measurement.`;
  else
    today = 'No live reading is available right now. Say you cannot see today\'s air, and suggest the app\'s Today page.';

  const t = ctx.tomorrow;
  const tomorrow = t && t.available
    ? `Forecast for ${new Date(t.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}: `
      + `${t.aqi} (${bandLabel(t.aqi)}), likely between ${t.low} and ${t.high}`
      + (t.drivers.length ? `, because of ${t.drivers.join(' and ')}` : '')
      + `. It is a forecast from today's reading and the weather, typically out by about ${Math.round(t.accuracy.mae)} AQI.`
      + (rt && rt.test ? ' (Built on the test reading, so it is test data too.)' : '')
    : 'No next-day forecast is available right now.';

  return `RIGHT NOW (${now} IST):\nTODAY: ${today}\nTOMORROW: ${tomorrow}`;
}

/* Built from the loaded sheets on every call, so the assistant quotes the same
   numbers the charts show instead of figures pasted in at write time. */
function buildSystemPrompt(language, ctx = {}) {
  const means   = Array.from({length:12},(_,i)=>Math.round(monthlyStats[i+1].mean));
  const worstIx = means.indexOf(Math.max(...means));
  const bestIx  = means.indexOf(Math.min(...means));
  const span    = `${years[0]}–${years[years.length-1]}`;
  const lang    = LANGS[language] || LANGS.en;

  return `You are Saans — the friendly assistant inside Saans AQI, an app about
Delhi's air quality. "Saans" means breath, which is the point: you help ordinary
people decide what is safe to do outside today.
Help regular people (not scientists) understand air quality in simple, caring language.

${liveSection(ctx)}

DELHI AQI FACTS — CPCB daily readings, ${span} (${allRecords.length.toLocaleString('en-IN')} days):
- Average AQI: ${Math.round(globalStats.mean)} | Worst month: ${MONTHS[worstIx]} (${means[worstIx]}) | Best month: ${MONTHS[bestIx]} (${means[bestIx]})
- Monthly averages: ${MONTHS.map((m,i)=>`${m.slice(0,3)} ${means[i]}`).join(', ')}
- Winter (Oct–Jan) is worst: crop burning plus cold air that traps pollutants
- Monsoon (Jul–Sep) is cleanest: rain washes the air
- AQI above 300 = serious health risk | above 400 = emergency

RULES FOR NUMBERS:
- For questions about today or tomorrow, use the TODAY and TOMORROW figures above and say where they come from.
- Never invent a number for any other day, or for a particular neighbourhood — the city figure is an average.
  For a specific area, point people to the app's Ward Map, which shows an estimate for each area from
  its nearest stations (an estimate, not an exact reading).
- When you quote a monthly or yearly average, say it is the ${span} CPCB average (for example "on average in
  ${span}"). The app's Analytics page also includes 2015–2019 from another source, so its figures run higher.

AQI CATEGORIES: 0-50 Good | 51-100 Satisfactory | 101-200 Moderate | 201-300 Poor | 301-400 Very Poor | 401+ Severe

LANGUAGE RULES (critical):
- The user has selected ${lang}. Reply in ${lang} by default.
- If the user writes in a different language (English, Hindi, Punjabi or Urdu), reply in the language they wrote in instead.

SCOPE: Only help with air quality, pollution, how weather affects the air, and
health precautions in Delhi. If asked about anything else, say briefly and kindly
— in the user's language — that you can only help with Delhi's air, and suggest
one air-quality question they could ask instead.

STYLE: warm and friendly, use emojis, at most 4-5 sentences, no jargon.
FORMAT: plain text only. The app shows your words exactly as written, so never use
markdown — no **bold**, no *italics*, no # headings, no bullet symbols.
Latency-sensitive; begin your visible answer immediately.`;
}

async function askClaude(message, system) {
  const response = await anthropic.beta.messages.create({
    model: CHAT_MODEL,
    max_tokens: 1024,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',                    // a declined request retries server-side
    output_config: { effort: 'low' },        // short friendly answers, low latency
    system,
    messages: [{ role: 'user', content: message }],
  });
  if (response.stop_reason === 'refusal') return null;
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

/* Gemini over plain REST — no SDK needed. The key travels in a header, never
   in the URL, so it cannot end up in a log line. The free tier sheds load with
   503 "high demand" now and then, so a busy or failed server gets one retry. */
async function askGemini(message, system) {
  if (!GEMINI_KEY) throw Object.assign(new Error('GEMINI_API_KEY is not set'), { chat: 'not_configured' });
  const generationConfig = { maxOutputTokens: 2048, temperature: 0.7 };
  // Thinking bills against the output budget and adds seconds; a four-sentence
  // answer does not need it. 2.5 models take a budget, 3.x models a level.
  if (/^gemini-2\.5/.test(GEMINI_MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (/^gemini-3/.test(GEMINI_MODEL)) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: message }] }],
    generationConfig,
  });

  for (let attempt = 1; ; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
        { method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if ((r.status === 503 || r.status === 500) && attempt < 2) {
          console.log(`↻  Gemini answered ${r.status} — retrying once`);
          await new Promise(ok => setTimeout(ok, 1500));
          continue;
        }
        throw Object.assign(new Error((j.error && j.error.message) || `Gemini answered ${r.status}`),
                            { chat: 'api', status: r.status });
      }
      if (j.promptFeedback && j.promptFeedback.blockReason) return null;      // blocked question
      const c = (j.candidates || [])[0];
      if (!c || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(c.finishReason)) return null;
      const text = ((c.content && c.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
      return text || null;
    } finally { clearTimeout(timer); }
  }
}

async function askAssistant(message, language) {
  const system = buildSystemPrompt(language, await chatContext());
  return CHAT_PROVIDER === 'gemini' ? askGemini(message, system) : askClaude(message, system);
}

function chatError(res, e) {
  if (e && e.chat === 'not_configured')
    return res.status(503).json({ error:
      'The assistant is not set up yet. Add GEMINI_API_KEY (free at aistudio.google.com) to .env and restart the server.' });
  if (e && e.name === 'AbortError')
    return res.status(504).json({ error: 'The assistant took too long — please try again.' });
  if (e && e.chat === 'api') {
    const bad = e.status === 401 || e.status === 403 || (e.status === 400 && /api key/i.test(e.message));
    if (bad) return res.status(503).json({ error: 'The assistant key was rejected. Check GEMINI_API_KEY.' });
    if (e.status === 429)
      return res.status(429).json({ error: 'The free assistant quota is used up for now — please try again later.' });
    if (e.status === 503 || e.status === 500)
      return res.status(503).json({ error: 'The assistant is very busy right now — please try again in a moment.' });
    console.error('Chat error (Gemini):', e.status, e.message);
    return res.status(500).json({ error: 'The assistant is unavailable right now.' });
  }
  if (e instanceof Anthropic.AuthenticationError)
    return res.status(503).json({ error: 'The assistant key was rejected. Check ANTHROPIC_API_KEY.' });
  if (e instanceof Anthropic.RateLimitError)
    return res.status(429).json({ error: 'Too many questions at once — please try again in a moment.' });
  if (!(e instanceof Anthropic.APIError)) {
    // Never reached the API — almost always no credentials configured.
    console.error('Chat not configured:', e.message);
    return res.status(503).json({
      error: 'The assistant is not set up yet. Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to .env and restart the server.' });
  }
  console.error('Chat error:', e.message);
  return res.status(500).json({ error: 'The assistant is unavailable right now.' });
}

// Multilingual AI chat
app.post('/api/chat', async (req,res) => {
  const { message, language } = req.body;
  if (!message) return res.status(400).json({ error:'No message' });
  try {
    const reply = await askAssistant(message, language);
    if (reply === null) return res.json({ success:false,
      reply:"Sorry, I can't help with that one — ask me about Delhi's air quality instead. 🌿" });
    res.json({ success:true, reply });
  } catch(e) { chatError(res, e); }
});

// AI Analyze (legacy)
app.post('/api/ai-analyze', async (req,res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error:'No question' });
  try {
    const answer = await askAssistant(question, 'en');
    res.json({ success: answer !== null, answer: answer ?? 'I cannot answer that one.' });
  } catch(e) { chatError(res, e); }
});

/* Tomorrow, from today's station reading and the weather forecast. Gated on a
   real reading: on the keyless estimate the model scores worse than the
   seasonal average, so it declines rather than printing a false precision. */
app.get('/api/tomorrow', async (req,res) => {
  const rt = await fetchRealtimeAQI();
  const live = !rt.fallback && rt.count > 0;
  const out = await nextday.tomorrowAQI({ aqi: rt.aqi, live });
  if (out.available) { out.band = bandLabel(out.aqi); out.todayBand = bandLabel(out.anchor.aqi); out.test = !!rt.test; }
  res.json(out);
});

// Ward-wise AQI: CPCB stations interpolated onto ward centres
app.get('/api/wards', async (req,res) => res.json(await wards.wardAQI()));
app.get('/api/wards/boundaries', (req,res) => {
  const geo = wards.boundaries();
  if (!geo) return res.status(404).json({ error:'No ward boundaries on this server' });
  res.json(geo);
});

// Catch-all → index.html
app.get('/{*splat}', (req,res) => {
  res.setHeader('Content-Type','text/html');
  res.sendFile(path.join(__dirname,'index.html'));
});

const PORT = process.env.PORT || 3000;
/* Express 5 hands a failed bind to this callback instead of throwing, so check
   it: otherwise a second copy prints "running" while the first keeps the port. */
app.listen(PORT, err => {
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `❌ Port ${PORT} is already in use — Saans AQI is probably running already.\n`
        + `   Stop it first:  lsof -ti tcp:${PORT} | xargs kill`
      : `❌ Could not start on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`✅ Saans AQI running on http://localhost:${PORT}`);
});
