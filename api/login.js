// GET  /api/login  -> { api:true, db:<bool> }   (lets the app know sync is available)
// POST /api/login  { user, pass }                              -> sign in
//                  { user, pass, register:true, name, code }   -> create an account with the invite code
//                  { action:'setpass', old, pass } + Bearer     -> change password
// The four original players sign in the first time with their old password (= username) and must then choose a new one.
const L = require('./_lib');

async function profileName(sql, user, fallback) {
  const prof = await sql`select display from gs_profiles where username = ${user}`;
  if (prof.length) return prof[0].display;
  const display = fallback || user;
  await sql`insert into gs_profiles (username, display) values (${user}, ${display}) on conflict (username) do nothing`;
  return display;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    if (!L.hasDb()) return res.status(200).json({ api: true, db: false, signup: true, vars: L.dbVarNames() });
    /* The course database stays on the server. The app downloads only the courses a player needs (?codes=), finds the rest by search (?q=)
       or by closeness to a course (?near=). ?all=1 is the whole list, for the admin's course panel only. */
    const Q = req.query || {}, pd = r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
    const light = r => { const d = pd(r) || {}; return { code: r.code, name: d.name, loc: d.loc || {}, empty: d.empty ? true : undefined }; };
    const ACC_FROM = 'áàâãäéèêëíìîïóòôõöúùûüñç', ACC_TO = 'aaaaaeeeeiiiiooooouuuunc';
    const plain = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[%_\\]/g, ' ').trim();
    let courses = {}, results;
    /* Course data is for signed-in players only, a limited amount per account per day (it is licensed data: no anonymous or bulk reading). */
    const wants = Q.codes || Q.q || Q.near || Q.all, who = wants ? L.auth(req) : null, DAY_LIMIT = 1500;
    if (wants && !who) return res.status(401).json({ error: 'auth' });
    if (Q.all && who !== L.ADMIN) return res.status(403).json({ error: 'admin' });
    try {
      await L.init(); const sql = L.db();
      if (wants && who !== L.ADMIN) {
        if (!(await L.alive(sql, who))) return res.status(401).json({ error: 'auth' });
        const day = new Date().toISOString().slice(0, 10), cost = Q.codes ? Math.max(1, String(Q.codes).split(',').length) : 3;
        const u = await sql`insert into gs_usage (username, day, n) values (${who}, ${day}, ${cost}) on conflict (username, day) do update set n = gs_usage.n + ${cost} returning n`;
        if (u.length && u[0].n > DAY_LIMIT) return res.status(429).json({ error: 'daily-limit' });
      }
      if (Q.codes) {
        const list = String(Q.codes).split(',').map(x => x.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).slice(0, 120);
        if (list.length) (await sql`select code, data from gs_courses where code = any(${list})`).forEach(r => { courses[r.code] = pd(r); });
      } else if (Q.q) {
        const q = plain(Q.q).slice(0, 60);
        if (q.length >= 2) { const like = '%' + q + '%', pre = q + '%';
          results = (await sql`select code, data from gs_courses
            where translate(lower(data->>'name'), ${ACC_FROM}, ${ACC_TO}) like ${like} or translate(lower(coalesce(data->'loc'->>'city','')), ${ACC_FROM}, ${ACC_TO}) like ${like}
            order by (translate(lower(data->>'name'), ${ACC_FROM}, ${ACC_TO}) like ${pre}) desc, data->>'name' limit 40`).map(light); }
        else results = [];
      } else if (Q.near) {
        const code = String(Q.near).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12), me = await sql`select data from gs_courses where code = ${code}`;
        const lo = Q.country ? { country: String(Q.country), state: String(Q.state || ''), city: String(Q.city || '') } : (me.length ? (pd(me[0]).loc || {}) : null);
        results = lo && lo.country ? (await sql`select code, data from gs_courses where data->'loc'->>'country' = ${lo.country} and coalesce(data->'loc'->>'state','') = ${lo.state || ''} and code <> ${code} and (data->>'empty') is null
            order by (coalesce(data->'loc'->>'city','') = ${lo.city || ''}) desc, data->>'name' limit 10`).map(light) : [];
      } else if (Q.all) {
        (await sql`select code, data from gs_courses`).forEach(r => { courses[r.code] = pd(r); });
      }
    } catch (e) { courses = {}; }
    return res.status(200).json({ api: true, db: true, signup: true, providers: L.providersOn(), lazy: true, courses, results });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const b = L.body(req);
    await L.init();
    const sql = L.db();

    /* ---- change password ---- */
    if (b.action === 'setpass') {
      const me = L.auth(req);
      if (!me) return res.status(401).json({ error: 'auth' });
      const np = String(b.pass || '');
      if (np.length < 6) return res.status(400).json({ error: 'short-password' });
      if (np.toLowerCase() === me) return res.status(400).json({ error: 'same-as-username' });
      const rows = await sql`select salt, hash, must_change from gs_users where username = ${me}`;
      if (!rows.length) return res.status(401).json({ error: 'auth' });
      if (!rows[0].must_change && !L.safeEq(L.hashPass(String(b.old || ''), rows[0].salt), rows[0].hash)) return res.status(401).json({ error: 'bad-old' });
      const salt = L.crypto.randomBytes(16).toString('hex');
      await sql`update gs_users set salt = ${salt}, hash = ${L.hashPass(np, salt)}, must_change = false where username = ${me}`;
      return res.status(200).json({ ok: true });
    }

    const user = String(b.user || '').trim().toLowerCase();
    const pass = String(b.pass || '');
    if (!L.validUser(user)) return res.status(b.register ? 400 : 401).json({ error: b.register ? 'bad-username' : 'bad-login' });
    const rows = await sql`select salt, hash, must_change, gone from gs_users where username = ${user}`;
    let created = false, mustChange = false, display = L.FIRST[user] || null;

    if (rows.length) {
      if (b.register) return res.status(409).json({ error: 'user-taken' });
      if (rows[0].gone) return res.status(401).json({ error: 'bad-login' });
      if (!L.safeEq(L.hashPass(pass, rows[0].salt), rows[0].hash)) return res.status(401).json({ error: 'bad-login' });
      mustChange = !!rows[0].must_change;
    } else if (L.FIRST[user] && !b.register) {
      // original player, first time on the synced site: old password (= username), then forced change
      if (pass.trim().toLowerCase() !== user) return res.status(401).json({ error: 'bad-login' });
      const salt = L.crypto.randomBytes(16).toString('hex');
      await sql`insert into gs_users (username, salt, hash, must_change) values (${user}, ${salt}, ${L.hashPass(pass, salt)}, true) on conflict (username) do nothing`;
      const again = await sql`select salt, hash, must_change from gs_users where username = ${user}`;
      if (!again.length || !L.safeEq(L.hashPass(pass, again[0].salt), again[0].hash)) return res.status(401).json({ error: 'bad-login' });
      mustChange = !!again[0].must_change; created = true;
    } else {
      if (!b.register) return res.status(401).json({ error: 'bad-login' });
      if (L.FIRST[user]) return res.status(409).json({ error: 'user-taken' });
      const inv = await sql`select v from gs_settings where k = 'invite'`;
      const want = inv.length ? String(inv[0].v || '') : '';
      if (!want || String(b.code || '').trim() !== want) return res.status(403).json({ error: 'bad-invite' });
      display = String(b.name || '').trim().replace(/\s+/g, ' ');
      if (display.length < 2 || display.length > 24 || /[<>&"']/.test(display)) return res.status(400).json({ error: 'bad-name' });
      const low = display.toLowerCase();
      const clash = await sql`select 1 as x from gs_profiles where lower(display) = ${low}`;
      if (clash.length || Object.values(L.FIRST).some(n => n.toLowerCase() === low)) return res.status(409).json({ error: 'name-taken' });
      if (pass.length < 6) return res.status(400).json({ error: 'short-password' });
      const salt = L.crypto.randomBytes(16).toString('hex');
      await sql`insert into gs_users (username, salt, hash) values (${user}, ${salt}, ${L.hashPass(pass, salt)}) on conflict (username) do nothing`;
      const again = await sql`select salt, hash from gs_users where username = ${user}`;
      if (!again.length || !L.safeEq(L.hashPass(pass, again[0].salt), again[0].hash)) return res.status(401).json({ error: 'bad-login' });
      created = true;
    }
    display = await profileName(sql, user, display);
    return res.status(200).json({ ok: true, name: display, username: user, token: L.sign(user), created, mustChange });
  } catch (e) { return L.fail(res, e); }
};
