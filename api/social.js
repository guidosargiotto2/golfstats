// POST /api/social   Authorization: Bearer <token>   body { action, ... }
// Friends (follow freely if the other player is findable), professor/student link, invite code.
// Friends see a per-round summary only; an accepted professor sees the student's full rounds.
const L = require('./_lib');

const SUM = ['id', 'date', 'course', 'score', 'par', 'stp', 'sgtot', 'ott', 'app', 'atg', 'putt', 'mtot', 'p3', 'db', 'bp5', 'f150', 'fx', 'fw', 'gir', 'putts', 'pen', 'holesPlayed'];
const summary = d => { const o = {}; for (const k of SUM) if (d && d[k] != null) o[k] = d[k]; return o; };
const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const me = L.auth(req);
    if (!me) return res.status(401).json({ error: 'auth' });
    await L.init();
    const sql = L.db();
    const b = L.body(req);
    const action = String(b.action || '');
    const target = String(b.user || '').trim().toLowerCase();
    const ok = extra => res.status(200).json(Object.assign({ ok: true }, extra || {}));
    const bad = (code, err) => res.status(code).json({ error: err });

    await sql`insert into gs_profiles (username, display) values (${me}, ${L.LEGACY[me] || me}) on conflict (username) do nothing`;

    if (action === 'me') {
      const p = (await sql`select username, display, findable, professor, prof_status from gs_profiles where username = ${me}`)[0];
      const following = await sql`select p.username, p.display from gs_follows f join gs_profiles p on p.username = f.followee where f.follower = ${me}`;
      const followers = await sql`select p.username, p.display from gs_follows f join gs_profiles p on p.username = f.follower where f.followee = ${me}`;
      const students = await sql`select username, display, prof_status from gs_profiles where professor = ${me}`;
      let profName = null;
      if (p.professor) { const r = await sql`select display from gs_profiles where username = ${p.professor}`; profName = r.length ? r[0].display : p.professor; }
      const out = { username: me, name: p.display, findable: p.findable, professor: p.professor, professorName: profName, profStatus: p.prof_status, following, followers, students, admin: me === L.ADMIN };
      if (me === L.ADMIN) { const inv = await sql`select v from gs_settings where k = 'invite'`; out.invite = inv.length ? inv[0].v : ''; }
      return ok(out);
    }

    if (action === 'setFindable') {
      await sql`update gs_profiles set findable = ${!!b.findable} where username = ${me}`;
      return ok();
    }

    if (action === 'search') {
      const q = String(b.q || '').trim().toLowerCase().replace(/[%_\\]/g, '');
      if (q.length < 2) return ok({ results: [] });
      const like = '%' + q + '%';
      const rows = await sql`select username, display from gs_profiles where findable = true and username <> ${me} and (lower(username) like ${like} or lower(display) like ${like}) order by display limit 12`;
      return ok({ results: rows });
    }

    if (action === 'follow') {
      if (!L.validUser(target) || target === me) return bad(400, 'bad-user');
      const t = await sql`select findable from gs_profiles where username = ${target}`;
      if (!t.length || !t[0].findable) return bad(404, 'not-findable');
      await sql`insert into gs_follows (follower, followee) values (${me}, ${target}) on conflict (follower, followee) do nothing`;
      return ok();
    }
    if (action === 'unfollow') {
      await sql`delete from gs_follows where follower = ${me} and followee = ${target}`;
      return ok();
    }
    if (action === 'removeFollower') {
      await sql`delete from gs_follows where follower = ${target} and followee = ${me}`;
      return ok();
    }

    if (action === 'feed') {
      // per-round summaries of everyone I follow (logged rounds that reached the server)
      const rows = await sql`select r.username, p.display, r.data from gs_rounds r join gs_follows f on f.followee = r.username and f.follower = ${me} join gs_profiles p on p.username = r.username where r.deleted = false`;
      const by = {};
      for (const r of rows) { (by[r.username] = by[r.username] || { username: r.username, name: r.display, rounds: [] }).rounds.push(summary(r.data)); }
      const friends = Object.values(by);
      friends.forEach(f => { f.rounds.sort(byDateDesc); f.rounds = f.rounds.slice(0, 60); });
      return ok({ friends });
    }

    if (action === 'setProfessor') {
      if (!target) { await sql`update gs_profiles set professor = null, prof_status = null where username = ${me}`; return ok(); }
      if (!L.validUser(target) || target === me) return bad(400, 'bad-user');
      const t = await sql`select 1 as x from gs_profiles where username = ${target}`;
      if (!t.length) return bad(404, 'no-user');
      await sql`update gs_profiles set professor = ${target}, prof_status = 'pending' where username = ${me}`;
      return ok();
    }
    if (action === 'profRespond') {
      // I am the professor answering a student's request (or dropping a student)
      const s = await sql`select prof_status from gs_profiles where username = ${target} and professor = ${me}`;
      if (!s.length) return bad(404, 'no-request');
      if (b.accept) await sql`update gs_profiles set prof_status = 'accepted' where username = ${target} and professor = ${me}`;
      else await sql`update gs_profiles set professor = null, prof_status = null where username = ${target} and professor = ${me}`;
      return ok();
    }
    if (action === 'student') {
      // full rounds of one accepted student
      const s = await sql`select display from gs_profiles where username = ${target} and professor = ${me} and prof_status = 'accepted'`;
      if (!s.length) return bad(403, 'not-your-student');
      const rows = await sql`select data from gs_rounds where username = ${target} and deleted = false`;
      return ok({ username: target, name: s[0].display, rounds: rows.map(r => r.data).sort(byDateDesc).slice(0, 200) });
    }

    if (action === 'setInvite') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const code = String(b.code || '').trim().slice(0, 40);
      await sql`insert into gs_settings (k, v) values ('invite', ${code}) on conflict (k) do update set v = excluded.v`;
      return ok({ invite: code });
    }

    return bad(400, 'action');
  } catch (e) { return L.fail(res, e); }
};
