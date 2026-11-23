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
      const tm = await sql`select m.code, t.owner, t.paid, t.seats, t.plan from gs_team_members m join gs_teams t on t.code = m.code where m.username = ${me}`;
      if (tm.length) {
        const mem = await sql`select m.username, p.display from gs_team_members m join gs_profiles p on p.username = m.username where m.code = ${tm[0].code} order by m.joined`;
        out.team = { code: tm[0].code, owner: tm[0].owner, paid: tm[0].paid, plan: tm[0].plan || 'lite', seats: tm[0].seats, members: mem, isOwner: tm[0].owner === me };
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
        ? await sql`select display, about from gs_profiles where username = ${target}`
        : await sql`select display, about from gs_profiles where username = ${target} and professor = ${me} and prof_status = 'accepted'`;
      if (!s.length) return bad(403, 'not-your-student');
      const rows = await sql`select data from gs_rounds where username = ${target} and deleted = false`;
      return ok({ username: target, name: s[0].display, about: s[0].about || null, rounds: rows.map(r => r.data).sort(byDateDesc).slice(0, 200) });
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
    if (action === 'setAbout') {   // first-login answers: why they play, experience, practice habits, course, index, distances
      const a = b.about && typeof b.about === 'object' ? b.about : null;
      if (!a) return bad(400, 'bad-about');
      const s = JSON.stringify(a);
      if (s.length > 4000) return bad(413, 'too-big');
      await sql`update gs_profiles set about = ${s} where username = ${me}`;
      return ok();
    }
    if (action === 'reviewList') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const rows = await sql`select r.username, p.display, p.about, r.contact, r.note, r.status, r.recommendation, r.requested from gs_reviews r join gs_profiles p on p.username = r.username order by r.requested desc`;
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
      if (b.plan === 'lite' || b.plan === 'pro') await sql`update gs_teams set plan = ${b.plan} where code = ${String(b.code || '').toUpperCase()}`;
      return ok();
    }
    if (action === 'members') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const rows = await sql`select p.username, p.display, p.plan, m.code from gs_profiles p left join gs_team_members m on m.username = p.username order by p.display`;
      const teams = await sql`select t.code, t.owner, t.paid, t.plan, count(m.username)::int as n from gs_teams t left join gs_team_members m on m.code = t.code group by t.code, t.owner, t.paid, t.plan, t.created order by t.created`;
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

    /* ---- AI assistant over MCP: personal read-only keys (Lite and Pro) ---- */
    if (action === 'mcpKeys') {
      const k = await sql`select id, label, created, last_used from gs_keys where username = ${me} order by created`;
      return ok({ keys: k });
    }
    if (action === 'mcpCreate') {
      if (needLite()) return bad(403, 'plan');
      const n = await sql`select count(*)::int as n from gs_keys where username = ${me}`;
      if (n[0].n >= 5) return bad(400, 'too-many-keys');
      const key = 'gk_' + L.crypto.randomBytes(16).toString('hex'), id = L.crypto.randomBytes(6).toString('hex');
      const label = String(b.label || 'AI assistant').replace(/[<>&"']/g, '').slice(0, 40);
      await sql`insert into gs_keys (id, username, hash, label) values (${id}, ${me}, ${L.crypto.createHash('sha256').update(key).digest('hex')}, ${label})`;
      return ok({ id, key, label });
    }
    if (action === 'mcpRevoke') {
      await sql`delete from gs_keys where username = ${me} and id = ${String(b.id || '')}`;
      return ok();
    }

    /* ---- homework & challenges: a coach (admin, or the player's accepted professor) assigns; the player logs progress ---- */
    const isCoachOf = async (u) => {
      if (!L.validUser(u)) return false;
      if (me === L.ADMIN) return true;
      const r = await sql`select 1 as x from gs_profiles where username = ${u} and professor = ${me} and prof_status = 'accepted'`;
      return r.length > 0;
    };
    const cleanTask = t => ({ id: t.id, username: t.username, coach: t.coach, coachName: t.coach_name || t.coach, kind: t.kind, title: t.title, detail: t.detail || '', due: t.due || '', target: typeof t.target === 'string' ? JSON.parse(t.target) : (t.target || null), log: typeof t.log === 'string' ? JSON.parse(t.log) : (t.log || []), status: t.status, created: t.created, upd: Number(t.upd) });
    if (action === 'taskList') {
      const u = target || me;
      if (u !== me && !(await isCoachOf(u))) return bad(403, 'not-your-student');
      const rows = await sql`select t.*, p.display as coach_name from gs_tasks t left join gs_profiles p on p.username = t.coach where t.username = ${u} order by t.created desc`;
      return ok({ tasks: rows.map(cleanTask) });
    }
    if (action === 'taskSave') {   // create or edit (coach)
      const u = target;
      if (!(await isCoachOf(u))) return bad(403, 'not-your-student');
      const kind = b.kind === 'challenge' ? 'challenge' : 'practice';
      const title = String(b.title || '').trim().slice(0, 120);
      if (title.length < 3) return bad(400, 'title');
      const detail = String(b.detail || '').trim().slice(0, 1000);
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due || '')) ? String(b.due) : '';
      let tg = null;
      if (kind === 'challenge') {
        const t = b.target || {};
        const metrics = ['p3', 'pen', 'db', 'mtot', 'putts', 'stp', 'sgtot', 'ott', 'app', 'atg', 'putt', 'gir', 'fw'];
        if (!metrics.includes(t.metric) || isNaN(+t.value)) return bad(400, 'target');
        tg = { metric: t.metric, op: t.op === 'ge' ? 'ge' : 'le', value: +t.value, rounds: Math.min(20, Math.max(1, parseInt(t.rounds, 10) || 5)), from: /^\d{4}-\d{2}-\d{2}$/.test(String(t.from || '')) ? t.from : new Date().toISOString().slice(0, 10) };
      } else {
        const pw = parseInt((b.target || {}).perWeek, 10);
        tg = { perWeek: isNaN(pw) ? 0 : Math.min(14, Math.max(0, pw)) };
      }
      const upd = Date.now();
      if (b.id) {
        const r = await sql`select username from gs_tasks where id = ${String(b.id)}`;
        if (!r.length || r[0].username !== u) return bad(404, 'no-task');
        await sql`update gs_tasks set kind = ${kind}, title = ${title}, detail = ${detail}, due = ${due}, target = ${JSON.stringify(tg)}, upd = ${upd} where id = ${String(b.id)}`;
        return ok({ id: String(b.id) });
      }
      const id = 'k' + L.crypto.randomBytes(6).toString('hex');
      await sql`insert into gs_tasks (id, username, coach, kind, title, detail, due, target, upd) values (${id}, ${u}, ${me}, ${kind}, ${title}, ${detail}, ${due}, ${JSON.stringify(tg)}, ${upd})`;
      return ok({ id });
    }
    if (action === 'taskStatus' || action === 'taskLog') {
      const r = await sql`select username, log from gs_tasks where id = ${String(b.id || '')}`;
      if (!r.length) return bad(404, 'no-task');
      const owner = r[0].username, coach = await isCoachOf(owner);
      if (owner !== me && !coach) return bad(403, 'forbidden');
      if (action === 'taskStatus') {
        const st = String(b.status || '');
        if (!['open', 'done', 'dropped', 'deleted'].includes(st)) return bad(400, 'status');
        if ((st === 'dropped' || st === 'deleted') && !coach) return bad(403, 'coach-only');
        if (st === 'deleted') { await sql`delete from gs_tasks where id = ${String(b.id)}`; return ok(); }
        await sql`update gs_tasks set status = ${st}, upd = ${Date.now()} where id = ${String(b.id)}`;
        return ok();
      }
      if (owner !== me) return bad(403, 'player-only');   // only the player logs practice sessions
      let log = typeof r[0].log === 'string' ? JSON.parse(r[0].log) : (Array.isArray(r[0].log) ? r[0].log : []);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? String(b.day) : new Date().toISOString().slice(0, 10);
      if (b.undo) { const i = log.lastIndexOf(day); if (i >= 0) log.splice(i, 1); } else log.push(day);
      log = log.slice(-400);
      await sql`update gs_tasks set log = ${JSON.stringify(log)}, upd = ${Date.now()} where id = ${String(b.id)}`;
      return ok({ log });
    }

    /* ---- GolfCourseAPI lookup (admin only; key stays on the server; one course at a time, never bulk) ---- */
    if (action === 'gcaSearch' || action === 'gcaCourse') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const key = String(process.env.GOLFCOURSEAPI_KEY || process.env.GOLF_COURSE_API_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/^(Bearer|Key)\s+/i, '').trim();   // tolerate a pasted prefix, quotes or spaces
      if (!key) return bad(503, 'no-gca-key');
      const url = action === 'gcaSearch'
        ? 'https://api.golfcourseapi.com/v1/search?search_query=' + encodeURIComponent(String(b.q || '').slice(0, 80))
        : 'https://api.golfcourseapi.com/v1/courses/' + encodeURIComponent(String(b.id || '').replace(/[^0-9a-zA-Z_-]/g, ''));
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'gca', status: r.status, message: ((j && (j.message || j.error)) || '') + (r.status === 401 ? ' [key length ' + key.length + ']' : '') });
      const loc = c => [c.location && c.location.city, c.location && c.location.state, c.location && c.location.country].filter(Boolean).join(', ');
      if (action === 'gcaSearch') return ok({ results: (j.courses || []).slice(0, 20).map(c => ({ id: c.id, club: c.club_name, course: c.course_name, where: loc(c) })) });
      const c = j.course || j;
      const teeList = [].concat((c.tees && c.tees.male) || [], (c.tees && c.tees.female) || []);
      return ok({ course: { id: c.id, club: c.club_name, course: c.course_name, where: loc(c), tees: teeList.map(t => ({ name: t.tee_name, cr: t.course_rating, slope: t.slope_rating, par: t.par_total, holes: (t.holes || []).map(h => ({ par: h.par, yds: h.yardage, si: h.handicap })) })) } });
    }

    /* ---- course requests: players ask for their course; the admin checks the scorecard and adds it ---- */
    if (action === 'courseRequest') {
      const name = String(b.name || '').trim().slice(0, 120), city = String(b.city || '').trim().slice(0, 80);
      if (name.length < 3) return bad(400, 'name');
      const photos = (Array.isArray(b.photos) ? b.photos : []).filter(x => typeof x === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(x) && x.length < 900000).slice(0, 3);
      const open = await sql`select count(*)::int as n from gs_course_requests where username = ${me} and status = 'requested'`;
      if (open[0].n >= 5) return bad(400, 'too-many');
      const id = 'c' + L.crypto.randomBytes(6).toString('hex');
      await sql`insert into gs_course_requests (id, username, name, city, tees, note, photos) values (${id}, ${me}, ${name}, ${city}, ${String(b.tees || '').slice(0, 120)}, ${String(b.note || '').slice(0, 600)}, ${JSON.stringify(photos)})`;
      return ok({ id });
    }
    if (action === 'myCourseRequests') {
      const rows = await sql`select id, name, city, status, created from gs_course_requests where username = ${me} order by created desc`;
      return ok({ requests: rows });
    }
    if (action === 'courseRequests') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const rows = await sql`select r.id, r.username, p.display, r.name, r.city, r.tees, r.note, r.photos, r.status, r.created from gs_course_requests r left join gs_profiles p on p.username = r.username order by (r.status = 'requested') desc, r.created desc`;
      return ok({ requests: rows.map(r => Object.assign({}, r, { photos: typeof r.photos === 'string' ? JSON.parse(r.photos) : (r.photos || []) })) });
    }
    if (action === 'courseRequestStatus') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const st = ['requested', 'added', 'rejected'].includes(b.status) ? b.status : 'requested';
      await sql`update gs_course_requests set status = ${st}, done = ${st === 'requested' ? null : new Date().toISOString()} where id = ${String(b.id || '')}`;
      return ok();
    }
    if (action === 'courseSave') {   // admin adds or edits a course in the shared database
      if (me !== L.ADMIN) return bad(403, 'admin');
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const c = b.course || {};
      const okArr = (a, lo, hi) => Array.isArray(a) && a.length === 18 && a.every(x => Number.isFinite(+x) && +x >= lo && +x <= hi);
      if (code.length < 2 || String(c.name || '').trim().length < 3 || !okArr(c.par, 3, 6) || !okArr(c.hcp, 1, 18) || new Set(c.hcp.map(Number)).size !== 18) return bad(400, 'bad-course');
      const tees = {};
      Object.keys(c.tees || {}).slice(0, 8).forEach(k => { const t = c.tees[k] || {}; const key = String(k).replace(/[^A-Za-zÀ-ÿ0-9 ]/g, '').slice(0, 20);
        if (key && okArr(t.yds, 40, 800) && Number.isFinite(+t.cr) && Number.isFinite(+t.slope)) tees[key] = { label: String(t.label || key).slice(0, 40), cr: +t.cr, slope: +t.slope, est: false, yds: t.yds.map(Number) }; });
      if (!Object.keys(tees).length) return bad(400, 'no-tees');
      const data = { name: String(c.name).trim().slice(0, 60), abbr: code, pins: c.pins || { F: 'red', M: 'white', B: 'blue' }, par: c.par.map(Number), hcp: c.hcp.map(Number), tees };
      await sql`insert into gs_courses (code, data, upd) values (${code}, ${JSON.stringify(data)}, ${Date.now()}) on conflict (code) do update set data = excluded.data, upd = excluded.upd`;
      return ok({ code });
    }

    /* ---- My bag from a Garmin export (parsed in the browser; only the summary is stored) — Lite and Pro ---- */
    if (action === 'bagGet') {
      const r = await sql`select data, upd from gs_bags where username = ${me}`;
      if (!r.length) return ok({ bag: null });
      const upd = Number(r[0].upd);
      return ok(upd > Number(b.have || 0) ? { bag: r[0].data, upd } : { upd, same: true });
    }
    if (action === 'bagSet') {
      if (needLite()) return bad(403, 'plan');
      const data = b.bag;
      if (!data || typeof data !== 'object' || !Array.isArray(data.clubs)) return bad(400, 'bad-bag');
      if (JSON.stringify(data).length > 3e6) return bad(413, 'too-big');
      const upd = Date.now();
      await sql`insert into gs_bags (username, data, upd) values (${me}, ${JSON.stringify(data)}, ${upd}) on conflict (username) do update set data = excluded.data, upd = excluded.upd`;
      return ok({ upd });
    }
    if (action === 'bagClear') {
      await sql`delete from gs_bags where username = ${me}`;
      await sql`delete from gs_keys where username = ${me}`;
      await sql`delete from gs_tasks where username = ${me}`;
      await sql`delete from gs_course_requests where username = ${me}`;
      return ok();
    }

    /* ---- your data: download everything / delete the account ---- */
    if (action === 'export') {
      const user = (await sql`select username, created from gs_users where username = ${me}`)[0] || { username: me };
      const profile = (await sql`select display, findable, professor, prof_status, plan, about from gs_profiles where username = ${me}`)[0] || null;
      const rounds = await sql`select id, data, upd from gs_rounds where username = ${me} and deleted = false order by id`;
      const following = await sql`select followee as username from gs_follows where follower = ${me}`;
      const followers = await sql`select follower as username from gs_follows where followee = ${me}`;
      const team = await sql`select m.code, m.joined, t.owner, t.paid from gs_team_members m join gs_teams t on t.code = m.code where m.username = ${me}`;
      const review = await sql`select contact, note, status, recommendation, requested, done from gs_reviews where username = ${me}`;
      const signIns = await sql`select provider, email, created from gs_identities where username = ${me}`;
      const bag = await sql`select data, upd from gs_bags where username = ${me}`;
      const tasks = await sql`select id, coach, kind, title, detail, due, target, log, status, created from gs_tasks where username = ${me}`;
      return ok({ exported: new Date().toISOString(), app: 'Golfimbul', account: user, profile, plan: myPlan, signIns, following, followers, team: team[0] || null, review: review[0] || null, garminBag: bag.length ? bag[0].data : null, homework: tasks, rounds: rounds.map(r => Object.assign({ id: r.id, updated: Number(r.upd) }, { data: r.data })) });
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
      await sql`delete from gs_bags where username = ${me}`;
      await sql`delete from gs_identities where username = ${me}`;
      await sql`delete from gs_profiles where username = ${me}`;
      if (L.LEGACY[me]) {
        // an original player's username would otherwise be claimable again with the old password: lock it instead
        const salt = L.crypto.randomBytes(16).toString('hex');
        await sql`update gs_users set salt = ${salt}, hash = ${L.hashPass(L.crypto.randomBytes(24).toString('hex'), salt)}, must_change = false, gone = true where username = ${me}`;
      } else await sql`delete from gs_users where username = ${me}`;
      return ok({ deleted: true });
    }

    if (action === 'adminResetPass') {   // forgotten password: back to "password = username", forced change on next sign-in
      if (me !== L.ADMIN) return bad(403, 'admin');
      if (!L.validUser(target) || target === L.ADMIN) return bad(400, 'bad-user');
      const u = await sql`select gone from gs_users where username = ${target}`;
      if (!u.length || u[0].gone) return bad(404, 'no-user');
      const salt = L.crypto.randomBytes(16).toString('hex');
      await sql`update gs_users set salt = ${salt}, hash = ${L.hashPass(target, salt)}, must_change = true where username = ${target}`;
      return ok();
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
