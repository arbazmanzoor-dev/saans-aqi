/* ═══════════════════════════════════════
   Saans AQI — app.js
   The Stitch visual system (Inter, emerald, white cards) on the web layout.
   ═══════════════════════════════════════ */

const API = '/api';
const SESSION_KEY = 'saans_session';
const THEME_KEY   = 'saans_theme';

/* Carry a session over from the pre-rename key; see the matching block in
   auth.html. Runs before the session is read so nobody is logged out by a
   rename. */
(function migrateStorage(){
  try {
    [['delhi_air_session', SESSION_KEY], ['delhi_air_users', 'saans_users']].forEach(([was, now]) => {
      const old = localStorage.getItem(was);
      if (old !== null && localStorage.getItem(now) === null) localStorage.setItem(now, old);
      if (old !== null) localStorage.removeItem(was);
    });
  } catch(e) {}
})();

const MONTHS   = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* Bands carry the health meaning. Colours live in CSS so the theme owns them;
   this table only knows thresholds, labels and which tokens to read. */
const BANDS = [
  { max:50,   label:'Good',         key:'good',     range:'0–50' },
  { max:100,  label:'Satisfactory', key:'satisf',   range:'51–100' },
  { max:200,  label:'Moderate',     key:'moderate', range:'101–200' },
  { max:300,  label:'Poor',         key:'poor',     range:'201–300' },
  { max:400,  label:'Very Poor',    key:'vpoor',    range:'301–400' },
  { max:9999, label:'Severe',       key:'severe',   range:'401+' },
];
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function band(aqi) {
  const b = BANDS.find(x => aqi <= x.max) || BANDS[BANDS.length-1];
  return { ...b, color: token('--'+b.key), bg: token('--'+b.key+'-bg'),
           line: token('--'+b.key+'-line'), ink: token('--'+b.key+'-ink') };
}
function alpha(hex, a) {
  const h = String(hex).replace('#','');
  if (!/^[0-9a-f]{6}$/i.test(h)) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
const ms = (name, size = 20) => `<span class="ms" style="font-size:${size}px">${name}</span>`;

function adviceFor(aqi) {
  if (aqi <= 50)  return 'Clear air today. Windows open, and take the long way round.';
  if (aqi <= 100) return 'A good day to be outside. Morning air is at its cleanest.';
  if (aqi <= 200) return 'Fine before nine. Keep long walks short after that, especially for children and anyone with asthma.';
  if (aqi <= 300) return 'Shorten the school run and keep windows shut by evening. A mask is worth it outdoors.';
  if (aqi <= 400) return 'Stay in today. The air is serious — a respirator if you must go out, and run a purifier indoors.';
  return 'Do not go out. This is an emergency level: seek help for any breathing trouble, chest pain or dizziness.';
}

/* The Stitch home's advisory strip: from Moderate up, one line on who should
   change what today. */
function advisoryFor(aqi) {
  if (aqi <= 100) return null;
  if (aqi <= 200) return { title:'Moderate Air Quality',
    msg:'Sensitive groups (children, elderly, asthma patients) should limit outdoor time. Others can continue normal activities.' };
  if (aqi <= 300) return { title:'Poor Air Quality',
    msg:'Everyone may feel discomfort. Wear an N95 mask outdoors and keep windows closed.' };
  if (aqi <= 400) return { title:'Very Poor Air — Stay Indoors',
    msg:'Serious risk for everyone. Keep windows and doors closed; children, elderly and pregnant women should stay indoors.' };
  return { title:'Severe — Health Emergency',
    msg:'Avoid all outdoor activity. Seek medical help for breathing trouble, chest pain or dizziness.' };
}

/* Explicit precautions return above this reading. Below it the advice line
   carries the message on its own; at and above it, people need the specifics. */
const WARN_FROM = 200;
const WARN_ICON = { mask:'masks', window:'window', people:'family_restroom',
                    purify:'air', medical:'medical_services', ban:'block' };
function healthWarnings(aqi) {
  if (aqi <= WARN_FROM) return [];
  const w = [
    { icon:'mask',   text:'Wear an N95 mask outdoors — a cloth mask will not filter this.' },
    { icon:'window', text:'Keep windows and doors closed, especially in the evening.' },
    { icon:'people', text:'Children, elderly and pregnant women should stay indoors.' },
  ];
  if (aqi > 300) w.push(
    { icon:'purify',  text:'Run an air purifier, or sit in one room with the doors shut.' },
    { icon:'medical', text:'Seek medical help for breathing trouble, chest pain or dizziness.' });
  if (aqi > 400) w.push(
    { icon:'ban', text:'No outdoor activity at all. This is a health emergency.' });
  return w;
}

const state = { page:'today', week:[], weekSel:0, live:null, anchor:null, stats:null,
                scope:'month', month:new Date().getMonth(), yearIdx:0, years:[], monthly:null,
                lang:'en' };

/* ═══ THEME ═══ */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch(e) {}
  document.getElementById('themeIcon').textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  /* Band colours changed with the theme — anything already drawn must redraw. */
  if (state.live || state.week.length) renderToday();
  if (state.stats) { renderForecast(); renderPatterns(); loadDaily(); }
  if (TOMORROW) renderTomorrow();
  if (MAP.map) renderMap(false);
}

/* ═══ TODAY ═══ */
async function loadToday() {
  const [live, week] = await Promise.all([
    fetch(`${API}/realtime`).then(r => r.json()).catch(() => null),
    fetch(`${API}/week`).then(r => r.json()).catch(() => ({ days: [] })),
  ]);
  state.live = live;
  state.week = week.days || [];
  state.weekNext = week.nextDay || null;
  state.anchor = week.anchor || null;
  state.weekSel = 0;
  renderToday();
}

