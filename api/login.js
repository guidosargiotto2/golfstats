// GET  /api/login  -> { api:true, db:<bool> }   (lets the app know sync is available)
// POST /api/login  { user, pass }                          -> sign in
//                  { user, pass, register:true, name, code } -> create an account with the invite code
// The four original players claim their username on first sign-in: the password typed becomes theirs.
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ api: true, db: L.hasDb(), signup: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const b = L.body(req);
    const user = String(b.user || '').trim().toLowerCase();
    const pass = String(b.pass || '');
    if (!L.validUser(user)) return res.status(b.register ? 400 : 401).json({ error: b.register ? 'bad-username' : 'bad-login' });
    await L.init();
    const sql = L.db();
    const rows = await sql`select salt, hash from gs_users where username = ${user}`;
    let created = false, display = L.LEGACY[user] || null;

    if (rows.length) {
      if (b.register) return res.status(409).json({ error: 'user-taken' });
      if (!L.safeEq(L.hashPass(pass, rows[0].salt), rows[0].hash)) return res.status(401).json({ error: 'bad-login' });
    } else {
      if (!L.LEGACY[user]) {
        if (!b.register) return res.status(401).json({ error: 'bad-login' });
        const inv = await sql`select v from gs_settings where k = 'invite'`;
        const want = inv.length ? String(inv[0].v || '') : '';
        if (!want || String(b.code || '').trim() !== want) return res.status(403).json({ error: 'bad-invite' });
        display = String(b.name || '').trim().replace(/\s+/g, ' ');
        if (display.length < 2 || display.length > 24 || /[<>&"']/.test(display)) return res.status(400).json({ error: 'bad-name' });
        const low = display.toLowerCase();
        const clash = await sql`select 1 as x from gs_profiles where lower(display) = ${low}`;
        if (clash.length || Object.values(L.LEGACY).some(n => n.toLowerCase() === low)) return res.status(409).json({ error: 'name-taken' });
      }
      if (pass.length < 6) return res.status(400).json({ error: 'short-password' });
      const salt = L.crypto.randomBytes(16).toString('hex');
      await sql`insert into gs_users (username, salt, hash) values (${user}, ${salt}, ${L.hashPass(pass, salt)}) on conflict (username) do nothing`;
      const again = await sql`select salt, hash from gs_users where username = ${user}`;
      if (!again.length || !L.safeEq(L.hashPass(pass, again[0].salt), again[0].hash)) return res.status(401).json({ error: 'bad-login' });
      created = true;
    }
    const prof = await sql`select display from gs_profiles where username = ${user}`;
    if (prof.length) display = prof[0].display;
    else {
      display = display || user;
      await sql`insert into gs_profiles (username, display) values (${user}, ${display}) on conflict (username) do nothing`;
    }
    return res.status(200).json({ ok: true, name: display, username: user, token: L.sign(user), created });
  } catch (e) { return L.fail(res, e); }
};
