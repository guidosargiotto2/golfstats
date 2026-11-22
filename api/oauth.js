// Sign in with Google / Microsoft (OAuth 2.0 authorization-code flow, confidential client).
//   start:    GET /api/oauth?provider=google|microsoft&mode=login|link[&invite=CODE][&t=TOKEN]
//   callback: GET /api/oauth?code=...&state=...      (the redirect URI registered with each provider)
// Results come back to the app in the URL fragment (never sent to a server):
//   #gsauth=<token>~<name>   signed in        #gslinked=<provider>   linked to the current account
//   #gsautherr=<reason>      needinvite | taken | denied | failed | off
const L = require('./_lib');

const back = (res, req, frag) => { res.statusCode = 302; res.setHeader('Location', 'https://' + req.headers.host + '/#' + frag); res.end(); };
const redirectUri = req => 'https://' + req.headers.host + '/api/oauth';
const claims = jwt => { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString()); } catch (e) { return {}; } };

async function uniqueUsername(sql, email, name) {
  let base = String((email || '').split('@')[0] || name || 'golfer').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 16);
  if (base.length < 3) base = (base + 'golfer').slice(0, 8);
  if (L.LEGACY[base]) base = base + '1';
  for (let i = 0; i < 50; i++) {
    const u = i ? (base.slice(0, 16) + (i + 1)) : base;
    const r = await sql`select 1 as x from gs_users where username = ${u}`;
    if (!r.length) return u;
  }
  return base.slice(0, 12) + Date.now().toString(36).slice(-6);
}
async function uniqueDisplay(sql, name, user) {
  let d = String(name || user).replace(/[<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 22);
  if (d.length < 2) d = user;
  for (let i = 0; i < 50; i++) {
    const n = i ? d.slice(0, 20) + ' ' + (i + 1) : d, low = n.toLowerCase();
    const r = await sql`select 1 as x from gs_profiles where lower(display) = ${low}`;
    if (!r.length && !Object.values(L.LEGACY).some(x => x.toLowerCase() === low)) return n;
  }
  return user;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  try {
    /* ---- 1. start: send the player to the provider ---- */
    if (!q.code && !q.error) {
      const prov = L.PROVIDERS[q.provider];
      if (!prov || !prov.id() || !prov.secret() || !L.hasDb()) return back(res, req, 'gsautherr=off');
      const st = { p: q.provider, m: q.mode === 'link' ? 'link' : 'login', inv: String(q.invite || '').slice(0, 40), n: L.crypto.randomBytes(8).toString('hex') };
      if (st.m === 'link') { const u = L.verify(q.t); if (!u) return back(res, req, 'gsautherr=failed'); st.u = u; }
      const url = prov.auth + '?' + new URLSearchParams({ client_id: prov.id(), redirect_uri: redirectUri(req), response_type: 'code', scope: prov.scope, state: L.signBlob(st, 10), prompt: 'select_account' }).toString();
      res.statusCode = 302; res.setHeader('Location', url); return res.end();
    }
    /* ---- 2. callback ---- */
    const st = L.verifyBlob(q.state);
    if (!st) return back(res, req, 'gsautherr=failed');
    if (q.error) return back(res, req, 'gsautherr=denied');
    const prov = L.PROVIDERS[st.p];
    const tr = await fetch(prov.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: prov.id(), client_secret: prov.secret(), code: String(q.code), grant_type: 'authorization_code', redirect_uri: redirectUri(req) }).toString() });
    const tj = await tr.json();
    if (!tr.ok || !tj.id_token) { console.error('oauth token', st.p, tj && tj.error); return back(res, req, 'gsautherr=failed'); }
    const c = claims(tj.id_token);   // received directly from the provider over TLS in exchange for our secret
    if (!c.sub || (st.p === 'google' && c.aud !== prov.id()) || (st.p === 'microsoft' && c.aud !== prov.id())) return back(res, req, 'gsautherr=failed');
    const email = String(c.email || c.preferred_username || '').toLowerCase().slice(0, 120), sub = String(c.sub);
    await L.init();
    const sql = L.db();
    const known = await sql`select username from gs_identities where provider = ${st.p} and sub = ${sub}`;

    if (st.m === 'link') {
      if (known.length && known[0].username !== st.u) return back(res, req, 'gsautherr=taken');
      if (!known.length) await sql`insert into gs_identities (provider, sub, username, email) values (${st.p}, ${sub}, ${st.u}, ${email}) on conflict (provider, sub) do nothing`;
      return back(res, req, 'gslinked=' + st.p);
    }
    let user;
    if (known.length) user = known[0].username;
    else {
      // new player: same rule as a password sign-up — an invite code is required
      const inv = await sql`select v from gs_settings where k = 'invite'`;
      const want = inv.length ? String(inv[0].v || '') : '';
      if (!want || st.inv !== want) return back(res, req, 'gsautherr=needinvite&p=' + st.p);
      user = await uniqueUsername(sql, email, c.name);
      const salt = L.crypto.randomBytes(16).toString('hex');
      await sql`insert into gs_users (username, salt, hash) values (${user}, ${salt}, ${L.hashPass(L.crypto.randomBytes(24).toString('hex'), salt)})`;
      const display = await uniqueDisplay(sql, c.name || c.given_name, user);
      await sql`insert into gs_profiles (username, display) values (${user}, ${display}) on conflict (username) do nothing`;
      await sql`insert into gs_identities (provider, sub, username, email) values (${st.p}, ${sub}, ${user}, ${email}) on conflict (provider, sub) do nothing`;
    }
    const pr = await sql`select display from gs_profiles where username = ${user}`;
    const name = pr.length ? pr[0].display : (L.LEGACY[user] || user);
    return back(res, req, 'gsauth=' + encodeURIComponent(L.sign(user)) + '~' + encodeURIComponent(name));
  } catch (e) { console.error(e); return back(res, req, 'gsautherr=failed'); }
};