function renderToday() {
  const d = state.week[state.weekSel];
  /* Day 0 prefers the live reading when there is one; later days are modelled. */
  const isToday = state.weekSel === 0;
  const liveOk  = !!(state.live && !state.live.fallback && state.live.count > 0);
  const aqi = (isToday && liveOk) ? state.live.aqi : (d ? d.aqi : (state.live?.aqi ?? 0));
  const b = band(aqi);
  const kind = state.anchor?.kind;

  /* advisory strip */
  const adv = advisoryFor(aqi);
  const sos = document.getElementById('sosBanner');
  sos.classList.toggle('hidden', !adv);
  if (adv) {
    sos.style.background = b.bg; sos.style.borderColor = b.line; sos.style.borderLeftColor = b.color;
    const ic = document.getElementById('sosIc'); ic.style.background = b.line; ic.style.color = b.color;
    const t = document.getElementById('sosTitle'); t.textContent = adv.title; t.style.color = b.ink;
    const m = document.getElementById('sosMsg');   m.textContent = adv.msg;   m.style.color = b.ink;
  }

  /* the reading */
  document.getElementById('aqiTop').style.background = b.color;
  const isTest = !!(state.live && state.live.test);
  document.getElementById('readingLabel').textContent =
      isTest   ? 'Delhi AQI · TEST DATA'
    : !isToday ? 'Delhi AQI · Forecast'
    : liveOk   ? 'Delhi AQI · Live'
    : kind === 'estimate' ? 'Delhi AQI · Estimate' : 'Delhi AQI · Seasonal';
  document.getElementById('liveDot').style.background =
    isTest ? token('--moderate')
    : (isToday && liveOk) ? token('--good') : kind === 'estimate' ? token('--moderate') : token('--faint');

  const when = d ? new Date(d.year, d.month-1, d.day) : new Date();
  document.getElementById('readingPill').textContent =
    when.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });

  const dial = document.getElementById('dial');
  dial.style.background = `linear-gradient(135deg, ${b.color}, color-mix(in srgb, ${b.color} 78%, #000))`;
  dial.style.boxShadow  = `0 0 0 4px ${b.line}, 0 6px 16px ${alpha(b.color, 0.25)}`;
  document.getElementById('dialNum').textContent = aqi;
  const bn = document.getElementById('bandName'); bn.textContent = b.label; bn.style.color = b.color;
  const tag = document.getElementById('cpcbTag'); tag.style.background = b.line; tag.style.color = b.ink;
  document.getElementById('advice').textContent = adviceFor(aqi);

  /* Say exactly what the number rests on — a station reading, a calibrated
     model estimate, or the seasonal norm are three different claims. */
  const whenLong = when.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });
  document.getElementById('basis').textContent =
      isTest                 ? `${whenLong} · TEST DATA — an invented reading from SAANS_TEST_AQI, not a measurement`
    : (isToday && liveOk)    ? `${whenLong} · live from ${state.live.count} Delhi stations`
    : (d && d.source === 'nextday-model')
                             ? `${whenLong} · tomorrow from today's live reading and the weather forecast`
    : (kind === 'live')      ? `${whenLong} · forecast from today's live reading, fading to seasonal`
    : (kind === 'estimate' && isToday)
                             ? `${whenLong} · estimated from an air-quality model, calibrated to CPCB readings`
    : (kind === 'estimate')  ? `${whenLong} · forecast from today's estimate, fading to seasonal`
    :                          `${whenLong} · seasonal forecast from ten years of Delhi readings, 2015–2025`;

  /* precautions */
  const warnings = healthWarnings(aqi);
  const box = document.getElementById('warnings');
  box.classList.toggle('hidden', warnings.length === 0);
  box.innerHTML = warnings.length
    ? `<div class="warn-head" style="color:${b.ink}">What to do at ${b.label.toLowerCase()} levels</div>`
      + warnings.map(w => `<div class="warn" style="background:${b.bg};border-color:${b.line}">
          <span class="ms" style="font-size:18px;color:${b.color}">${WARN_ICON[w.icon]}</span>
          <span class="wt">${w.text}</span></div>`).join('')
    : '';

  /* where the number came from, as pills */
  const st = state.live?.stations || [];
  document.getElementById('stationRow').innerHTML = st.length
    ? st.map(s => {
        const sb = band(s.aqi);
        const name = s.station.replace('Delhi -','').replace('Delhi,','').trim();
        return `<span class="pill">${ms('location_on',14)}${name} <b style="color:${sb.color}">${s.aqi}</b></span>`;
      }).join('')
    : kind === 'estimate'
      ? `<span class="pill">${ms('satellite_alt',14)}Open-Meteo air-quality model</span>`
      : `<span class="pill">${ms('history',14)}Seasonal model · 2015–2025</span>`;

  /* scale guide, current band ringed */
  document.getElementById('scaleGrid').innerHTML = BANDS.map(x => {
    const c = token('--'+x.key);
    const now = x.key === b.key;
    const ring = now ? `;box-shadow:0 0 0 2px ${token('--card')},0 0 0 4px ${c}` : '';
    return `<div class="tile" style="background:${c}${ring}">
      <small>${x.range}</small><b>${x.label}${now ? '<em>Current</em>' : ''}</b></div>`;
  }).join('');

  /* week strip */
  document.getElementById('weekRow').innerHTML = state.week.map((day, i) => {
    const db = band(day.aqi);
    const h = Math.round(16 + (day.aqi/500)*90);
    return `<button class="daycol ${i===state.weekSel?'on':''}" data-i="${i}">
      <span class="wd">${day.weekday}</span>
      <span class="bar" style="height:${h}px;background:${db.color}"></span>
      <span class="v">${day.aqi}</span>
      ${day.source === 'nextday-model' ? '<span class="mk" title="from the weather-driven next-day model"></span>' : ''}
    </button>`;
  }).join('');

  /* The strip mixes two methods once the next-day model runs — say so. */
  const note = document.getElementById('weekNote');
  const nx = state.weekNext;
  note.classList.toggle('hidden', !(nx && nx.used));
  if (nx && nx.used)
    note.textContent = (state.anchor && state.anchor.test ? 'TEST DATA. ' : '')
      + `Tomorrow (marked) comes from the weather-driven next-day model — typically out by `
      + `about ${Math.round(nx.mae)} AQI against ${Math.round(nx.versusRule)} for the older rule. `
      + `The days after it fade from today's reading to the seasonal average.`;
  document.querySelectorAll('.daycol').forEach(btn => btn.addEventListener('click', () => {
    state.weekSel = +btn.dataset.i;
    renderToday();
  }));
}

