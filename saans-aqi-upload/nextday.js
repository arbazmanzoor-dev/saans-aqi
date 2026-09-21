'use strict';
/* Tomorrow's Delhi AQI.

   The monthly model answers "what is a November like?". This one answers
   "what is tomorrow like?", which is a different question with different
   inputs: today's reading, and how the weather changes overnight.

   Walk-forward on 2019-2025, with realistic one-day forecast error added to
   tomorrow's weather, it averages 27.6 AQI of error against 31.0 for the
   app's damped-persistence rule and 32.4 for plain persistence.

   It only runs on a ground-station reading. Anchored on the keyless
   Open-Meteo estimate the same model scores 46.6 — worse than the seasonal
   average — so without a station feed this returns nothing rather than a
   number that looks precise and is not.

   The model is trained by train_nextday.py and exported as trees; nothing
   Python runs at request time. */
const fs   = require('fs');
const path = require('path');

const MODEL_FILE = path.join(__dirname, 'nextday_model.json');
const CACHE_MS   = 30 * 60 * 1000;
/* Open-Meteo's free API limits requests per IP address, and shared hosts put many
   apps behind one address — so ask less often, retry once, and when it still
   refuses, fall back to the last good forecast rather than to nothing. */
const WEATHER_TTL_MS   = 60 * 60 * 1000;      // a forecast stays good for an hour
const WEATHER_STALE_MS = 3 * 60 * 60 * 1000;  // after a failure, one up to 3 h old will do
const LAT = 28.6139, LON = 77.2090;

let MODEL = null;
try {
  MODEL = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
  console.log(`🔮 Next-day model loaded — ${MODEL.trees.length} trees, `
    + `walk-forward MAE ${MODEL.walk_forward.mae} (rule ${MODEL.walk_forward.baselines.app_rule_phi_0744.mae})`);
} catch (e) {
  console.log('⚠️  Next-day model not found — run npm run train:nextday');
}

/* ── the model, walked in plain JS ───────────────────────────────────────── */
function leaf(tree, x) {
  let i = 0;
  while (tree.l[i] !== -1) i = x[tree.f[i]] <= tree.t[i] ? tree.l[i] : tree.r[i];
  return tree.v[i];
}

/* sklearn's gradient boosting: init + learning_rate × sum of leaf values. */
function predictLog(x) {
  let sum = MODEL.init;
  for (const tree of MODEL.trees) sum += MODEL.learning_rate * leaf(tree, x);
  return sum;
}

/* Same transforms train_nextday.py applies, in the same order. */
function wxVec(w) {
  const out = [];
  for (const k of MODEL.wx_keys) {
    const v = w[k];
    if (v === null || v === undefined || Number.isNaN(v)) return null;
    if (k === 'wind_direction_10m_dominant') out.push(Math.sin(v * Math.PI / 180), Math.cos(v * Math.PI / 180));
    else if (k === 'precipitation_sum') out.push(Math.log1p(v));
    else if (k.startsWith('blh')) out.push(Math.log(Math.max(v, 20)));
    else out.push(v);
  }
  return out;
}

function climatologyFor(date) {
  const key = `${date.getMonth() + 1}_${date.getDate()}`;
  const c = MODEL.climatology[key];
  if (c) return c;
  return MODEL.climatology[`${date.getMonth() + 1}_28`] || null;   // 29 Feb
}

