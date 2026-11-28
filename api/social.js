// POST /api/social   Authorization: Bearer <token>   body { action, ... }
// Friends (follow freely if the other player is findable), professor/student link, invite code.
// Friends see a per-round summary only; an accepted professor sees the student's full rounds.
const L = require('./_lib');
const CI = require('./_courseimp');

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
      const p = (await sql`select username, display, findable, professor, prof_status, plan, avatar from gs_profiles where username = ${me}`)[0];
      const following = await sql`select p.username, p.display, p.avatar from gs_follows f join gs_profiles p on p.username = f.followee where f.follower = ${me}`;
      const followers = await sql`select p.username, p.display, p.avatar from gs_follows f join gs_profiles p on p.username = f.follower where f.followee = ${me}`;
      const students = await sql`select username, display, prof_status from gs_profiles where professor = ${me}`;
      let profName = null;
      if (p.professor) { const r = await sql`select display from gs_profiles where username = ${p.professor}`; profName = r.length ? r[0].display : p.professor; }
      const ids = await sql`select provider, email from gs_identities where username = ${me}`;
      const out = { identities: ids, providers: L.providersOn(), username: me, name: p.display, findable: p.findable, professor: p.professor, professorName: profName, profStatus: p.prof_status, following, followers, students, admin: me === L.ADMIN, plan: myPlan };
      // every account starts with a free month: upgrades open 30 days after the account was created
      const cu = await sql`select created from gs_users where username = ${me}`;
      const created = cu.length && cu[0].created ? new Date(cu[0].created) : new Date();
      out.created = created.toISOString();
      out.avatar = p.avatar || '';
      const tm = await sql`select m.code, t.owner, t.paid, t.seats, t.plan from gs_team_members m join gs_teams t on t.code = m.code where m.username = ${me}`;
      if (tm.length) {
        const mem = await sql`select m.username, p.display from gs_team_members m join gs_profiles p on p.username = m.username where m.code = ${tm[0].code} order by m.joined`;
        out.team = { code: tm[0].code, owner: tm[0].owner, paid: tm[0].paid, plan: tm[0].plan || 'lite', seats: tm[0].seats, members: mem, isOwner: tm[0].owner === me };
      }
      out.upgradeFrom = new Date(created.getTime() + 30 * 864e5).toISOString();
      out.trial = await L.inTrial(sql, me, p.plan);   // first month: Pro, free, until the review meeting or day 30
      const rc = await sql`select count(*)::int as n from gs_rounds where username = ${me} and deleted = false`;
      out.roundsLogged = rc[0].n || 0;
      const rv = await sql`select status, recommendation, requested, done from gs_reviews where username = ${me}`;
      if (rv.length) out.review = rv[0];
      if (me === L.ADMIN) { const inv = await sql`select v from gs_settings where k = 'invite'`; out.invite = inv.length ? inv[0].v : ''; }
      return ok(out);
    }

    if (action === 'setAvatar') {   // profile photo: a small square image the app shrinks before sending; '' removes it
      const a = String(b.avatar || '');
      if (a && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a)) return bad(400, 'bad-image');
      if (a.length > 80000) return bad(413, 'too-big');
      await sql`update gs_profiles set avatar = ${a || null} where username = ${me}`;
      return ok();
    }

    if (action === 'setFindable') {
      await sql`update gs_profiles set findable = ${!!b.findable} where username = ${me}`;
      return ok();
    }

    if (action === 'search') {
      const q = String(b.q || '').trim().toLowerCase().replace(/[%_\\]/g, '');
      if (q.length < 2) return ok({ results: [] });
      const like = '%' + q + '%';
      const rows = await sql`select username, display, avatar from gs_profiles where findable = true and username <> ${me} and (lower(username) like ${like} or lower(display) like ${like}) order by display limit 12`;
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
      const rows = await sql`select r.username, p.display, p.avatar, r.data from gs_rounds r join gs_follows f on f.followee = r.username and f.follower = ${me} join gs_profiles p on p.username = r.username where r.deleted = false`;
      const by = {};
      for (const r of rows) { (by[r.username] = by[r.username] || { username: r.username, name: r.display, avatar: r.avatar || '', rounds: [] }).rounds.push(summary(r.data)); }
      /* their imported history too (club history, earlier spreadsheets): the same summary, never the shots */
      const hist = await sql`select h.username, p.display, p.avatar, h.rounds from gs_history h join gs_follows f on f.followee = h.username and f.follower = ${me} join gs_profiles p on p.username = h.username`;
      for (const h of hist) { const L0 = typeof h.rounds === 'string' ? JSON.parse(h.rounds) : (h.rounds || []); const o = (by[h.username] = by[h.username] || { username: h.username, name: h.display, avatar: h.avatar || '', rounds: [] });
        const have = new Set(o.rounds.map(x => x.date + '|' + x.score)); L0.forEach(x => { if (x && x.date && !have.has(x.date + '|' + x.score)) o.rounds.push(summary(x)); }); }
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
      const hs = await sql`select rounds from gs_history where username = ${target}`;
      const hist = hs.length ? (typeof hs[0].rounds === 'string' ? JSON.parse(hs[0].rounds) : (hs[0].rounds || [])) : [], logged = rows.map(r => r.data), have = new Set(logged.map(x => x.date + '|' + x.score));
      return ok({ username: target, name: s[0].display, about: s[0].about || null, rounds: logged.concat(hist.filter(x => x && x.date && !have.has(x.date + '|' + x.score))).sort(byDateDesc).slice(0, 400) });
    }

    /* ---- teams (4×3 offer): the owner buys, shares a code, up to 4 players join ---- */
    /* ---- free review call after the first month ---- */
    if (action === 'reviewRequest') {
      const cu = await sql`select created from gs_users where username = ${me}`;
      const created = cu.length && cu[0].created ? new Date(cu[0].created) : new Date();
      if (Date.now() < created.getTime() + 21 * 864e5 && !L.LEGACY[me]) return bad(409, 'too-early');   // from day 21, so the meeting happens before the free Pro month ends
      const rc = await sql`select count(*)::int as n from gs_rounds where username = ${me} and deleted = false`;
      if ((rc[0].n || 0) < 5) return bad(409, 'few-rounds');
      const contact = String(b.contact || '').trim().slice(0, 120), note = String(b.note || '').trim().slice(0, 500);
      if (contact.length < 5) return bad(400, 'contact');
      await sql`insert into gs_reviews (username, contact, note) values (${me}, ${contact}, ${note}) on conflict (username) do update set contact = excluded.contact, note = excluded.note, status = 'requested', requested = now()`;
      return ok();
    }
    /* ---- profile settings follow the player to every device ---- */
    if (action === 'prefsGet') {
      const r = await sql`select prefs, prefs_upd from gs_profiles where username = ${me}`;
      const pr = r.length ? (typeof r[0].prefs === 'string' ? JSON.parse(r[0].prefs) : r[0].prefs) : null;
      return ok({ prefs: pr || null, upd: r.length ? Number(r[0].prefs_upd) : 0 });
    }
    if (action === 'prefsSet') {
      const pr = b.prefs && typeof b.prefs === 'object' ? b.prefs : null;
      if (!pr) return bad(400, 'bad-prefs');
      const js = JSON.stringify(pr);
      if (js.length > 30000) return bad(413, 'too-big');
      const upd = Number(b.upd) || Date.now();
      /* setting by setting: each one carries when it was last changed (_t). An incoming setting replaces the stored one only if it is newer, so a device with an old copy cannot bring old settings back */
      const r0 = await sql`select prefs from gs_profiles where username = ${me}`;
      const cur = r0.length && r0[0].prefs ? (typeof r0[0].prefs === 'string' ? JSON.parse(r0[0].prefs) : r0[0].prefs) : null;
      let out = pr;
      if (cur && typeof cur === 'object') {
        const ct = cur._t || {}, it = pr._t || {}, ot = Object.assign({}, ct); out = Object.assign({}, cur);
        for (const k of Object.keys(pr)) { if (k.charAt(0) === '_') continue; const a = Number(it[k]) || 0, c = Number(ct[k]) || 0; if (!(k in cur) || a > c) { out[k] = pr[k]; if (a) ot[k] = a; } }
        out._t = ot; out._upd = Math.max(Number(cur._upd) || 0, upd); delete out._first; delete out._diff;
      }
      const js2 = JSON.stringify(out); if (js2.length > 40000) return bad(413, 'too-big');
      await sql`update gs_profiles set prefs = ${js2}, prefs_upd = ${upd} where username = ${me}`;
      return ok({ upd, prefs: out });
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
      const rec = ['free', 'lite', 'plus', 'pro'].includes(b.recommendation) ? b.recommendation : null;
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
      if (b.plan === 'lite' || b.plan === 'plus' || b.plan === 'pro') await sql`update gs_teams set plan = ${b.plan} where code = ${String(b.code || '').toUpperCase()}`;
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
      if (!['free', 'lite', 'plus', 'pro'].includes(plan) || !L.validUser(target)) return bad(400, 'bad-plan');
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

    /* ---- club history (Digigolf, with their permission): admin finds a player, reads the cards, saves the rounds to a player's account ---- */
    if (action === 'dgSearch' || action === 'dgCards' || action === 'dgSave') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const DG = require('./_digigolf');
      if (action === 'dgSearch') {
        const q = String(b.q || '').trim().slice(0, 60), club = String(b.club || '4').replace(/\D/g, '').slice(0, 5) || '4';
        if (q.length < 3) return bad(400, 'short-query');
        return ok({ rows: await DG.search(club, q, String(b.from || '2018-01-01'), String(b.to || new Date().toISOString().slice(0, 10))) });
      }
      if (action === 'dgCards') {
        const hrefs = (Array.isArray(b.hrefs) ? b.hrefs : []).slice(0, 15), out = [];
        for (const h of hrefs) { try { out.push(Object.assign({ href: h }, await DG.card(String(h)))); } catch (e) { out.push({ href: h, err: String(e.message || e) }); } await new Promise(z => setTimeout(z, 250)); }
        return ok({ cards: out });
      }
      const target = String(b.user || '').trim().toLowerCase(), rounds = Array.isArray(b.rounds) ? b.rounds.slice(0, 400) : [];
      if (!L.validUser(target)) return bad(400, 'bad-user');
      const ex = await sql`select 1 as x from gs_users where username = ${target}`;
      if (!ex.length && !L.FIRST[target]) return bad(404, 'no-such-user');
      const cur = await sql`select rounds from gs_history where username = ${target}`;
      const old = cur.length ? (typeof cur[0].rounds === 'string' ? JSON.parse(cur[0].rounds) : cur[0].rounds) : [];
      const key = r => (r.date || '') + '|' + (r.name || '') + '|' + (r.score || '');
      const map = {}; old.concat(rounds).forEach(r => { if (r && r.date && Array.isArray(r.hs)) map[key(r)] = r; });
      const all = Object.values(map).sort((x, y) => x.date < y.date ? -1 : 1);
      await sql`insert into gs_history (username, rounds, src, upd) values (${target}, ${JSON.stringify(all)}, 'digigolf', ${Date.now()}) on conflict (username) do update set rounds = excluded.rounds, src = excluded.src, upd = excluded.upd`;
      return ok({ saved: all.length, added: all.length - old.length });
    }
    if (action === 'scanStatus' || action === 'scanCard') {   // read a photo of the printed scorecard: a few per day, and only once the reader is switched on
      const SC = require('./_scan'), day = new Date().toISOString().slice(0, 10);
      const u = await sql`select n from gs_scans where username = ${me} and day = ${day}`, used = u.length ? Number(u[0].n) : 0;
      if (action === 'scanStatus') return ok({ ready: SC.ready(), used, limit: SC.LIMIT });
      if (!SC.ready()) return res.status(200).json({ error: 'scan-not-ready', used, limit: SC.LIMIT });
      if (used >= SC.LIMIT) return res.status(200).json({ error: 'scan-limit', used, limit: SC.LIMIT });
      const c = b.ctx && typeof b.ctx === 'object' ? b.ctx : {};
      const ctx = { lang: c.lang === 'es' ? 'es' : 'en', units: c.units === 'm' ? 'm' : 'yd', rows: Math.max(4, Math.min(12, parseInt(c.rows, 10) || 8)), comp: !!c.comp, club: !!c.club, read: !!c.read,
        disp: ['off', 'tee', 'app', 'all'].includes(c.disp) ? c.disp : 'off',
        clubs: (Array.isArray(c.clubs) ? c.clubs : []).slice(0, 20).map(x => ({ code: String(x && x.code || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4), label: String(x && x.label || '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 12) })).filter(x => x.code && x.label) };
      await sql`insert into gs_scans (username, day, n) values (${me}, ${day}, 1) on conflict (username, day) do update set n = gs_scans.n + 1`;   // counted before the read, so a failed photo still uses one
      try { const card = await SC.read(b.image, ctx); return ok({ card, used: used + 1, limit: SC.LIMIT }); }
      catch (e) { return res.status(200).json({ error: e.message || 'reader-failed', used: used + 1, limit: SC.LIMIT }); }
    }
    if (action === 'termsAccept') {   // the player accepted the terms and privacy page: keep the version and the moment
      const v = Math.max(1, Math.min(999, parseInt(b.v, 10) || 1));
      await sql`insert into gs_settings (k, v) values (${'terms:' + me}, ${JSON.stringify({ v, at: new Date().toISOString() })}) on conflict (k) do update set v = excluded.v`;
      return ok({ v });
    }
    if (action === 'myHistory') {   // a player's imported club history (rounds with a score per hole)
      const r = await sql`select rounds, extra, upd from gs_history where username = ${me}`;
      const pj = v => (typeof v === 'string' ? JSON.parse(v) : v);
      if (r.length && b.upd && Number(b.upd) === Number(r[0].upd)) return ok({ same: true });   // the device already has this copy
      return ok({ rounds: r.length ? pj(r[0].rounds) : [], extra: r.length ? (pj(r[0].extra) || null) : null, upd: r.length ? Number(r[0].upd) : 0 });
    }
    if (action === 'historySeed') {   // admin: put a player's history (and their bag and per-hole tendencies) on the server, replacing what was built into the page
      if (me !== L.ADMIN) return bad(403, 'admin');
      const u = String(b.user || '').trim().toLowerCase(); if (!L.validUser(u)) return bad(400, 'bad-user');
      let rounds = (Array.isArray(b.rounds) ? b.rounds : []).filter(r => r && r.date).slice(0, 1500); const extra = b.extra && typeof b.extra === 'object' ? b.extra : null;
      if (JSON.stringify(rounds).length + JSON.stringify(extra || {}).length > 3500000) return bad(413, 'too-big');
      const old = await sql`select rounds from gs_history where username = ${u}`;   // keep what was already imported for them (club history); the seeded round wins on the same day and score
      if (old.length) { const o = typeof old[0].rounds === 'string' ? JSON.parse(old[0].rounds) : (old[0].rounds || []), have = new Set(rounds.map(x => x.date + '|' + x.score)); o.forEach(x => { if (x && x.date && !have.has(x.date + '|' + x.score)) rounds.push(x); }); }
      await sql`insert into gs_history (username, rounds, extra, src, upd) values (${u}, ${JSON.stringify(rounds)}, ${extra ? JSON.stringify(extra) : null}, 'seed', ${Date.now()})
                on conflict (username) do update set rounds = excluded.rounds, extra = coalesce(excluded.extra, gs_history.extra), src = excluded.src, upd = excluded.upd`;
      return ok({ user: u, rounds: rounds.length, extra: !!extra });
    }
    if (action === 'importStatus' || action === 'importRun') {   // admin: the GolfCourseAPI import, run by hand one batch (< 1 minute) at a time
      if (me !== L.ADMIN) return bad(403, 'admin');
      const IMP = require('./cron-courses');
      let run = null;
      if (action === 'importRun') { const key = IMP.keyOf(); if (!key) return bad(503, 'no-key'); run = await IMP.runImport(sql, key, 50000); }
      const r = await sql`select v from gs_settings where k = 'imp_state'`;
      const S = r.length ? JSON.parse(r[0].v) : {};
      const ci = S.ci || 0, today = new Date().toISOString().slice(0, 10);
      return ok({ started: !!r.length, run, last: S.last || null, total: S.total || 0, callsToday: S.day === today ? (S.calls || 0) : 0, cap: IMP.DAY_CAP, queue: (S.queue || []).length,
        searches: S.searches || 0, searchCap: IMP.SEARCH_CAP,
        plan: IMP.PLAN.map((p, i) => ({ country: p[0] + (p[2] ? ' · by club name' : ''), names: p[2] ? p[1].length : 0, status: i < ci ? 'done' : i === ci ? 'current' : 'pending', found: (S.found || {})[p[0]] || 0, per: (S.per || {})[p[0]] || {} })),
        db: (await sql`select code, coalesce(data->'loc'->>'country','') as country from gs_courses where (data->>'empty') is null`).map(x => [x.code, x.country]) });
    }
    if (action === 'gcRun' || action === 'gcStatus' || action === 'gcList') {   // admin: check our courses against GolfCore, and list what we lack
      if (me !== L.ADMIN) return bad(403, 'admin');
      const GC = require('./_golfcore');
      if (action === 'gcRun') return ok({ run: await GC.run(sql, 45000) });
      if (action === 'gcList') return ok({ rows: await GC.list(sql, b.what, b.country, b.limit) });
      return ok(Object.assign({ ready: !!GC.key() }, await GC.status(sql)));
    }
    if (action === 'courseDelete') {   // admin removes a course added to the shared database (a built-in course with the same code comes back)
      if (me !== L.ADMIN) return bad(403, 'admin');
      await sql`delete from gs_courses where code = ${String(b.code || '').toUpperCase().slice(0, 8)}`;
      return ok();
    }

    /* ---- course lookup on demand: a player searches for a course we do not have; it is fetched once, saved for everyone, marked unverified ---- */
    if (action === 'courseFind' || action === 'courseAdopt') {
      const key = String(process.env.GOLFCOURSEAPI_KEY || process.env.GOLF_COURSE_API_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/^(Bearer|Key)\s+/i, '').trim();
      if (!key) return bad(503, 'unavailable');
      const day = new Date().toISOString().slice(0, 10), CAP = me === L.ADMIN ? 500 : 15;   // per-player daily cap
      const used = await sql`select n from gs_lookups where username = ${me} and day = ${day}`;
      if (used.length && used[0].n >= CAP) return bad(429, 'daily-limit');
      await sql`insert into gs_lookups (username, day, n) values (${me}, ${day}, 1) on conflict (username, day) do update set n = gs_lookups.n + 1`;
      const tidy = x => String(x || '').replace(/\t/g, ' ').replace(/^\s*\d{1,4}\s+/, '').replace(/\s+/g, ' ').trim();
      const fullName = (club, course) => { club = tidy(club); let v = tidy(course); if (v.toLowerCase().indexOf(club.toLowerCase()) === 0) v = v.slice(club.length); v = v.replace(/^[\s\-–(]+/, '').replace(/\)\s*$/, '').trim(); return (v ? club + ' — ' + v : club).slice(0, 60); };
      const get = async url => { const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } }); const j = await r.json().catch(() => ({})); return { ok: r.ok, j }; };
      if (action === 'courseFind') {
        const q = String(b.q || '').trim().slice(0, 80);
        if (q.length < 3) return ok({ results: [] });
        const r = await get('https://api.golfcourseapi.com/v1/search?search_query=' + encodeURIComponent(q));
        if (!r.ok) return bad(502, 'unavailable');
        return ok({ results: (r.j.courses || []).slice(0, 12).map(c => ({ id: c.id, name: fullName(c.club_name, c.course_name), where: [c.location && c.location.city, c.location && c.location.country].filter(Boolean).join(', ') })) });
      }
      const R = await CI.adopt(sql, get, b.id, me, fullName);
      if (R.error) return bad(502, R.error);
      return ok(R);
    }

    /* ---- players help complete and verify courses: stroke index, "matches my scorecard", corrections ---- */
    const okSI = a => Array.isArray(a) && a.length === 18 && a.every(x => Number.isInteger(+x) && +x >= 1 && +x <= 18) && new Set(a.map(Number)).size === 18;
    const loadCourse = async code => { const r = await sql`select data from gs_courses where code = ${code}`; return r.length ? (typeof r[0].data === 'string' ? JSON.parse(r[0].data) : r[0].data) : null; };
    const saveCourse = async (code, d) => { await sql`update gs_courses set data = ${JSON.stringify(d)}, upd = ${Date.now()} where code = ${code}`; };
    if (action === 'courseFix') {
      const code = String(b.code || '').toUpperCase().slice(0, 8);
      const d = await loadCourse(code);
      if (!d) return bad(404, 'no-course');
      const hcp = okSI(b.hcp) ? b.hcp.map(Number) : null;
      const confirms = !!b.confirms, note = String(b.note || '').trim().slice(0, 600);
      if (!hcp && !confirms && !note) return bad(400, 'empty');
      const photos = (Array.isArray(b.photos) ? b.photos : []).filter(x => typeof x === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(x) && x.length < 900000).slice(0, 2);
      await sql`delete from gs_course_fixes where code = ${code} and username = ${me} and status = 'pending'`;   // one open contribution per player per course
      const id = 'f' + L.crypto.randomBytes(6).toString('hex');
      await sql`insert into gs_course_fixes (id, code, username, hcp, confirms, note, photos) values (${id}, ${code}, ${me}, ${hcp ? JSON.stringify(hcp) : null}, ${confirms}, ${note}, ${JSON.stringify(photos)})`;
      // a missing stroke index applies at once (the course stays unverified, and the request stays in the admin's list to confirm);
      // every other correction waits for the admin
      if (hcp && d.noSI) { d.hcp = hcp; delete d.noSI; d.siBy = me; await saveCourse(code, d); return ok({ applied: true }); }
      return ok({ pending: true });
    }
    if (action === 'courseFixes') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const rows = await sql`select f.id, f.code, f.username, p.display, f.hcp, f.confirms, f.note, f.photos, f.status, f.created from gs_course_fixes f left join gs_profiles p on p.username = f.username where f.status = 'pending' order by f.created desc`;
      const pj = x => typeof x === 'string' ? JSON.parse(x) : x;
      return ok({ fixes: rows.map(r => Object.assign({}, r, { hcp: pj(r.hcp), photos: pj(r.photos) || [] })) });
    }
    if (action === 'courseFixDecide') {   // admin: accept (apply the stroke index and mark the course verified) or dismiss
      if (me !== L.ADMIN) return bad(403, 'admin');
      const r = await sql`select code, hcp from gs_course_fixes where id = ${String(b.id || '')}`;
      if (!r.length) return bad(404, 'no-fix');
      if (b.accept) {
        const d = await loadCourse(r[0].code), h = typeof r[0].hcp === 'string' ? JSON.parse(r[0].hcp) : r[0].hcp;
        if (d) { if (okSI(h)) { d.hcp = h; delete d.noSI; } if (!d.noSI && b.verify !== false) { delete d.unverified; d.verifiedBy = 'admin'; } await saveCourse(r[0].code, d); }
      }
      await sql`update gs_course_fixes set status = ${b.accept ? 'applied' : 'dismissed'} where id = ${String(b.id)}`;
      return ok();
    }

    /* ---- GolfCourseAPI lookup (admin only; key stays on the server; one course at a time, never bulk) ---- */
    if (action === 'gcaSearch' || action === 'gcaCourse') {
      if (me !== L.ADMIN) return bad(403, 'admin');
      const key = String(process.env.GOLFCOURSEAPI_KEY || process.env.GOLF_COURSE_API_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/^(Bearer|Key)\s+/i, '').trim();   // tolerate a pasted prefix, quotes or spaces
      if (!key) return bad(503, 'no-gca-key');
      const url = action === 'gcaSearch'
        ? 'https://api.golfcourseapi.com/v1/search?search_query=' + encodeURIComponent(String(b.q || '').slice(0, 80))
        : 'https://api.golfcourseapi.com/v1/courses/' + encodeURIComponent(String(b.id || '').replace(/[^0-9a-zA-Z_-]/g, ''));
      let r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
      if (r.status === 401) r = await fetch(url, { headers: { Authorization: 'Key ' + key, Accept: 'application/json' } });   // legacy format, in case
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'gca', status: r.status, message: ((j && (j.message || j.error)) || '') + (r.status === 401 ? ' [key in Vercel: ' + key.length + ' characters, starts "' + key.slice(0, 2) + '", ends "' + key.slice(-2) + '"' + (/[^A-Za-z0-9]/.test(key) ? ', contains a space or symbol' : '') + ']' : '') });
      const loc = c => [c.location && c.location.city, c.location && c.location.state, c.location && c.location.country].filter(Boolean).join(', ');
      if (action === 'gcaSearch') return ok({ total: (j.courses || []).length, usa: (j.courses || []).filter(c => /united states|^usa?$/i.test((c.location && c.location.country) || '')).length, results: (j.courses || []).slice(0, 20).map(c => ({ id: c.id, club: c.club_name, course: c.course_name, where: loc(c) })) });
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
      const cl0 = x => String(x || '').replace(/[<>"]/g, '').trim().slice(0, 40);
      if (c.empty) {   // placeholder: a club we know exists but have no card data for; players send the scorecard
        if (code.length < 2 || String(c.name || '').trim().length < 3) return bad(400, 'bad-course');
        const ex0 = await sql`select code from gs_courses where code = ${code}`;
        if (ex0.length && !b.edit) return res.status(409).json({ error: 'exists', code });
        const stub = { name: String(c.name).trim().slice(0, 60), empty: true, unverified: true, loc: c.loc && typeof c.loc === 'object' ? { country: cl0(c.loc.country), state: cl0(c.loc.state), city: cl0(c.loc.city) } : undefined };
        await sql`insert into gs_courses (code, data, upd) values (${code}, ${JSON.stringify(stub)}, ${Date.now()}) on conflict (code) do update set data = excluded.data, upd = excluded.upd`;
        return ok({ code });
      }
      const noSI = !!c.noSI;   // imported without a stroke index: net par stays off for this course until it is entered
      if (code.length < 2 || String(c.name || '').trim().length < 3 || !okArr(c.par, 3, 6) || (!noSI && (!okArr(c.hcp, 1, 18) || new Set(c.hcp.map(Number)).size !== 18))) return bad(400, 'bad-course');
      const tees = {};
      Object.keys(c.tees || {}).slice(0, 8).forEach(k => { const t = c.tees[k] || {}; const key = String(k).replace(/[^A-Za-zÀ-ÿ0-9 ]/g, '').slice(0, 20);
        if (key && okArr(t.yds, 40, 800) && Number.isFinite(+t.cr) && Number.isFinite(+t.slope)) tees[key] = { label: String(t.label || key).slice(0, 40), cr: +t.cr, slope: +t.slope, est: false, yds: t.yds.map(Number) }; });
      if (!Object.keys(tees).length) return bad(400, 'no-tees');
      // never create a second copy: a new course may not reuse a code, or the name of a course already added
      const nk = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !['golf', 'club', 'de', 'del', 'el', 'la', 'los', 'las', 'country', 'the', 'gc', 'cc', 'course', 'y', 'and'].includes(w)).sort().join(' ');
      if (!b.edit) {
        const all = await sql`select code, data from gs_courses`;
        const pd = r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
        const stubs = all.filter(r => pd(r).empty && nk(pd(r).name) === nk(c.name));
        for (const st of stubs) await sql`delete from gs_courses where code = ${st.code}`;   // real data replaces the placeholder
        const hit = all.find(r => !pd(r).empty && (r.code === code || nk(pd(r).name) === nk(c.name)));
        if (hit && !b.force) return res.status(409).json({ error: 'exists', code: hit.code });
      }
      const cl = x => String(x || '').replace(/[<>"]/g, '').trim().slice(0, 40);
      const loc = c.loc && typeof c.loc === 'object' ? { country: cl(c.loc.country), state: cl(c.loc.state), city: cl(c.loc.city) } : undefined;
      const data = { name: String(c.name).trim().slice(0, 60), loc, unverified: !!c.unverified, noSI: noSI || undefined, abbr: code, pins: c.pins || { F: 'red', M: 'white', B: 'blue' }, par: c.par.map(Number), hcp: noSI ? c.par.map(() => 0) : c.hcp.map(Number), tees };
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
      await sql`delete from gs_course_fixes where username = ${me}`;
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
      await sql`delete from gs_history where username = ${me}`; await sql`delete from gs_usage where username = ${me}`; await sql`delete from gs_settings where k = ${'terms:' + me}`;
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