/* ═══ ALERTS ═══ */
async function initAlerts() {
  /* The copy states the real threshold rather than a vague promise. */
  try {
    const p = await fetch(`${API}/alerts/preview?aqi=362&language=en`).then(r => r.json());
    state.alertFrom = p.alertFrom;
    document.getElementById('alertWhy').textContent =
      /* Measured on 2020–2025 daily readings: above 200 on 99% of November days,
         92% of December and January, 55% of October. */
      `Delhi's air sits above AQI ${p.alertFrom} on nearly every day from November to January, `
      + `and on about half of October's. We will text you when it crosses — in your language — `
      + `with what to actually do that day.`;
  } catch(e) {}

  document.getElementById('alertForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('alertBtn');
    const msg = document.getElementById('alertMsg');
    const phone = document.getElementById('alertPhone').value.trim();
    btn.disabled = true; btn.textContent = 'Saving…';
    const show = (kind, text) => { msg.className = 'msg show ' + kind; msg.textContent = text; };
    try {
      const r = await fetch(`${API}/alerts/subscribe`, { method:'POST',
        headers:{'Content-Type':'application/json'},
        /* Subscribe at the same threshold the copy promises, read from the server. */
        body: JSON.stringify({ phone, language: state.lang, threshold: state.alertFrom ?? 200 }) });
      const data = await r.json();
      if (!data.success) show('err', data.error);
      else {
        show('ok', data.already ? 'That number is already on the list.'
                                : 'Done. We will text you when the air turns dangerous.');
        document.getElementById('alertPhone').value = '';
      }
    } catch(err) { show('err', 'Could not reach the server just now.'); }
    btn.disabled = false; btn.textContent = 'Alert me';
  });
}

/* ═══ FORECAST ═══ */
const SCOPES = [
  { id:'month', label:'Month' }, { id:'day', label:'Day' },
  { id:'week',  label:'Week'  }, { id:'year', label:'Year' },
];

async function initForecast() {
  const now = new Date();
  state.years = [now.getFullYear(), now.getFullYear()+1, now.getFullYear()+2];
  document.getElementById('yearSeg').innerHTML = state.years
    .map((y,i) => `<button data-i="${i}">${y}</button>`).join('');
  document.getElementById('scopeSeg').innerHTML = SCOPES
    .map(s => `<button data-s="${s.id}">${s.label}</button>`).join('');
  document.querySelectorAll('#yearSeg button').forEach(b => b.addEventListener('click', () => {
    state.yearIdx = +b.dataset.i; loadForecastYear();
  }));
  document.querySelectorAll('#scopeSeg button').forEach(b => b.addEventListener('click', () => {
    state.scope = b.dataset.s; renderForecast();
  }));
  await loadForecastYear();
}

function syncSegs() {
  document.querySelectorAll('#yearSeg button').forEach(b =>
    b.classList.toggle('on', +b.dataset.i === state.yearIdx));
  document.querySelectorAll('#scopeSeg button').forEach(b =>
    b.classList.toggle('on', b.dataset.s === state.scope));
}

async function loadForecastYear() {
  const yr = state.years[state.yearIdx];
  const rows = await fetch(`${API}/ml-forecast/${yr}`).then(r => r.json()).catch(() => []);
  state.monthly = rows.map(r => r.predicted);
  state.monthlyRows = rows;            // each carries its own measured range
  renderForecast();
}

/* One scrubber, four meanings, so Day / Week / Year all keep working. */
function scrubItems() {
  const yr = state.years[state.yearIdx];
  if (state.scope === 'month')
    return MONTHS_S.map((label,i) => ({ label, value: state.monthly?.[i] ?? 0, i }));
  if (state.scope === 'year')
    return [{ label: String(yr), value: Math.round((state.monthly||[]).reduce((a,b)=>a+b,0)/12), i:0 }];
  if (state.scope === 'week')
    return Array.from({length:52}, (_,i) => ({ label: i%4===0 ? `W${i+1}` : '', value:0, i }));
  const days = new Date(yr, state.month+1, 0).getDate();
  return Array.from({length:days}, (_,i) => ({ label: (i+1)%5===0||i===0 ? String(i+1) : '', value:0, i }));
}

