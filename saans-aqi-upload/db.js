'use strict';
/* ═══════════════════════════════════════════════════════════
   Saans AQI — where the data lives

   Two backends behind one small async interface:

   · Postgres, when DATABASE_URL is set. This is what production needs. A free
     Render web service has an ephemeral filesystem — Render's own words are
     that local changes are lost "every time the service redeploys, restarts,
     or spins down", and it spins down after 15 idle minutes. A SQLite file
     there is not storage, it is a cache that empties several times a day, and
     it was quietly losing alert subscribers long before it lost any readings.
   · SQLite (node:sqlite), when it is not. Keeps local work dependency-free and
     needs no account to run the project.

   SQL is written once with `?` placeholders and translated for Postgres, which
   is a small price for not maintaining two copies of every statement. The
   schema differs only where it must: SERIAL against AUTOINCREMENT.
   ═══════════════════════════════════════════════════════════ */
const path = require('path');
const fs   = require('fs');

const URL = process.env.DATABASE_URL || '';
const KIND = URL ? 'postgres' : 'sqlite';

let pool = null, sqlite = null;

if (KIND === 'postgres') {
  const { Pool } = require('pg');
  /* Neon and most hosted Postgres require TLS; honour an explicit sslmode in
     the URL and default to on, because a plaintext database connection across
     the internet is not a default anyone should inherit by accident. */
  const explicit = /[?&]sslmode=/.test(URL);
  pool = new Pool({
    connectionString: URL,
    ...(explicit ? {} : { ssl: { rejectUnauthorized: true } }),
    max: 3,                       // a small free instance, not a fleet
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', e => console.error(`⚠️  database pool: ${e.message}`));
} else {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SAANS_DB || path.join(__dirname, 'data', 'saans.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;');
}

/* ?, ?, ? → $1, $2, $3 — positionally, left to right. */
const toPg = sql => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };

async function run(sql, params = []) {
  if (pool) { await pool.query(toPg(sql), params); return; }
  sqlite.prepare(sql).run(...params);
}

async function get(sql, params = []) {
  if (pool) return (await pool.query(toPg(sql), params)).rows[0] || null;
  return sqlite.prepare(sql).get(...params) || null;
}

async function all(sql, params = []) {
  if (pool) return (await pool.query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}

async function exec(pgSql, sqliteSql) {
  if (pool) { await pool.query(pgSql); return; }
  sqlite.exec(sqliteSql);
}

/* Postgres returns COUNT(*) as a bigint, which the driver hands back as a
   string so it cannot silently lose precision. Nothing here is near that
   large, so coerce — but coerce deliberately rather than letting "3" + 1 = 31
   happen somewhere downstream. */
const num = v => (v === null || v === undefined ? 0 : Number(v));

/* A unique-constraint violation is an expected answer ("already subscribed"),
   not a failure, and the two backends say so differently. */
const isDuplicate = e =>
  e && (e.code === '23505' || String(e.message).toUpperCase().includes('UNIQUE'));

async function close() {
  if (pool) await pool.end();
}

module.exports = { KIND, run, get, all, exec, num, isDuplicate, close };
