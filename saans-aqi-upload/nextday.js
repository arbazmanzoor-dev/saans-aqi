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
function predictLog(x, model = MODEL, rate = MODEL && MODEL.learning_rate) {
  let sum = model.init;
  for (const tree of model.trees) sum += rate * leaf(tree, x);
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

function climatologyFor(date, table = MODEL.climatology) {
  const key = `${date.getMonth() + 1}_${date.getDate()}`;
  const c = table[key];
  if (c) return c;
  return table[`${date.getMonth() + 1}_28`] || null;   // 29 Feb
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

/* ── MET Norway fallback ─────────────────────────────────────────────────────
   On a shared host Open-Meteo's free daily limit is usually spent by other apps
   ("HTTP 429: Daily API request limit exceeded"), so tomorrow's forecast falls
   back to MET Norway's free Locationforecast. MET has no mixing height and
   forecasts from *now*, so these models (train_nextday.py) summarise today from
   a fixed hour onward: the server uses the earliest window still fully ahead.
   Walk-forward: from 12:00 29.0, from 18:00 29.2, from 21:00 29.9 AQI mean
   error — against 27.9 for the Open-Meteo model and 31.0 for the old rule.
   MET's terms: identify the app in User-Agent, honour Expires and
   If-Modified-Since, and credit MET Norway (CC BY 4.0). */
const MET_FILE = path.join(__dirname, 'nextday_met_model.json');
let MET = null;
try {
  MET = JSON.parse(fs.readFileSync(MET_FILE, 'utf8'));
  console.log(`🌦️  MET Norway fallback loaded — today-from ${Object.keys(MET.windows).map(h => h + ':00').join(', ')}`);
} catch (e) {
  console.log('⚠️  MET Norway fallback model not found — run npm run train:nextday');
}
const MET_URL = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${LAT.toFixed(4)}&lon=${LON.toFixed(4)}`;
const MET_UA  = process.env.MET_USER_AGENT || 'saans-aqi/1.0 (+https://saans-aqi.onrender.com)';
const OPEN_METEO_PAUSE_MS = 30 * 60 * 1000;   // after a refusal, don't make every request wait on it
let metCache = null;                           // { json, expires, lastModified, fetchedAt }
let openMeteoPausedUntil = 0;

async function fetchMet() {
  if (metCache && Date.now() < metCache.expires) return metCache;
  const headers = { 'User-Agent': MET_UA };
  if (metCache && metCache.lastModified) headers['If-Modified-Since'] = metCache.lastModified;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    let r;
    try { r = await fetch(MET_URL, { headers, signal: ctrl.signal }); }
    catch (e) {
      throw new Error(e.name === 'AbortError' ? 'MET Norway timed out'
        : `could not reach MET Norway${e.cause && e.cause.code ? ` (${e.cause.code})` : ''}`);
    }
    const expires = Date.parse(r.headers.get('expires')) || Date.now() + 30 * 60 * 1000;
    if (r.status === 304 && metCache) { metCache.expires = expires; return metCache; }
    if (!r.ok) throw new Error(`MET Norway answered HTTP ${r.status}`);
    metCache = { json: await r.json(), expires, lastModified: r.headers.get('last-modified'), fetchedAt: Date.now() };
    return metCache;
  } catch (e) {
    if (metCache && Date.now() - metCache.fetchedAt < WEATHER_STALE_MS) {
      console.log(`↻  ${e.message} — using MET's forecast from ${Math.round((Date.now() - metCache.fetchedAt) / 60000)} min ago`);
      return { ...metCache, stale: true };
    }
    throw e;
  } finally { clearTimeout(timer); }
}

/* MET's hourly steps, regrouped by Indian date and hour. Times arrive in UTC. */
function metHours(json) {
  const out = {};
  for (const step of json.properties.timeseries) {
    const n1 = step.data.next_1_hours;
    if (!n1) continue;                                 // past ~60 h the steps go 6-hourly
    const ist = new Date(Date.parse(step.time) + 5.5 * 3600e3);
    const day = ist.toISOString().slice(0, 10), hour = ist.getUTCHours();
    const d = step.data.instant.details;
    (out[day] ||= {})[hour] = { t: d.air_temperature, rh: d.relative_humidity,
      w: d.wind_speed * 3.6, dir: d.wind_from_direction,               // m/s → km/h, as trained
      rain: (n1.details && n1.details.precipitation_amount) || 0 };
  }
  return out;
}