async function renderForecast() {
  if (!state.monthly) return;
  syncSegs();
  const yr = state.years[state.yearIdx];
  const items = scrubItems();
  if (state.scrubSel === undefined || state.scrubSel >= items.length) state.scrubSel = 0;
  if (state.scope === 'month') state.scrubSel = Math.min(state.scrubSel, 11);

  /* Day / week values come from the server so the day factors apply. */
  let value, heading, lo, hi, row = null;
  if (state.scope === 'month') {
    row = (state.monthlyRows || [])[state.scrubSel] || {};
    value = items[state.scrubSel].value;
    lo = row.ciLower; hi = row.ciUpper;
    heading = `${MONTHS[state.scrubSel]} ${yr}`;
  } else {
    const body = state.scope === 'day'  ? { type:'day', month: state.month+1, day: state.scrubSel+1, targetYear: yr }
               : state.scope === 'week' ? { type:'week', week: state.scrubSel+1, targetYear: yr }
               :                          { type:'year', targetYear: yr };
    const r = await fetch(`${API}/predict-ml`, { method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(x=>x.json());
    value = r.predicted; lo = r.ciLower; hi = r.ciUpper; row = r;
    heading = state.scope === 'day'  ? `${MONTHS[state.month]} ${state.scrubSel+1}, ${yr}`
            : state.scope === 'week' ? `Week ${state.scrubSel+1} of ${yr}`
            :                          `Annual average · ${yr}`;
  }

  const b = band(value);
  const panel = document.getElementById('fcPanel');
  panel.style.background = b.bg; panel.style.borderColor = b.line;
  document.getElementById('fcHeading').textContent = heading;
  const num = document.getElementById('fcNum'); num.textContent = value; num.style.color = b.color;
  const lbl = document.getElementById('fcBand'); lbl.textContent = b.label; lbl.style.color = b.color;

  /* The server's range: where 95% of past forecasts of this kind landed,
     measured per month (so lopsided, and wider in the monsoon). */
  if (lo == null || hi == null) { lo = value; hi = value; }
  const pct = v => Math.min(100, (v/500)*100);
  const span = document.getElementById('ciSpan');
  span.style.left = pct(lo)+'%'; span.style.width = (pct(hi)-pct(lo))+'%'; span.style.background = b.color;
  const mid = document.getElementById('ciMid');
  mid.style.left = pct(value)+'%'; mid.style.background = b.color;
  document.getElementById('ciLo').textContent = lo;
  document.getElementById('ciHi').textContent = hi;

  /* outlined bars, as on the Stitch analytics screen */
  const peak = Math.max(...items.map(x => x.value), 1);
  document.getElementById('scrubRow').innerHTML = items.map((it,i) => {
    const v = it.value || 0;
    const h = v ? Math.round(12 + (v/peak)*108) : 18;
    const sb = v ? band(v) : null;
    const style = sb ? `height:${h}px;border-color:${sb.color};background:${sb.line}`
                     : `height:${h}px;border-color:${token('--line-strong')};background:${token('--field')}`;
    return `<button class="scrub-col ${i===state.scrubSel?'on':''}" data-i="${i}" aria-label="${it.label||i+1}">
      <span class="bar" style="${style}"></span></button>`;
  }).join('');
  document.getElementById('scrubLabels').innerHTML = items
    .map((it,i) => `<span class="${i===state.scrubSel?'on':''}">${it.label}</span>`).join('');
  document.querySelectorAll('.scrub-col').forEach(btn => btn.addEventListener('click', () => {
    state.scrubSel = +btn.dataset.i; renderForecast();
  }));

  document.getElementById('scrubHint').textContent = {
    month:'Tap a month to read it. Bars are the modelled monthly mean.',
    day:`Tap a day in ${MONTHS[state.month]}. Bars show the month, not the day.`,
    week:'Tap a week of the year.',
    year:'The mean of all twelve modelled months.',
  }[state.scope];

  const about = (state.scope === 'month' && state.scrubSel === 10)
    ? 'November is the worst month of the Delhi year, every year on record here — roughly four times August.'
    : 'Modelled from the seasonal shape of the last five complete years, held against a flat level trend.';
  const ytd = row && row.yearSoFar;
  const ytdNote = ytd
    ? ` Adjusted ${ytd.adjustmentPct >= 0 ? '+' : ''}${ytd.adjustmentPct}% for how ${yr} has run so far `
      + `(January–${MONTHS[ytd.throughMonth - 1]} measured).`
    : '';
  const rangeNote = (row && row.source === 'observed')
    ? ' This month has already been measured.'
    : ' The range is where 95% of past forecasts like this one landed.';
  document.getElementById('fcNote').textContent = about + ytdNote + rangeNote;

  renderYearGrid();
}

/* The Stitch "Full Year Outlook" tiles — tapping one reads that month. */
function renderYearGrid() {
  const yr = state.years[state.yearIdx];
  document.getElementById('yearGridTitle').textContent = `Full Year Outlook · ${yr}`;
  document.getElementById('yearGrid').innerHTML = (state.monthly || []).map((v, i) => {
    const b = band(v);
    const on = state.scope === 'month' && state.scrubSel === i;
    return `<button class="mtile ${on?'on':''}" data-i="${i}"
        style="background:${b.bg};border-color:${b.line};color:${b.ink}">
      <small>${MONTHS_S[i]}</small><b class="num">${v}</b><i>${b.label}</i></button>`;
  }).join('');
  document.querySelectorAll('.mtile').forEach(t => t.addEventListener('click', () => {
    state.scope = 'month'; state.scrubSel = +t.dataset.i; renderForecast();
  }));
}

/* ═══ ASK ═══ */
const LANGS = [
  { id:'en', label:'English', font:"'Inter',sans-serif" },
  { id:'hi', label:'हिंदी',    font:"'Noto Sans Devanagari',sans-serif" },
  { id:'pa', label:'ਪੰਜਾਬੀ',   font:"'Noto Sans Gurmukhi',sans-serif" },
  { id:'ur', label:'اردو',    font:"'Noto Naskh Arabic',serif" },
];
const OPENERS = {
  en:'Hello! I’m Saans, your Delhi air quality assistant. Ask me anything — I’ll answer in whichever language you write in.',
  hi:'दिल्ली की हवा के बारे में कुछ भी पूछिए — आप जिस भाषा में लिखेंगे, मैं उसी में जवाब दूँगा।',
  pa:'ਦਿੱਲੀ ਦੀ ਹਵਾ ਬਾਰੇ ਕੁਝ ਵੀ ਪੁੱਛੋ — ਜਿਸ ਭਾਸ਼ਾ ਵਿੱਚ ਤੁਸੀਂ ਲਿਖੋਗੇ, ਮੈਂ ਉਸੇ ਵਿੱਚ ਜਵਾਬ ਦਿਆਂਗਾ।',
  ur:'دہلی کی ہوا کے بارے میں کچھ بھی پوچھیں — آپ جس زبان میں لکھیں گے، میں اسی میں جواب دوں گا۔',
};
const SUGGESTIONS = ['When is the air worst?','Is it safe for my child?','Best time to run?'];

function initAsk() {
  document.getElementById('langSeg').innerHTML = LANGS.map(l =>
    `<button class="lang ${l.id===state.lang?'on':''}" data-l="${l.id}" style="font-family:${l.font}">${l.label}</button>`
  ).join('');
  document.querySelectorAll('#langSeg button').forEach(b => b.addEventListener('click', () => {
    state.lang = b.dataset.l;
    document.querySelectorAll('#langSeg button').forEach(x => x.classList.toggle('on', x===b));
    resetThread();
  }));
  document.getElementById('sugRow').innerHTML = SUGGESTIONS
    .map(s => `<button class="sug">${s}</button>`).join('');
  document.querySelectorAll('.sug').forEach(btn => btn.addEventListener('click', () => {
    document.getElementById('chatInput').value = btn.textContent;
    sendChat();
  }));
  document.getElementById('chatSend').addEventListener('click', sendChat);
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
  });
  resetThread();
}