/* ── weather: today's and tomorrow's, the same shape the trainer saw ─────── */
async function fetchWeatherOnce() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${LAT}&longitude=${LON}`
    + '&daily=temperature_2m_mean,temperature_2m_min,relative_humidity_2m_mean,'
    + 'wind_speed_10m_max,wind_speed_10m_mean,wind_direction_10m_dominant,'
    + 'precipitation_sum,shortwave_radiation_sum'
    + '&hourly=boundary_layer_height,wind_speed_10m'
    + '&past_days=1&forecast_days=3&timezone=Asia%2FKolkata';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    let r;
    try { r = await fetch(url, { signal: ctrl.signal }); }
    catch (e) {
      throw new Error(e.name === 'AbortError' ? 'the weather forecast timed out'
        : `could not reach Open-Meteo${e.cause && e.cause.code ? ` (${e.cause.code})` : ''}`);
    }
    const j = await r.json().catch(() => ({}));
    // Open-Meteo explains a refusal in `reason` (for example a rate limit): keep it.
    if (!j.daily || !j.hourly)
      throw new Error(`Open-Meteo returned no forecast (HTTP ${r.status}${j.reason ? `: ${j.reason}` : ''})`);

    // hourly → the daily mixing-height and calm-hour figures the model expects
    const hours = {};
    j.hourly.time.forEach((t, i) => {
      const day = t.slice(0, 10), hour = +t.slice(11, 13);
      const blh = j.hourly.boundary_layer_height[i], wind = j.hourly.wind_speed_10m[i];
      if (!hours[day]) hours[day] = { blh: [], night: [], calm: 0, n: 0 };
      if (blh !== null) {
        hours[day].blh.push(blh);
        if (hour <= 7 || hour >= 21) hours[day].night.push(blh);
      }
      if (wind !== null) { hours[day].calm += wind < 5 ? 1 : 0; hours[day].n++; }
    });

    const days = {};
    j.daily.time.forEach((day, i) => {
      const h = hours[day];
      if (!h || !h.blh.length || !h.n) return;
      const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
      days[day] = {
        temperature_2m_mean: j.daily.temperature_2m_mean[i],
        temperature_2m_min: j.daily.temperature_2m_min[i],
        relative_humidity_2m_mean: j.daily.relative_humidity_2m_mean[i],
        wind_speed_10m_max: j.daily.wind_speed_10m_max[i],
        wind_speed_10m_mean: j.daily.wind_speed_10m_mean[i],
        wind_direction_10m_dominant: j.daily.wind_direction_10m_dominant[i],
        precipitation_sum: j.daily.precipitation_sum[i],
        shortwave_radiation_sum: j.daily.shortwave_radiation_sum[i],
        blh_mean: mean(h.blh), blh_min: Math.min(...h.blh),
        blh_night: h.night.length ? mean(h.night) : mean(h.blh),
        calm_frac: h.calm / h.n,
      };
    });
    return days;
  } finally { clearTimeout(timer); }
}

let wxCache = null;   // { days, fetchedAt }

async function fetchWeather() {
  if (wxCache && Date.now() - wxCache.fetchedAt < WEATHER_TTL_MS) return wxCache;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      wxCache = { days: await fetchWeatherOnce(), fetchedAt: Date.now() };
      return wxCache;
    } catch (e) {
      lastErr = e;
      console.log(`↻  Open-Meteo: ${e.message}${attempt === 1 ? ' — retrying once' : ''}`);
      if (attempt === 1) await new Promise(ok => setTimeout(ok, 2000));
    }
  }
  if (wxCache && Date.now() - wxCache.fetchedAt < WEATHER_STALE_MS) {
    console.log(`   using the forecast fetched ${Math.round((Date.now() - wxCache.fetchedAt) / 60000)} min ago`);
    return { ...wxCache, stale: true };
  }
  throw lastErr;
}

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* Plain-language reasons, read off the weather rather than the model. */
function drivers(today, tomorrow) {
  const out = [];
  const windChange = tomorrow.wind_speed_10m_max - today.wind_speed_10m_max;
  if (windChange >= 4) out.push('stronger winds tomorrow, which clear the air');
  else if (windChange <= -4) out.push('winds dropping away, so pollution sits still');
  const blhChange = (tomorrow.blh_night - today.blh_night) / Math.max(today.blh_night, 20);
  if (blhChange <= -0.2) out.push('a shallower night layer, trapping what is already there');
  else if (blhChange >= 0.2) out.push('a deeper night layer, giving smoke more room to spread');
  if (tomorrow.precipitation_sum >= 2) out.push('rain, which washes particles out');
  if (tomorrow.calm_frac >= 0.6 && today.calm_frac < 0.6) out.push('long calm spells');
  return out;
}

/* ── the answer ──────────────────────────────────────────────────────────── */
let cache = null, cacheTime = 0;

/* reading: { aqi, live } — live must be a ground-station reading. */
async function tomorrowAQI(reading) {
  if (!MODEL)
    return { available: false, reason: 'no_model',
             message: 'The next-day model has not been trained yet (npm run train:nextday).' };
  if (!reading || !reading.live || !(reading.aqi > 0))
    return { available: false, reason: 'no_station_reading',
             message: 'Tomorrow\'s forecast needs a live station reading. Set DATA_GOV_IN_KEY or WAQI_TOKEN and restart. '
                    + 'Anchored on the keyless model estimate this forecast is weaker than the seasonal average, so it is not shown.' };

  if (cache && cache.anchor === reading.aqi && Date.now() - cacheTime < CACHE_MS) return cache.value;

  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const climToday = climatologyFor(now), climTomorrow = climatologyFor(next);
  if (!climToday || !climTomorrow)
    return { available: false, reason: 'no_climatology', message: 'No seasonal baseline for these dates.' };

  let weather;
  try { weather = await fetchWeather(); }
  catch (e) {
    return { available: false, reason: 'no_weather', message: e.message };
  }
  const wToday = weather.days[iso(now)], wTomorrow = weather.days[iso(next)];
  if (!wToday || !wTomorrow)
    return { available: false, reason: 'no_weather', message: 'The weather forecast did not cover both days.' };

  const vToday = wxVec(wToday), vTomorrow = wxVec(wTomorrow);
  if (!vToday || !vTomorrow)
    return { available: false, reason: 'no_weather', message: 'The weather forecast was missing values the model needs.' };

  const doy = Math.floor((next - new Date(next.getFullYear(), 0, 0)) / 86400000);
  const x = [
    Math.log(reading.aqi), Math.log(reading.aqi / climToday),
    Math.log(climTomorrow), Math.log(climTomorrow / climToday),
    Math.sin(2 * Math.PI * doy / 365), Math.cos(2 * Math.PI * doy / 365),
    ...vToday, ...vTomorrow, ...vTomorrow.map((v, i) => v - vToday[i]),
  ];
  if (x.length !== MODEL.features.length)
    return { available: false, reason: 'feature_mismatch',
             message: `Built ${x.length} features, the model expects ${MODEL.features.length}.` };

  const aqi = climTomorrow * Math.exp(predictLog(x));
  const spread = 1.96 * MODEL.rel_sigma;
  const value = {
    available: true,
    date: iso(next),
    aqi: Math.max(1, Math.round(aqi)),
    low: Math.max(1, Math.round(aqi * Math.exp(-spread))),
    high: Math.round(aqi * Math.exp(spread)),
    anchor: { aqi: reading.aqi, seasonal: Math.round(climToday) },
    seasonal: Math.round(climTomorrow),
    drivers: drivers(wToday, wTomorrow),
    weather: {
      windMax: wTomorrow.wind_speed_10m_max, rain: wTomorrow.precipitation_sum,
      nightMixing: Math.round(wTomorrow.blh_night), tempMin: wTomorrow.temperature_2m_min,
    },
    basis: 'tomorrow from today\'s station reading and the weather forecast',
    weatherFetched: new Date(weather.fetchedAt).toISOString(),
    weatherStale: !!weather.stale,
    accuracy: { mae: MODEL.walk_forward.mae, mape: MODEL.walk_forward.mape,
                versusRule: MODEL.walk_forward.baselines.app_rule_phi_0744.mae,
                years: MODEL.walk_forward.years },
    updated: new Date().toISOString(),
  };
  cache = { anchor: reading.aqi, value };
  cacheTime = Date.now();
  return value;
}

module.exports = { tomorrowAQI, predictLog, wxVec, MODEL };
