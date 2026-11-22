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
    if (!(await L.alive(sql, me))) return res.status(401).json({ error: 'auth' });
    const b = L.body(req);
    const action = String(b.action || '');
    const target = String(b.user || '').trim().toLowerCase();
    const ok = extra => res.status(200).json(Object.assign({ ok: true }, extra || {}));
    const bad = (code, err) => res.status(code).json({ error: err });

    await sql`insert into gs_profiles (username, display) values (${me}, ${L.LEGACY[me] || me}) on conflict (username) do nothing`;
    const myPlan = await L.effectivePlan(sql, me, ((await sql`select plan from gs_profiles where username = ${me}`)[0] || {}).plan);
    const needLite = () => L.rank(myPlan) < 1;   // friends, professor link and Statistics are Lite and up

    if (action === 'me') {
      const p = (await sql`select username, display, findable, professor, prof_status, plan from gs_profiles where username = ${me}`)[0];
      const following = await sql`select p.username, p.display from gs_follows f join gs_profiles p on p.username = f.followee where f.follower = ${me}`;
      const followers = await sql`select p.username, p.display from gs_follows f join gs_profiles p on p.username = f.follower where f.followee = ${me}`;
      const students = await sql`select username, display, prof_status from gs_profiles where professor = ${me}`;
      let profName = null;
      if (p.professor) { const r = await sql`select display from gs_profiles where username = ${p.professor}`; profName = r.length ? r[0].display : p.professor; }
      const ids = await sql`select provider, email from gs_identities where username = ${me}`;
      const out = { identities: ids, providers: L.providersOn(), username: me, name: p.display, findable: p.findable, professor: p.professor, professorName: profName, profStatus: p.prof_status, following, followers, students, admin: me === L.ADMIN, plan: myPlan };
      // every account starts with a free month: upgrades open 30 days after the account was created
      const cu = await sql`select created from gs_users where username = ${me}`;
      const created = cu.length && cu[0].created ? new Date(cu[0].created) : new Date();
      out.created = created.toISOString();
      const tm = await sql`select m.code, t.owner, t.paid, t.seats from gs_team_members m join gs_teams t on t.code = m.code where m.username = ${me}`;
      if (tm.length) {
        const mem = await sql`select m.username, p.display from gs_team_members m join gs_profiles p on p.username = m.username where m.code = ${tm[0].code} order by m.joined`;
        out.team = { code: tm[0].code, owner: tm[0].owner, paid: tm[0].paid, seats: tm[0].seats, members: mem, isOwner: tm[0].owner === me };
      }
      out.upgradeFrom = new Date(created.getTime() + 30 * 864e5).toISOString();
      const rc = await sql`select count(*)::int as n from gs_rounds where username = ${me} and deleted = false`;
      out.roundsLogged = rc[0].n || 0;
      const rv = await sql`select status, recommendation, requested, done from gs_reviews where username = ${me}`;
      if (rv.length) out.review = rv[0];
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
      if (needLite()) return bad(402, 'plan');
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
      if (needLite()) return ok({ friends: [] });
      // per-round summaries of everyone I follow (logged rounds that reached the server)
      const rows = await sql`select r.username, p.display, r.data from gs_rounds r join gs_follows f on f.followee = r.username and f.follower = ${me} join gs_profiles p on p.username = r.username where r.deleted = false`;
      const by = {};
      for (const r of rows) { (by[r.username] = by[r.username] || { username: r.username, name: r.display, rounds: [] }).rounds.push(summary(r.data)); }
      const friends = Object.values(by);
      friends.forEach(f => { f.rounds.sort(byDateDesc); f.rounds = f.rounds.slice(0, 60); });
      return ok({ friends });
    }

    if (action === 'setProfessor') {
      if (target && needLite()) return bad(402, 'plan');
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
      // full rounds of one accepted student — or of anyone, for the admin (Guido prepares Pro calls)
      const s = me === L.ADMIN
        ? await sql`select display from gs_profiles where username = ${target}`
        : await sql`select display from gs_profiles where username = ${target} and professor = ${me} and prof_status = 'accepted'`;
      if (!s.length) return bad(403, 'not-your-student');
      const rows = await sql`select data from gs_rounds where username = ${target} and deleted = false`;
      return ok({ username: target, name: s[0].display, rounds: rows.map(r => r.data).sort(byDateDesc).slice(0, 200) });
    }

    /* ---- teams (4×3 offer): the owner buys, shares a code, up to 4 players join ---- */
    /* ---- free review call after the first month ---- */
    if (action === 'reviewRequest') {
      const cu = await sql`select created from gs_users where username = ${me}`;
      const created = cu.length && cu[0].created ? new Date(cu[0].created) : new Date();
      if (Date.now() < created.getTime() + 30 * 864e5 && !L.LEGACY[me]) return bad(409, 'too-early');
      const rc = await sql`select count(*)::int as n from gs_rounds where username = ${me} and deleted = false`;
      if ((rc[0].n || 0) < 5) return bad(409, 'few-rounds');
      const contact = String(b.contact || '').trim().slice(0, 120), note = String(b.note || '').trim().slice(0, 500);
      if (contact.length < 5) return bad(400, 'contact');
      await sql`insert into gs_reviews (username, contact, note) values (${me}, ${contact}, ${note}) on conflict (username) do update set contact = excluded.contact, note = excluded.note, status = 'requested', requested = now()`;
      return ok();
    }
    if (action === 'reviewList') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const rows = await sql`select r.username, p.display, r.contact, r.note, r.status, r.recommendation, r.requested from gs_reviews r join gs_profiles p on p.username = r.username order by r.requested desc`;
      return ok({ reviews: rows });
    }
    if (action === 'reviewDone') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const rec = ['free', 'lite', 'pro'].includes(b.recommendation) ? b.recommendation : null;
      await sql`update gs_reviews set status = 'done', recommendation = ${rec}, done = now() where username = ${target}`;
      if (rec) await sql`update gs_profiles set plan = ${rec} where username = ${target}`;
      return ok();
    }
    if (action === 'teamCreate') {
      const inT = await sql`select 1 as x from gs_team_members where username = ${me}`;
      if (inT.length) return bad(409, 'in-team');
      let code = '';
      for (let i = 0; i < 20 && !code; i++) {
        const c = 'GOLF-' + L.crypto.randomBytes(3).toString('hex').toUpperCase();
        const ex = await sql`select 1 as x from gs_teams where code = ${c}`;
        if (!ex.length) code = c;
      }
      await sql`insert into gs_teams (code, owner) values (${code}, ${me})`;
      await sql`insert into gs_team_members (username, code) values (${me}, ${code})`;
      return ok({ code });
    }
    if (action === 'teamJoin') {
      const code = String(b.code || '').trim().toUpperCase();
      const t = await sql`select code, seats from gs_teams where code = ${code}`;
      if (!t.length) return bad(404, 'no-team');
      const inT = await sql`select code from gs_team_members where username = ${me}`;
      if (inT.length) return bad(409, inT[0].code === code ? 'already' : 'in-team');
      const n = await sql`select count(*)::int as n from gs_team_members where code = ${code}`;
      if ((n[0].n || 0) >= t[0].seats) return bad(409, 'full');
      await sql`insert into gs_team_members (username, code) values (${me}, ${code})`;
      return ok({ code });
    }
    if (action === 'teamLeave') {
      const tm = await sql`select m.code, t.owner from gs_team_members m join gs_teams t on t.code = m.code where m.username = ${me}`;
      if (!tm.length) return ok();
      if (tm[0].owner === me) { await sql`delete from gs_team_members where code = ${tm[0].code}`; await sql`delete from gs_teams where code = ${tm[0].code}`; }
      else await sql`delete from gs_team_members where username = ${me}`;
      return ok();
    }
    if (action === 'teamSetPaid') {   // until payments are connected, the admin confirms a team was paid
      if (me !== L.ADMIN) return bad(403, 'admin');
      await sql`update gs_teams set paid = ${!!b.paid} where code = ${String(b.code || '').toUpperCase()}`;
      return ok();
    }
    if (action === 'members') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const rows = await sql`select p.username, p.display, p.plan, m.code from gs_profiles p left join gs_team_members m on m.username = p.username order by p.display`;
      const teams = await sql`select t.code, t.owner, t.paid, count(m.username)::int as n from gs_teams t left join gs_team_members m on m.code = t.code group by t.code, t.owner, t.paid, t.created order by t.created`;
      const out = [];
      for (const r of rows) out.push({ username: r.username, display: r.display, plan: L.planOf(r.username, r.plan), team: r.code || null });
      return ok({ members: out, teams });
    }
    if (action === 'setPlan') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const plan = String(b.plan || '');
      if (!['free', 'lite', 'pro'].includes(plan) || !L.validUser(target)) return bad(400, 'bad-plan');
      await sql`update gs_profiles set plan = ${plan} where username = ${target}`;
      return ok();
    }

    /* ---- your data: download everything / delete the account ---- */
    if (action === 'export') {
      const user = (await sql`select username, created from gs_users where username = ${me}`)[0] || { username: me };
      const profile = (await sql`select display, findable, professor, prof_status, plan from gs_profiles where username = ${me}`)[0] || null;
      const rounds = await sql`select id, data, upd from gs_rounds where username = ${me} and deleted = false order by id`;
      const following = await sql`select followee as username from gs_follows where follower = ${me}`;
      const followers = await sql`select follower as username from gs_follows where followee = ${me}`;
      const team = await sql`select m.code, m.joined, t.owner, t.paid from gs_team_members m join gs_teams t on t.code = m.code where m.username = ${me}`;
      const review = await sql`select contact, note, status, recommendation, requested, done from gs_reviews where username = ${me}`;
      const signIns = await sql`select provider, email, created from gs_identities where username = ${me}`;
      return ok({ exported: new Date().toISOString(), app: 'Golfimbul', account: user, profile, plan: myPlan, signIns, following, followers, team: team[0] || null, review: review[0] || null, rounds: rounds.map(r => Object.assign({ id: r.id, updated: Number(r.upd) }, { data: r.data })) });
    }
    if (action === 'deleteAccount') {
      if (String(b.confirm || '') !== 'DELETE') return bad(400, 'confirm');
      if (me === L.ADMIN) return bad(403, 'admin-account');
      await sql`delete from gs_rounds where username = ${me}`;
      await sql`delete from gs_follows where follower = ${me} or followee = ${me}`;
      await sql`update gs_profiles set professor = null, prof_status = null where professor = ${me}`;
      const own = await sql`select code from gs_teams where owner = ${me}`;
      for (const t of own) { await sql`delete from gs_team_members where code = ${t.code}`; await sql`delete from gs_teams where code = ${t.code}`; }
      await sql`delete from gs_team_members where username = ${me}`;
      await sql`delete from gs_reviews where username = ${me}`;
      await sql`delete from gs_identities where username = ${me}`;
      await sql`delete from gs_profiles where username = ${me}`;
      if (L.LEGACY[me]) {
        // an original player's username would otherwise be claimable again with the old password: lock it instead
        const salt = L.crypto.randomBytes(16).toString('hex');
        await sql`update gs_users set salt = ${salt}, hash = ${L.hashPass(L.crypto.randomBytes(24).toString('hex'), salt)}, must_change = false, gone = true where username = ${me}`;
      } else await sql`delete from gs_users where username = ${me}`;
      return ok({ deleted: true });
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
