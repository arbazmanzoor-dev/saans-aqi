'use strict';
/* ═══════════════════════════════════════════════════════════
   Saans AQI — public alerts
   Modelled on the Taapmaan broadcast module: dry run by default, real sends
   gated behind an operator token and live data, numbers stored only as salted
   hashes, and nothing ever recorded as sent when it was not.
   ═══════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const db     = require('./db.js');

/* The schemas differ in one word — SERIAL against AUTOINCREMENT — so they are
   written out rather than generated, where a reader can see both. */
const DDL_PG = `
CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  ts TEXT NOT NULL, phone_hash TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL, threshold INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS broadcasts (
  id SERIAL PRIMARY KEY,
  job_id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL,
  aqi INTEGER, band TEXT, language TEXT, message TEXT,
  segments INTEGER, encoding TEXT, recipients INTEGER,
  status TEXT NOT NULL, dry_run INTEGER NOT NULL, basis TEXT);`;
const DDL_SQLITE = DDL_PG.replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');

let ready = null;
function init() {
  if (!ready) ready = db.exec(DDL_PG, DDL_SQLITE);
  return ready;
}

const now = () => new Date().toISOString();

/* A number is never stored, only a salted one-way hash of it. That makes the
   subscriber list useless to an attacker — and also means delivery genuinely
   cannot be faked later, because there is no number left to send to. */
function hashPhone(msisdn) {
  const salt = process.env.SAANS_SALT || 'saans-dev-salt';
  return crypto.createHash('sha256').update(salt + String(msisdn).trim()).digest('hex');
}

/* Indian mobile numbers, with or without +91. */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
              : digits.length === 11 && digits.startsWith('0')  ? digits.slice(1)
              : digits;
  return /^[6-9]\d{9}$/.test(local) ? '+91' + local : null;
}

/* ── What a gateway actually bills ────────────────────────────────────────
   GSM-7 fits 160 characters; one character outside it — any Devanagari,
   Gurmukhi or Urdu letter — pushes the whole message to UCS-2 at 70. A Hindi
   advisory therefore costs roughly twice what the same text costs in English. */
const GSM7 = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡"
  + "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà");
const GSM7_EXT = new Set("^{}\\[~]|€");

function smsParts(msg) {
  const chars = [...msg];
  if (chars.every(c => GSM7.has(c) || GSM7_EXT.has(c))) {
    const n = chars.reduce((s,c) => s + (GSM7_EXT.has(c) ? 2 : 1), 0);
    return { encoding:'GSM-7', characters: chars.length,
             segments: n <= 160 ? 1 : Math.ceil(n/153) };
  }
  const n = Buffer.byteLength(msg, 'utf16le') / 2;
  return { encoding:'UCS-2', characters: chars.length,
           segments: n <= 70 ? 1 : Math.ceil(n/67) };
}

/* ── The advisory ─────────────────────────────────────────────────────────
   Deliberately short: every line above 70 characters costs another segment in
   the Indic languages, and an alert nobody reads to the end is not an alert. */
const BAND_NAME = {
  en: { 'Poor':'POOR', 'Very Poor':'VERY POOR', 'Severe':'SEVERE' },
  hi: { 'Poor':'खराब', 'Very Poor':'बहुत खराब', 'Severe':'गंभीर' },
  pa: { 'Poor':'ਮਾੜੀ', 'Very Poor':'ਬਹੁਤ ਮਾੜੀ', 'Severe':'ਗੰਭੀਰ' },
  ur: { 'Poor':'خراب', 'Very Poor':'بہت خراب', 'Severe':'شدید' },
};
const TEMPLATE = {
  en: (a,b) => `Delhi air ${b} today. AQI ${a}. Stay in, shut windows, N95 outdoors. Children and elderly indoors. -Saans`,
  hi: (a,b) => `आज दिल्ली की हवा ${b}। AQI ${a}। घर में रहें, खिड़कियाँ बंद रखें, बाहर N95 लगाएँ। -Saans`,
  pa: (a,b) => `ਅੱਜ ਦਿੱਲੀ ਦੀ ਹਵਾ ${b}। AQI ${a}। ਘਰ ਰਹੋ, ਖਿੜਕੀਆਂ ਬੰਦ ਰੱਖੋ, ਬਾਹਰ N95 ਪਾਓ। -Saans`,
  ur: (a,b) => `آج دہلی کی ہوا ${b}۔ AQI ${a}۔ گھر میں رہیں، کھڑکیاں بند رکھیں، باہر N95 پہنیں۔ -Saans`,
};

function compose(aqi, bandLabel, language = 'en') {
  const lang = TEMPLATE[language] ? language : 'en';
  const name = (BAND_NAME[lang] || BAND_NAME.en)[bandLabel] || bandLabel;
  const message = TEMPLATE[lang](aqi, name);
  return { language: lang, message, ...smsParts(message) };
}

/* ── When an alert is warranted ───────────────────────────────────────────
   Below Poor the app's own advice is enough; an SMS for a routine Delhi day
   is how people learn to ignore the alerts that matter. */
const ALERT_FROM = 200;
const warranted = aqi => aqi > ALERT_FROM;

/* ── Subscribers ── */
async function subscribe(msisdn, language, threshold) {
  const phone = normalisePhone(msisdn);
  if (!phone) return { ok:false, error:'That does not look like an Indian mobile number.' };
  const lang = TEMPLATE[language] ? language : 'en';
  const at = Number.isInteger(threshold) ? threshold : 300;
  try {
    await init();
    await db.run(`INSERT INTO subscribers (ts, phone_hash, language, threshold)
                  VALUES (?, ?, ?, ?)`, [now(), hashPhone(phone), lang, at]);
    return { ok:true, already:false };
  } catch (e) {
    if (db.isDuplicate(e)) return { ok:true, already:true };
    throw e;
  }
}

async function countSubscribers() {
  await init();
  return db.num((await db.get('SELECT COUNT(*) n FROM subscribers')).n);
}

/* One message carries one language, so subscribers in the others are counted,
   never quietly counted as reached. */
async function reach(language, aqi) {
  await init();
  const rows = (await db.all(
    `SELECT language, COUNT(*) n FROM subscribers WHERE threshold <= ? GROUP BY language`, [aqi]
  )).map(r => ({ language: r.language, n: db.num(r.n) }));
  const byLang = Object.fromEntries(rows.map(r => [r.language, r.n]));
  const eligible = rows.reduce((s,r) => s + r.n, 0);
  return { targeted: byLang[language] || 0, eligible, byLanguage: byLang,
           registered: await countSubscribers() };
}

async function logBroadcast(rec) {
  await init();
  await db.run(`INSERT INTO broadcasts
    (job_id, ts, aqi, band, language, message, segments, encoding, recipients, status, dry_run, basis)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    rec.job_id, rec.ts, rec.aqi, rec.band, rec.language, rec.message,
    rec.segments, rec.encoding, rec.recipients, rec.status, rec.dry_run ? 1 : 0, rec.basis]);
}
async function listBroadcasts(limit = 25) {
  await init();
  return db.all('SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?', [limit]);
}

/* Which gateway, if any, is configured. Nothing here sends — this only reports
   whether a real send could even be attempted. */
function provider() {
  if (process.env.MSG91_AUTHKEY) return 'msg91';
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return 'twilio';
  return null;
}

module.exports = { init, compose, smsParts, warranted, ALERT_FROM, subscribe, countSubscribers,
                   reach, logBroadcast, listBroadcasts, provider, normalisePhone, now };
