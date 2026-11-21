// GET  /api/login  -> { api:true, db:<bool> }   (lets the app know sync is available)
// POST /api/login  { user, pass } -> { ok, name, token, created }
// The first time a username signs in, the password typed becomes that user's password.
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ api: true, db: L.hasDb() });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const b = L.body(req);
    const user = String(b.user || '').trim().toLowerCase();
    const pass = String(b.pass || '');
    if (!L.USERS[user]) return res.status(401).json({ error: 'bad-login' });
    await L.init();
    const sql = L.db();
    const rows = await sql`select salt, hash from gs_users where username = ${user}`;
    let created = false;
    if (!rows.length) {
      if (pass.length < 6) return res.status(400).json({ error: 'short-password' });
      const salt = L.crypto.randomBytes(16).toString('hex');
      await sql`insert into gs_users (username, salt, hash) values (${user}, ${salt}, ${L.hashPass(pass, salt)}) on conflict (username) do nothing`;
      const again = await sql`select salt, hash from gs_users where username = ${user}`;
      if (!again.length || !L.safeEq(L.hashPass(pass, again[0].salt), again[0].hash)) return res.status(401).json({ error: 'bad-login' });
      created = true;
    } else if (!L.safeEq(L.hashPass(pass, rows[0].salt), rows[0].hash)) {
      return res.status(401).json({ error: 'bad-login' });
    }
    return res.status(200).json({ ok: true, name: L.USERS[user], token: L.sign(user), created });
  } catch (e) { return L.fail(res, e); }
};