function resetThread() {
  document.getElementById('msgs').innerHTML = '';
  addMsg('ai', OPENERS[state.lang]);
}

/* Text goes in as text, never as HTML — replies and questions are untrusted. */
function addMsg(role, text, id) {
  const box = document.getElementById('msgs');
  const row = document.createElement('div');
  row.className = 'row ' + (role === 'you' ? 'you' : 'ai');
  if (id) row.id = id;
  row.innerHTML = `<div class="av">${ms(role === 'you' ? 'person' : 'eco', 17)}</div>`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (id === 'pending' ? ' pending' : '');
  bubble.textContent = text;
  row.appendChild(bubble);
  box.appendChild(row);
  if (state.page === 'ask') row.scrollIntoView({ block:'nearest', behavior:'smooth' });
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  addMsg('you', msg);
  addMsg('ai', 'Thinking…', 'pending');
  try {
    const r = await fetch(`${API}/chat`, { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message: msg, language: state.lang }) });
    const data = await r.json();
    document.getElementById('pending')?.remove();
    addMsg('ai', data.reply || data.error || 'Something went wrong.');
  } catch(e) {
    document.getElementById('pending')?.remove();
    addMsg('ai', 'I could not reach the assistant just now.');
  }
}

/* ═══ PATTERNS ═══ */
/* Catmull-Rom through the points, emitted as cubic beziers. */
function smooth(pts) {
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length-1; i++) {
    const p0 = pts[i-1] || pts[i], p1 = pts[i], p2 = pts[i+1], p3 = pts[i+2] || p2;
    const c1x = p1.x + (p2.x-p0.x)/6, c1y = p1.y + (p2.y-p0.y)/6;
    const c2x = p2.x - (p3.x-p1.x)/6, c2y = p2.y - (p3.y-p1.y)/6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function renderPatterns() {
  const st = state.stats;
  if (!st) return;
  const means = Array.from({length:12}, (_,i) => st.monthly[i+1].mean);
  const worst = means.indexOf(Math.max(...means)), best = means.indexOf(Math.min(...means));
  const ratio = (means[worst]/means[best]).toFixed(1);
  const allYears = [...st.trendYears, ...st.partialYears];

  document.getElementById('leadLine').innerHTML =
    `${MONTHS[worst]} is <span style="color:${band(means[worst]).color}">${ratio} times</span> ${MONTHS[best]}`;
  document.getElementById('leadSub').textContent =
    'Delhi’s year has one shape, and it repeats. The monsoon washes the air to its cleanest; the winter inversion traps it at its worst.';

  /* stat tiles */
  document.getElementById('stAvg').textContent = Math.round(st.global.mean);
  document.getElementById('stAvgSub').textContent = `${st.trendYears[0]}–${allYears[allYears.length-1]}`;
  document.getElementById('stWorst').textContent = Math.round(means[worst]);
  document.getElementById('stWorstSub').textContent = `${MONTHS[worst]} avg`;
  document.getElementById('stBest').textContent = Math.round(means[best]);
  document.getElementById('stBestSub').textContent = `${MONTHS[best]} avg`;
  document.getElementById('stMax').textContent = st.maxAqi;
  document.getElementById('stMaxSub').textContent = st.maxAqi >= 500
    ? `top of the scale · ${st.daysAtMax} days` : `of ${st.totalRecords.toLocaleString()} readings`;

  /* monthly bars: tinted fill, band-coloured outline, 0–400 scale */
  const top = 400;
  document.getElementById('monthBars').innerHTML =
    [0,25,50,75,100].map(p => `<div class="grid-line" style="bottom:${p}%"></div>`).join('')
    + means.map((v,i) => {
        const b = band(v);
        return `<div class="mbar" title="${MONTHS[i]}: ${Math.round(v)}">
          <i style="height:${Math.min(100,(v/top)*100)}%;border-color:${b.color};background:${b.line}"></i></div>`;
      }).join('');
  document.getElementById('monthAxis').innerHTML = MONTHS_S.map((m,i) =>
    `<span style="${i===worst||i===best ? 'color:var(--ink);font-weight:700' : ''}">${m}</span>`).join('');

  /* year on year */
  const complete = st.trendYears, partial = st.partialYears;
  const vals = complete.map(y => st.yearlyMeans[y]);
  const future = [];
  for (let y = complete[complete.length-1]; y <= complete[complete.length-1]+6; y++)
    if (st.levelProjection[y] != null) future.push({ y, v: st.levelProjection[y] });
  const allV = vals.concat(future.map(f=>f.v), partial.map(p=>st.yearlyMeans[p]));
  const lo = Math.min(...allV)-8, hi = Math.max(...allV)+8;
  const TW = 342, TH = 100;
  const firstY = complete[0], lastY = future.length ? future[future.length-1].y : complete[complete.length-1];
  const tx = y => ((y-firstY)/(lastY-firstY))*(TW-20)+10;
  const ty = v => TH - ((v-lo)/(hi-lo))*(TH-20);
  const green = token('--emerald'), amber = token('--moderate'), grey = token('--muted');

  let t = `<line x1="0" y1="${TH}" x2="${TW}" y2="${TH}" stroke="${token('--line')}" stroke-width="1"/>`;
  t += `<path d="${smooth(complete.map((y,i)=>({x:tx(y),y:ty(vals[i])})))}" fill="none"
        stroke="${green}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (future.length > 1)
    t += `<path d="M ${tx(future[0].y).toFixed(1)} ${ty(future[0].v).toFixed(1)} L ${tx(future[future.length-1].y).toFixed(1)} ${ty(future[future.length-1].v).toFixed(1)}"
          fill="none" stroke="${amber}" stroke-width="1.8" stroke-dasharray="4 4"/>`;
  /* Years from the second source are hollow: same Delhi, different AQI calculation. */
  const early = st.sources && st.sources.early;
  complete.forEach((y,i) => {
    t += early && y <= early.to
      ? `<circle cx="${tx(y).toFixed(1)}" cy="${ty(vals[i]).toFixed(1)}" r="3" fill="${token('--card')}" stroke="${green}" stroke-width="1.6"/>`
      : `<circle cx="${tx(y).toFixed(1)}" cy="${ty(vals[i]).toFixed(1)}" r="3.2" fill="${green}"/>`;
  });
  document.getElementById('earlyLegend').classList.toggle('hidden', !early);
  document.getElementById('earlyLegendText').textContent = early ? `${early.from}–${early.to} · other source` : '';
  document.getElementById('actualLegend').textContent = early ? `${st.sources.cpcb.from}–${complete[complete.length-1]} · CPCB` : 'Actual';
  partial.forEach(y => {
    const x = tx(y), yy = ty(st.yearlyMeans[y]);
    t += `<path d="M ${(x-5).toFixed(1)} ${(yy+4).toFixed(1)} L ${x.toFixed(1)} ${(yy-5).toFixed(1)} L ${(x+5).toFixed(1)} ${(yy+4).toFixed(1)} Z"
          fill="none" stroke="${grey}" stroke-width="1.5"/>`;
  });
  document.getElementById('trendChart').innerHTML = t;
  const marks = [];
  for (let y = firstY; y <= lastY; y += 2) marks.push(y);
  document.getElementById('trendAxis').innerHTML = marks.map(y => `<span>${y}</span>`).join('');

  const lm = st.levelModel;
  document.getElementById('trendSub').textContent =
    `Level trend ${lm.slope>=0?'+':''}${lm.slope.toFixed(1)} AQI a year (${lm.method}, ${lm.yearsUsed[0]}–${lm.anchorYear}), damped for years ahead.`;

  const monthsCovered = y => {
    const row = st.yearMonthMatrix[y] || {};
    const got = Object.keys(row).filter(m => row[m] !== null).map(Number);
    return got.length ? `${MONTHS_S[got[0]-1]}–${MONTHS_S[got[got.length-1]-1]}` : '';
  };
  document.getElementById('partialLegend').classList.toggle('hidden', !partial.length);
  document.getElementById('trendFoot').textContent = partial.length
    ? `${partial.join(', ')} (${monthsCovered(partial[0])} only)` : '';
  const src = st.sources || {};
  document.getElementById('prov').textContent = src.early
    ? `${st.totalRecords.toLocaleString()} daily readings. ${src.early.from}–${src.early.to}: ${src.early.label} — `
      + `it calculates AQI itself and reads about 10 higher than CPCB`
      + (src.early.capped ? `; ${src.early.capped} days above 500 are shown as 500` : '') + '. '
      + `${src.cpcb.from}–${src.cpcb.to}: ${src.cpcb.label}. Forecasts use the CPCB years.`
    : `${st.totalRecords.toLocaleString()} daily readings · ${firstY}–${allYears[allYears.length-1]}`;
}

async function initPatterns() {
  const yrs = Object.keys(state.stats.yearlyMeans);
  document.getElementById('ddYear').innerHTML = yrs.map(y => `<option>${y}</option>`).join('');
  document.getElementById('ddMonth').innerHTML = MONTHS
    .map((m,i) => `<option value="${i+1}">${m}</option>`).join('');
  /* Open on the last complete year: the newest year can be partial (2025
     stops in March), and a November with no readings draws an empty chart. */
  const complete = state.stats.trendYears;
  document.getElementById('ddYear').value = String(complete[complete.length-1] ?? yrs[yrs.length-1]);
  document.getElementById('ddMonth').value = '11';
  ['ddYear','ddMonth'].forEach(id =>
    document.getElementById(id).addEventListener('change', loadDaily));
  renderPatterns();
  loadDaily();
}

async function loadDaily() {
  const yr = document.getElementById('ddYear').value;
  const mo = document.getElementById('ddMonth').value;
  if (!yr || !mo) return;
  const rows = await fetch(`${API}/daily/${yr}/${mo}`).then(r => r.json()).catch(() => []);
  const early = state.stats && state.stats.sources && state.stats.sources.early;
  document.getElementById('dailyNote').textContent = early && +yr <= early.to
    ? 'From the city_day table, not the CPCB workbooks: reads about 10 higher, and days above 500 are shown as 500.' : '';
  const svg = document.getElementById('dailyChart');
  if (!rows.length) {
    svg.innerHTML = `<text x="450" y="84" text-anchor="middle" font-family="Inter,sans-serif"
      font-size="15" fill="${token('--muted')}">No readings for ${MONTHS[mo-1]} ${yr} in the source data.</text>`;
    document.getElementById('dailyAxis').innerHTML = '';
    return;
  }
  const W = 900, H = 144, maxV = Math.max(...rows.map(r=>r.aqi))*1.1;
  const pts = rows.map((r,i) => ({ x:(i/(rows.length-1))*(W-16)+8, y:H-(r.aqi/maxV)*(H-16) }));
  const line = smooth(pts);
  const c = band(rows.reduce((s,r)=>s+r.aqi,0)/rows.length).color;
  svg.innerHTML = `<path d="${line} L ${pts[pts.length-1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z"
      fill="${alpha(c, 0.12)}"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round"/>
    ${pts.map((p,i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="${band(rows[i].aqi).color}"/>`).join('')}`;
  document.getElementById('dailyAxis').innerHTML =
    [1, Math.ceil(rows.length/2), rows.length].map(d => `<span>${d}</span>`).join('');
}

/* Tomorrow: only when the server has a real station reading to work from.
   Without one the endpoint declines, and this card stays hidden rather than
   showing a number that looks more certain than it is. */
let TOMORROW = null;

async function loadTomorrow() {
  TOMORROW = await fetch(`${API}/tomorrow`).then(r => r.json()).catch(() => ({ available: false }));
  renderTomorrow();
}

function renderTomorrow() {
  const card = document.getElementById('tomorrowCard');
  const t = TOMORROW;
  if (!t || !t.available) { card.classList.add('hidden'); return; }

  const b = band(t.aqi);
  const d = new Date(t.date + 'T00:00:00');
  document.getElementById('tmrDate').textContent =
    d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const dial = document.getElementById('tmrDial');
  dial.style.background = `linear-gradient(135deg, ${b.color}, color-mix(in srgb, ${b.color} 78%, #000))`;
  dial.style.boxShadow = `0 0 0 4px ${b.line}, 0 6px 16px ${alpha(b.color, .25)}`;
  document.getElementById('tmrNum').textContent = t.aqi;
  document.getElementById('tmrBand').textContent = b.label;
  document.getElementById('tmrBand').style.color = b.color;
  document.getElementById('tmrRange').textContent = `likely ${t.low}–${t.high}`;

  const change = (t.aqi - t.anchor.aqi) / t.anchor.aqi;
  const verdict = change >= 0.12 ? 'Worse than today'
                : change <= -0.12 ? 'Better than today'
                : 'Much like today';
  document.getElementById('tmrWhy').textContent =
    t.drivers.length ? `${verdict} — ${t.drivers.join(', and ')}.` : `${verdict}.`;
  document.getElementById('tmrBasis').textContent =
    (t.test ? 'TEST DATA — built on an invented reading. ' : '')
    + `From today's reading of ${t.anchor.aqi} and tomorrow's weather`
    + (t.weatherCredit ? ` (${t.weatherCredit.replace(/^Weather: /, '')})` : '') + '. '
    + `Typically out by about ${Math.round(t.accuracy.mae)} AQI, tested on ${t.accuracy.years}.`;
  card.classList.remove('hidden');
}

/* ═══ WARD MAP ═══ */
const LEAFLET = '/vendor/leaflet/leaflet.js';   // served by our own server, not a CDN
const MAP = { ready: null, map: null, wardLayer: null, stationLayer: null, data: null, geo: null, sel: null };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function loadScript(src) {
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok;
    s.onerror = () => no(new Error('The map library could not load.'));
    document.head.appendChild(s);
  });
}

/* Built on first visit: Leaflet needs a visible container to measure. */
function initMap() {
  if (MAP.ready) return MAP.ready;
  MAP.ready = (async () => {
    const [data, geo] = await Promise.all([
      fetch(`${API}/wards`).then(r => r.json())
        .catch(() => ({ available: false, reason: 'network', message: 'Could not reach the server.' })),
      fetch(`${API}/wards/boundaries`).then(r => (r.ok ? r.json() : null)).catch(() => null),
      window.L ? null : loadScript(LEAFLET),
    ]);
    MAP.data = data;
    MAP.geo = geo;
    MAP.map = L.map('wardMap', { zoomSnap: 0.25, scrollWheelZoom: false }).setView([28.64, 77.12], 10.25);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(MAP.map);
    if (data.available) MAP.sel = data.wards.reduce((a, b) => (b.aqi > a.aqi ? b : a)).id;
    renderMap(true);
  })();
  MAP.ready.catch(e => {
    MAP.ready = null;
    document.getElementById('mapStatus').textContent = e.message;
  });
  return MAP.ready;
}

/* Leaflet caches its container size. A map built while the page is hidden
   (a background tab, say) measures zero and would fit Delhi at street level,
   so re-measure first and put the fit off until there is something to fit. */
function fitDelhi() {
  if (!MAP.map || !MAP.wardLayer) return;
  MAP.map.invalidateSize();
  const size = MAP.map.getSize();
  if (!size.x || !size.y) { MAP.pendingFit = true; return; }
  MAP.pendingFit = false;
  MAP.map.fitBounds(MAP.wardLayer.getBounds(), { padding: [12, 12] });
}

function selectWard(id) {
  MAP.sel = id;
  renderMap(false);
}

function renderMap(fit) {
  if (!MAP.map) return;
  const d = MAP.data;
  const byId = d.available ? new Map(d.wards.map(w => [w.id, w])) : new Map();

  document.getElementById('mapStatus').textContent = d.available
    ? (d.test ? 'TEST DATA — invented readings at real station sites, not measurements. ' : '')
      + `${d.stations.length} ${d.test ? 'test' : 'CPCB'} stations, updated ${new Date(d.updated).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}. `
      + 'Each area — two or three wards — is estimated from its four nearest stations. Tap one to see how close they are.'
    : (d.message || 'Ward-wise AQI is unavailable right now.');

  if (MAP.wardLayer) MAP.wardLayer.remove();
  if (MAP.stationLayer) MAP.stationLayer.remove();
  MAP.wardLayer = MAP.stationLayer = null;

  if (MAP.geo) {
    MAP.wardLayer = L.geoJSON(MAP.geo, {
      style: f => {
        const w = byId.get(f.properties.saans_id), on = f.properties.saans_id === MAP.sel;
        return { color: on ? token('--ink') : '#FFFFFF', weight: on ? 2.5 : 0.8,
                 fillColor: w ? band(w.aqi).color : token('--faint'), fillOpacity: w ? 0.55 : 0.15 };
      },
      onEachFeature: (f, layer) => {
        const w = byId.get(f.properties.saans_id);
        const inc = f.properties.saans_includes || [];
        layer.bindTooltip(`<b>${esc(f.properties.saans_name)}</b>${w ? ` · ${w.aqi}` : ''}`
          + (inc.length > 1 ? `<br><span style="opacity:.75">${inc.map(esc).join(', ')}</span>` : ''), { sticky: true });
        if (w) layer.on('click', () => selectWard(w.id));
      },
    }).addTo(MAP.map);
    if (fit) fitDelhi();
  }

  if (d.available) {
    MAP.stationLayer = L.layerGroup(d.stations.map(s =>
      L.circleMarker([s.lat, s.lon], { radius: 6, color: '#FFFFFF', weight: 2, fillColor: band(s.aqi).color, fillOpacity: 1 })
        .bindTooltip(`<b>${esc(s.name)}</b><br>AQI ${s.aqi} · ${esc(s.dominant)}`))).addTo(MAP.map);
  }

  document.getElementById('mapLegend').innerHTML = BANDS
    .map(x => `<span><i style="background:${token('--' + x.key)}"></i>${x.label}</span>`).join('')
    + (d.available ? `<span><i style="border-radius:999px;background:${token('--card')};border:2px solid ${token('--ink2')}"></i>CPCB station</span>` : '');

  const src = d.boundarySource;
  document.getElementById('mapProv').textContent = [
    d.available ? 'Stations: CPCB real-time feed via data.gov.in' : null,
    src ? `Ward boundaries: ${src.label}${src.licence ? ` (${src.licence})` : ''}` : null,
    'Map: © OpenStreetMap contributors',
  ].filter(Boolean).join(' · ');

  renderWardDetail(byId);
  renderWardRank();
}

function renderWardDetail(byId) {
  const box = document.getElementById('wardDetail');
  const d = MAP.data;
  if (!d.available) {
    box.innerHTML = `<p class="map-empty">${esc(d.message || 'No ward readings yet.')}</p>`;
    return;
  }
  const w = byId.get(MAP.sel);
  if (!w) { box.innerHTML = '<p class="map-empty">Tap an area on the map.</p>'; return; }
  const b = band(w.aqi);
  const near = w.nearestKm < 1 ? 'under a kilometre' : `${w.nearestKm} km`;
  box.innerHTML = `<div class="wd-head">
      <div class="wd-dial" style="background:${b.color}">${w.aqi}</div>
      <div style="min-width:0">
        <div class="wd-name">${esc(w.name)}</div>
        <div class="wd-meta"><b style="color:${b.color}">${b.label}</b> · estimate</div>
      </div>
    </div>
    <p class="wd-note">${adviceFor(w.aqi)}</p>
    ${w.includes && w.includes.length > 1 ? `<p class="wd-note"><b>Wards:</b> ${w.includes.map(esc).join(', ')}</p>` : ''}
    <p class="wd-note" style="color:var(--muted)">Interpolated from ${w.from.map(esc).join(', ')}. The nearest is ${near} away${
      w.nearestKm > 5 ? ' — no station close by, so treat this ward as rough' : ''}.</p>`;
}

function renderWardRank() {
  const box = document.getElementById('wardRank');
  const d = MAP.data;
  if (!d.available) { box.innerHTML = '<p class="map-empty">Appears once station readings are coming in.</p>'; return; }
  const top = [...d.wards].sort((a, b) => b.aqi - a.aqi).slice(0, 6);
  box.innerHTML = top.map((w, i) => `<button class="rank-row" data-id="${esc(w.id)}">
      <span class="rk">${i + 1}</span><span class="nm">${esc(w.name)}</span>
      <b style="color:${band(w.aqi).color}">${w.aqi}</b></button>`).join('');
  box.querySelectorAll('.rank-row').forEach(btn => btn.addEventListener('click', () => {
    selectWard(btn.dataset.id);
    const layer = MAP.wardLayer && MAP.wardLayer.getLayers().find(l => l.feature.properties.saans_id === btn.dataset.id);
    if (layer) MAP.map.fitBounds(layer.getBounds(), { maxZoom: 13, padding: [40, 40] });
  }));
}

/* ═══ NAV ═══ */
const TABS = [
  { id:'today',    label:'Today' },
  { id:'map',      label:'Ward Map' },
  { id:'forecast', label:'Forecast' },
  { id:'ask',      label:'AI Chat' },
  { id:'patterns', label:'Analytics' },
];
function initTabs() {
  document.getElementById('nav').innerHTML = TABS.map(t =>
    `<button class="navlink ${t.id===state.page?'on':''}" data-p="${t.id}">${t.label}</button>`).join('');
  document.querySelectorAll('.navlink').forEach(btn => btn.addEventListener('click', () => {
    state.page = btn.dataset.p;
    document.querySelectorAll('.navlink').forEach(b => b.classList.toggle('on', b===btn));
    document.querySelectorAll('.page').forEach(p =>
      p.classList.toggle('active', p.id === 'page-'+state.page));
    window.scrollTo(0, 0);
    if (state.page === 'map') initMap().then(() => {
      if (!MAP.map) return;
      if (MAP.pendingFit) fitDelhi(); else MAP.map.invalidateSize();
    }).catch(() => {});
  }));
}

/* ═══ BOOT ═══ */
document.addEventListener('DOMContentLoaded', async () => {
  let session;
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!session?.loggedIn) { location.href = 'auth.html'; return; }
  } catch(e) { location.href = 'auth.html'; return; }

  document.getElementById('userBtn').textContent = (session.name || 'U').charAt(0).toUpperCase();
  document.getElementById('menuName').textContent  = session.name || 'User';
  document.getElementById('menuEmail').textContent = session.email || '';
  document.getElementById('userBtn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('userMenu').classList.toggle('open');
  });
  document.addEventListener('click', () => document.getElementById('userMenu').classList.remove('open'));
  document.getElementById('signOutBtn').addEventListener('click', () => {
    localStorage.removeItem(SESSION_KEY);
    location.href = 'auth.html';
  });

  let saved = 'light';
  try { saved = localStorage.getItem(THEME_KEY) ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch(e) {}
  applyTheme(saved);
  document.getElementById('themeBtn').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  initTabs();
  initAsk();
  initAlerts();
  await loadToday();
  loadTomorrow();
  state.stats = await fetch(`${API}/stats`).then(r => r.json());
  await initForecast();
  await initPatterns();
});
