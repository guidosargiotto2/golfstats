// POST /api/sync   Authorization: Bearer <token>
// body { rounds:[{id, upd, ...}], deleted:[id] }  ->  { ok, rounds:[...], deleted:[id] }
// Per round the newest "upd" wins; deletions are kept as tombstones so they reach every device.
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const user = L.auth(req);
    if (!user) return res.status(401).json({ error: 'auth' });
    await L.init();
    const sql = L.db();
    if (!(await L.alive(sql, user))) return res.status(401).json({ error: 'auth' });
    const b = L.body(req);
    /* identity: the page says who it believes it is (b.as). If another tab signed in as someone else, the token and the page disagree: refuse, so one player's rounds are never stored under another */
    const prof = await sql`select display from gs_profiles where username = ${user}`;
    const display = (prof.length && prof[0].display) || L.FIRST[user] || user;
    const isMe = n => { const k = String(n || '').trim().toLowerCase(); return !!k && (k === user || k === String(display).toLowerCase() || k === String(L.FIRST[user] || '').toLowerCase()); };
    if (b.as != null && !isMe(b.as)) return res.status(409).json({ error: 'identity' });
    const rounds = (Array.isArray(b.rounds) ? b.rounds : []).filter(r => r && typeof r === 'object' && r.id && (!r.owner || isMe(r.owner))).slice(0, 2000);
    rounds.forEach(r => { if (!r.owner) r.owner = display; });
    const deleted = (Array.isArray(b.deleted) ? b.deleted : []).map(String).slice(0, 2000);
    const now = Date.now();
    const q = [];
    for (const r of rounds) {
      const id = String(r.id).slice(0, 80), upd = Math.max(1, Math.floor(+r.upd || 1));
      q.push(sql`insert into gs_rounds (username, id, data, upd, deleted) values (${user}, ${id}, ${JSON.stringify(r)}::jsonb, ${upd}, false)
                 on conflict (username, id) do update set data = excluded.data, upd = excluded.upd, deleted = false
                 where gs_rounds.upd < excluded.upd`);
    }
    for (const id of deleted) {
      q.push(sql`insert into gs_rounds (username, id, data, upd, deleted) values (${user}, ${id.slice(0, 80)}, '{}'::jsonb, ${now}, true)
                 on conflict (username, id) do update set deleted = true, upd = ${now}`);
    }
    if (q.length) await sql.transaction(q);
    /* repair: a round belongs to one account. Mine is dropped when it is stamped with someone else's name, or when the same round also sits in another account
       that claims it — or, if neither or both claim it, in the account that was created first. (ids starting with x are date|score|course hashes and may repeat.) */
    const lost = [];
    const own = await sql`select id, data->>'owner' as owner from gs_rounds where username = ${user} and not deleted`;
    own.forEach(x => { if (x.owner && !isMe(x.owner)) lost.push(x.id); });
    const dup = await sql`select a.id, a.data->>'owner' as mo, b.username as other, b.data->>'owner' as oo, pb.display as od, ub.created as oc, ua.created as mc
      from gs_rounds a join gs_rounds b on b.id = a.id and b.username <> a.username and not b.deleted
      left join gs_profiles pb on pb.username = b.username left join gs_users ub on ub.username = b.username left join gs_users ua on ua.username = a.username
      where a.username = ${user} and not a.deleted and a.id not like 'x%'`;
    dup.forEach(d => {
      const low = v => String(v || '').trim().toLowerCase();
      const theirs = !!d.oo && (low(d.oo) === d.other || low(d.oo) === low(d.od)), mine = !!d.mo && isMe(d.mo);
      const older = (d.oc ? new Date(d.oc).getTime() : 0) < (d.mc ? new Date(d.mc).getTime() : 0);
      if ((theirs && !mine) || (theirs === mine && older)) lost.push(d.id);
    });
    if (lost.length) await sql`update gs_rounds set deleted = true, data = '{}'::jsonb, upd = ${now} where username = ${user} and id = any(${Array.from(new Set(lost))})`;
    const rows = await sql`select id, data, deleted from gs_rounds where username = ${user}`;
    return res.status(200).json({
      ok: true,
      rounds: rows.filter(x => !x.deleted).map(x => x.data),
      deleted: rows.filter(x => x.deleted).map(x => x.id)
    });
  } catch (e) { return L.fail(res, e); }
};