/* The same summary train_nextday.py makes from ERA5 hours h0..23. */
function metSummary(dayHours, h0) {
  const hs = [];
  for (let h = h0; h < 24; h++) { if (!dayHours || !dayHours[h]) return null; hs.push(dayHours[h]); }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const t = hs.map(x => x.t), w = hs.map(x => x.w);
  let u = 0, v = 0;
  hs.forEach(x => { u += x.w * Math.sin(x.dir * Math.PI / 180); v += x.w * Math.cos(x.dir * Math.PI / 180); });
  const n = Math.hypot(u, v) || 1;
  return { t_mean: mean(t), t_min: Math.min(...t), rh: mean(hs.map(x => x.rh)),
           w_max: Math.max(...w), w_mean: mean(w), dir_sin: u / n, dir_cos: v / n,
           rain: Math.log1p(hs.reduce((s, x) => s + x.rain, 0)),
           calm: w.filter(x => x < MET.calm_kmh).length / w.length };
}

/* Reasons, read off the same hours on both days so an evening-only "today"
   is not compared with tomorrow's whole day. */
function metDrivers(today, tomorrow) {
  const out = [];
  const windChange = tomorrow.w_max - today.w_max;
  if (windChange >= 4) out.push('stronger winds tomorrow, which clear the air');
  else if (windChange <= -4) out.push('winds dropping away, so pollution sits still');
  if (Math.expm1(tomorrow.rain) >= 2) out.push('rain, which washes particles out');
  if (tomorrow.calm >= 0.6 && today.calm < 0.6) out.push('long calm spells');
  return out;
}

/* ── the answer ──────────────────────────────────────────────────────────── */
let cache = null, cacheTime = 0;

function finish(reading, next, climToday, climTomorrow, logPred, sigma, extra) {
  const aqi = climTomorrow * Math.exp(logPred);
  const spread = 1.96 * sigma;
  return {
    available: true,
    date: iso(next),
    aqi: Math.max(1, Math.round(aqi)),
    low: Math.max(1, Math.round(aqi * Math.exp(-spread))),
    high: Math.round(aqi * Math.exp(spread)),
    anchor: { aqi: reading.aqi, seasonal: Math.round(climToday) },
    seasonal: Math.round(climTomorrow),
    updated: new Date().toISOString(),
    ...extra,
  };
}

/* Tomorrow from Open-Meteo's weather — the stronger model, when it answers. */
async function viaOpenMeteo(reading, now, next) {
  const climToday = climatologyFor(now), climTomorrow = climatologyFor(next);
  if (!climToday || !climTomorrow) throw new Error('no seasonal baseline for these dates');
  const weather = await fetchWeather();
  const wToday = weather.days[iso(now)], wTomorrow = weather.days[iso(next)];
  if (!wToday || !wTomorrow) throw new Error('the Open-Meteo forecast did not cover both days');
  const vToday = wxVec(wToday), vTomorrow = wxVec(wTomorrow);
  if (!vToday || !vTomorrow) throw new Error('the Open-Meteo forecast was missing values the model needs');
  const doy = Math.floor((next - new Date(next.getFullYear(), 0, 0)) / 86400000);
  const x = [
    Math.log(reading.aqi), Math.log(reading.aqi / climToday),
    Math.log(climTomorrow), Math.log(climTomorrow / climToday),
    Math.sin(2 * Math.PI * doy / 365), Math.cos(2 * Math.PI * doy / 365),
    ...vToday, ...vTomorrow, ...vTomorrow.map((v, i) => v - vToday[i]),
  ];
  if (x.length !== MODEL.features.length)
    throw new Error(`built ${x.length} features, the model expects ${MODEL.features.length}`);
  return finish(reading, next, climToday, climTomorrow, predictLog(x), MODEL.rel_sigma, {
    drivers: drivers(wToday, wTomorrow),
    weather: { windMax: wTomorrow.wind_speed_10m_max, rain: wTomorrow.precipitation_sum,
               nightMixing: Math.round(wTomorrow.blh_night), tempMin: wTomorrow.temperature_2m_min },
    basis: 'tomorrow from today\'s station reading and the weather forecast',
    weatherSource: 'open-meteo', weatherCredit: 'Weather: Open-Meteo',
    weatherFetched: new Date(weather.fetchedAt).toISOString(), weatherStale: !!weather.stale,
    accuracy: { mae: MODEL.walk_forward.mae, mape: MODEL.walk_forward.mape,
                versusRule: MODEL.walk_forward.baselines.app_rule_phi_0744.mae,
                years: MODEL.walk_forward.years },
  });
}

