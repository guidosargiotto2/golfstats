// Shared helpers for the Round Ledger functions (not an endpoint: files starting with "_" are not routed).
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

// Vercel/Neon may add a prefix to the variable names (e.g. STORAGE_DATABASE_URL), so look for any that fit.
function findUrl() {
  const e = process.env;
  const direct = e.DATABASE_URL || e.POSTGRES_URL || e.DATABASE_URL_UNPOOLED || e.POSTGRES_URL_NON_POOLING;
  if (direct) return direct;
  const keys = Object.keys(e).filter(k => /(DATABASE_URL|POSTGRES_URL)$/.test(k) && /^postgres(ql)?:\/\//.test(e[k] || ''));
  keys.sort((a, b) => a.length - b.length);
  if (keys.length) return e[keys[0]];
  const any = Object.keys(e).find(k => /^postgres(ql)?:\/\//.test(e[k] || '') && !/PRISMA/.test(k));
  return any ? e[any] : '';
}
const URL = findUrl();
// Names only (never values) of database-looking variables, to diagnose a missing connection.
const dbVarNames = () => Object.keys(process.env).filter(k => /(DATABASE|POSTGRES|NEON|PG(HOST|USER|DATABASE))/.test(k)).sort();
// The four original players: they claim their username on first sign-in, no invite code needed.
const LEGACY = { guido: 'Guido', manuel: 'Manuel', nicolas: 'Nicolas', diego: 'Diego' };
const ADMIN = 'guido';

let sql = null, ready = null;
function hasDb() { return !!URL; }
function db() {
  if (!URL) { const e = new Error('no-database'); e.code = 'NODB'; throw e; }
  if (!sql) sql = neon(URL);
  return sql;
}
async function init() {
  if (!ready) {
    const s = db();
    ready = (async () => {
      await s`create table if not exists gs_users (username text primary key, salt text not null, hash text not null, created timestamptz default now())`;
      await s`create table if not exists gs_rounds (username text not null, id text not null, data jsonb not null, upd bigint not null default 0, deleted boolean not null default false, primary key (username, id))`;
      await s`create table if not exists gs_profiles (username text primary key, display text not null, findable boolean not null default true, professor text, prof_status text)`;
      await s`create table if not exists gs_follows (follower text not null, followee text not null, primary key (follower, followee))`;
      await s`create table if not exists gs_settings (k text primary key, v text)`;
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

const validUser = u => /^[a-z0-9_.]{3,20}$/.test(u);

// Token = base64url("user.expiry.hmac"); the signing key is derived from the database URL, so no extra secret to configure.
const secret = () => crypto.createHash('sha256').update('gs-auth|' + URL).digest();
function sign(user) {
  const body = user + '|' + (Date.now() + 180 * 864e5);
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('hex');
  return Buffer.from(body + '|' + mac).toString('base64url');
}
function verify(token) {
  try {
    const parts = Buffer.from(String(token || ''), 'base64url').toString().split('|');
    if (parts.length !== 3) return null;
    const [user, exp, mac] = parts;
    const want = crypto.createHmac('sha256', secret()).update(user + '|' + exp).digest('hex');
    if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    if (+exp < Date.now() || !validUser(user)) return null;
    return user;
  } catch (e) { return null; }
}
function auth(req) { return verify(String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '')); }
function hashPass(pass, salt) { return crypto.scryptSync(String(pass), salt, 32).toString('hex'); }
function safeEq(a, b) { return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}
function fail(res, e) {
  if (e && e.code === 'NODB') return res.status(503).json({ error: 'no-database' });
  console.error(e);
  return res.status(500).json({ error: 'server' });
}

module.exports = { dbVarNames, LEGACY, ADMIN, hasDb, db, init, validUser, sign, verify, auth, hashPass, safeEq, body, fail, crypto };
