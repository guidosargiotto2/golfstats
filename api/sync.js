// POST /api/sync   Authorization: Bearer <token>
// body { rounds:[{id, upd, ...}], deleted:[id] }  ->  { ok, rounds:[...], deleted:[id] }
// Per round the newest "upd" wins; deletions are kept as tombstones so they reach every device.
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const user = L.verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user) return res.status(401).json({ error: 'auth' });
    await L.init();
    const sql = L.db();
    const b = L.body(req);
    const rounds = (Array.isArray(b.rounds) ? b.rounds : []).filter(r => r && typeof r === 'object' && r.id).slice(0, 2000);
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
    const rows = await sql`select id, data, deleted from gs_rounds where username = ${user}`;
    return res.status(200).json({
      ok: true,
      rounds: rows.filter(x => !x.deleted).map(x => x.data),
      deleted: rows.filter(x => x.deleted).map(x => x.id)
    });
  } catch (e) { return L.fail(res, e); }
};
