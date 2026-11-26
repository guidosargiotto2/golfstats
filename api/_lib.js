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
const LEGACY = { guido: 'Guido', manuel: 'Manuel', nicolas: 'Nicolas', diego: 'Diego', enrique: 'Enrique', mauricio: 'Mauricio' };
/* test accounts: first login with password = username (then forced change), but they are normal new users — trial, plans, onboarding — not founders */
const TESTERS = { test1: 'Test One', test2: 'Test Two' };
const FIRST = Object.assign({}, LEGACY, TESTERS);
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
      await s`alter table gs_users add column if not exists must_change boolean not null default false`;
      await s`alter table gs_users add column if not exists gone boolean not null default false`;
      await s`create table if not exists gs_rounds (username text not null, id text not null, data jsonb not null, upd bigint not null default 0, deleted boolean not null default false, primary key (username, id))`;
      await s`create table if not exists gs_profiles (username text primary key, display text not null, findable boolean not null default true, professor text, prof_status text)`;
      await s`alter table gs_profiles add column if not exists plan text`;
      await s`alter table gs_profiles add column if not exists about jsonb`;
      await s`alter table gs_profiles add column if not exists prefs jsonb`;
      await s`alter table gs_profiles add column if not exists prefs_upd bigint not null default 0`;
      await s`alter table gs_profiles add column if not exists avatar text`;
      await s`create table if not exists gs_follows (follower text not null, followee text not null, primary key (follower, followee))`;
      await s`create table if not exists gs_settings (k text primary key, v text)`;
      await s`create table if not exists gs_teams (code text primary key, owner text not null, seats int not null default 4, paid boolean not null default false, created timestamptz default now())`;
      await s`alter table gs_teams add column if not exists plan text not null default 'lite'`;
      await s`create table if not exists gs_team_members (username text primary key, code text not null, joined timestamptz default now())`;
      await s`create table if not exists gs_reviews (username text primary key, contact text, note text, status text not null default 'requested', recommendation text, requested timestamptz default now(), done timestamptz)`;
      await s`create table if not exists gs_bags (username text primary key, data jsonb not null, upd bigint not null default 0)`;
      await s`create table if not exists gs_keys (id text primary key, username text not null, hash text not null unique, label text, created timestamptz default now(), last_used timestamptz)`;
      await s`create table if not exists gs_tasks (id text primary key, username text not null, coach text not null, kind text not null, title text not null, detail text, due text, target jsonb, log jsonb not null default '[]', status text not null default 'open', created timestamptz default now(), upd bigint not null default 0)`;
      await s`create table if not exists gs_course_requests (id text primary key, username text not null, name text not null, city text, tees text, note text, photos jsonb, status text not null default 'requested', created timestamptz default now(), done timestamptz)`;
      await s`create table if not exists gs_course_fixes (id text primary key, code text not null, username text not null, hcp jsonb, confirms boolean not null default false, note text, photos jsonb, status text not null default 'pending', created timestamptz default now())`;
      await s`create table if not exists gs_lookups (username text not null, day text not null, n int not null default 0, primary key (username, day))`;
      await s`create table if not exists gs_courses (code text primary key, data jsonb not null, upd bigint not null default 0)`;
      await s`create table if not exists gs_history (username text primary key, rounds jsonb not null, src text, upd bigint not null default 0)`;
      await s`create table if not exists gs_identities (provider text not null, sub text not null, username text not null, email text, created timestamptz default now(), primary key (provider, sub))`;
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

// Plans: free | lite | plus | pro. The four founders default to pro; everyone else to free until a plan is set.
const planOf = (user, plan) => user === ADMIN ? 'pro' : (plan === 'free' || plan === 'lite' || plan === 'plus' || plan === 'pro') ? plan : (LEGACY[user] ? 'pro' : 'free');
// a member of a paid team gets the team's plan (Lite, Plus or Pro), if it is higher than their own
// First month: every new account is on Pro, free. It ends 30 days after the account was created, or as soon as a plan is
// set for the player (after the review meeting with Guido), whichever comes first.
const TRIAL_DAYS = 30;
async function inTrial(sql, user, plan) {
  if (plan === 'free' || plan === 'lite' || plan === 'plus' || plan === 'pro') return false;      // a plan was decided: no trial
  if (user === ADMIN || LEGACY[user]) return false;                             // founders are simply Pro
  const cu = await sql`select created from gs_users where username = ${user}`;
  if (!cu.length || !cu[0].created) return false;
  return Date.now() < new Date(cu[0].created).getTime() + TRIAL_DAYS * 864e5;
}
async function effectivePlan(sql, user, plan) {
  const p = planOf(user, plan);
  if (p === 'pro') return p;
  if (await inTrial(sql, user, plan)) return 'pro';
  const t = await sql`select t.paid, t.plan from gs_team_members m join gs_teams t on t.code = m.code where m.username = ${user}`;
  const tp = (t.length && t[0].paid) ? (t[0].plan === 'pro' ? 'pro' : (t[0].plan === 'plus' ? 'plus' : 'lite')) : 'free';
  return rank(tp) > rank(p) ? tp : p;
}
const rank = p => ({ free: 0, lite: 1, plus: 2, pro: 3 })[p] || 0;
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
// short-lived signed blobs (OAuth state)
function signBlob(obj, minutes) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, obj, { exp: Date.now() + (minutes || 10) * 6e4 }))).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret()).update('blob|' + body).digest('base64url');
}
function verifyBlob(str) {
  try {
    const [body, mac] = String(str || '').split('.');
    const want = crypto.createHmac('sha256', secret()).update('blob|' + body).digest('base64url');
    if (!mac || mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}
const PROVIDERS = {
  google: { id: () => process.env.GOOGLE_CLIENT_ID, secret: () => process.env.GOOGLE_CLIENT_SECRET,
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email profile' },
  microsoft: { id: () => process.env.MS_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID, secret: () => process.env.MS_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET,
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'openid email profile' }
};
const providersOn = () => Object.keys(PROVIDERS).filter(k => PROVIDERS[k].id() && PROVIDERS[k].secret());
// a valid token is not enough once the account was deleted
async function alive(sql, user) { const r = await sql`select gone from gs_users where username = ${user}`; return !!(r.length && !r[0].gone); }
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

module.exports = { TESTERS, FIRST, alive, effectivePlan, inTrial, TRIAL_DAYS, signBlob, verifyBlob, PROVIDERS, providersOn, planOf, rank, dbVarNames, LEGACY, ADMIN, hasDb, db, init, validUser, sign, verify, auth, hashPass, safeEq, body, fail, crypto };