/* Tomorrow from MET Norway's weather — the fallback that works on shared hosts. */
async function viaMet(reading, now, next) {
  if (!MET) throw new Error('the MET Norway model has not been trained (npm run train:nextday)');
  const climToday = climatologyFor(now, MET.climatology), climTomorrow = climatologyFor(next, MET.climatology);
  if (!climToday || !climTomorrow) throw new Error('no seasonal baseline for these dates');
  const met = await fetchMet();
  const hours = metHours(met.json);
  const today = hours[iso(now)], tomorrow = hours[iso(next)];
  const tmr = metSummary(tomorrow, 0);
  if (!tmr) throw new Error('MET Norway\'s forecast did not cover all of tomorrow');
  const window = Object.values(MET.windows).sort((a, b) => a.today_from_hour - b.today_from_hour)
    .find(w => metSummary(today, w.today_from_hour));
  if (!window) throw new Error('too little of today is left in MET Norway\'s forecast (after 21:00)');
  const h0 = window.today_from_hour, tdy = metSummary(today, h0);
  const doy = Math.floor((next - new Date(next.getFullYear(), 0, 0)) / 86400000);
  const x = [
    Math.log(reading.aqi), Math.log(reading.aqi / climToday),
    Math.log(climTomorrow), Math.log(climTomorrow / climToday),
    Math.sin(2 * Math.PI * doy / 365), Math.cos(2 * Math.PI * doy / 365),
    ...MET.keys.map(k => tmr[k]), ...MET.keys.map(k => tdy[k]), ...MET.keys.map(k => tmr[k] - tdy[k]),
  ];
  return finish(reading, next, climToday, climTomorrow, predictLog(x, window, MET.learning_rate), window.rel_sigma, {
    drivers: metDrivers(tdy, metSummary(tomorrow, h0)),
    weather: { windMax: +tmr.w_max.toFixed(1), rain: +Math.expm1(tmr.rain).toFixed(1), tempMin: tmr.t_min },
    basis: 'tomorrow from today\'s station reading and MET Norway\'s weather forecast',
    weatherSource: 'met-norway', weatherCredit: 'Weather: MET Norway', todayFromHour: h0,
    weatherFetched: new Date(met.fetchedAt).toISOString(), weatherStale: !!met.stale,
    accuracy: { mae: window.walk_forward.mae, mape: window.walk_forward.mape,
                versusRule: window.walk_forward.rule_mae, years: window.walk_forward.years },
  });
}

/* reading: { aqi, live } — live must be a ground-station reading.
   Open-Meteo first; MET Norway if it refuses; nothing (so the app keeps its
   older rule) if both are out. NEXTDAY_WEATHER=met or =open-meteo pins one. */
async function tomorrowAQI(reading) {
  if (!MODEL && !MET)
    return { available: false, reason: 'no_model',
             message: 'The next-day model has not been trained yet (npm run train:nextday).' };
  if (!reading || !reading.live || !(reading.aqi > 0))
    return { available: false, reason: 'no_station_reading',
             message: 'Tomorrow\'s forecast needs a live station reading. Set DATA_GOV_IN_KEY or WAQI_TOKEN and restart. '
                    + 'Anchored on the keyless model estimate this forecast is weaker than the seasonal average, so it is not shown.' };

  if (cache && cache.anchor === reading.aqi && Date.now() - cacheTime < CACHE_MS) return cache.value;

  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const mode = (process.env.NEXTDAY_WEATHER || 'auto').toLowerCase();
  const problems = [];

  if (mode !== 'met' && MODEL && Date.now() >= openMeteoPausedUntil) {
    try {
      const value = await viaOpenMeteo(reading, now, next);
      cache = { anchor: reading.aqi, value }; cacheTime = Date.now();
      return value;
    } catch (e) {
      problems.push(e.message);
      openMeteoPausedUntil = Date.now() + OPEN_METEO_PAUSE_MS;
      if (mode !== 'open-meteo') console.log(`↪  Open-Meteo unavailable (${e.message}) — using MET Norway for the next 30 min`);
    }
  } else if (mode !== 'met' && MODEL) {
    problems.push('Open-Meteo paused after a recent refusal');
  }

  if (mode !== 'open-meteo') {
    try {
      const value = await viaMet(reading, now, next);
      if (problems.length) value.fallbackFrom = problems[0];
      cache = { anchor: reading.aqi, value }; cacheTime = Date.now();
      return value;
    } catch (e) { problems.push(e.message); }
  }
  return { available: false, reason: 'no_weather', message: problems.join('; ') || 'no weather source available' };
}

module.exports = { tomorrowAQI, predictLog, wxVec, metHours, metSummary, MODEL, MET };
