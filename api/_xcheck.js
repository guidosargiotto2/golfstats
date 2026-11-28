// Cross-check: the courses imported from GolfCore, read against GolfCourseAPI (the second source), hole by hole.
// One search and at most two course reads per course, inside GolfCourseAPI's limits as agreed: 6,000 calls a day and 7,000 searches in all
// (the searches already spent by the name import count toward the same 7,000).
const GC = require('./_golfcore');
const SEARCH_CAP = 7000, DAY_CAP = 6000, PAUSE_MS = 320;
const EUROPE = ['United Kingdom', 'Ireland', 'Spain', 'Portugal', 'France', 'Italy', 'Germany', 'Netherlands', 'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Denmark', 'Sweden', 'Norway', 'Finland', 'Iceland', 'Poland', 'Czechia', 'Slovakia', 'Hungary', 'Slovenia', 'Croatia', 'Greece', 'Türkiye', 'Bulgaria', 'Romania', 'Estonia', 'Latvia', 'Lithuania', 'Cyprus', 'Malta', 'Isle of Man', 'Jersey', 'Guernsey', 'Serbia', 'Andorra'];
const strip = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const GENERIC = ['golf', 'golfe', 'club', 'clube', 'de', 'del', 'do', 'da', 'el', 'la', 'le', 'les', 'du', 'des', 'di', 'los', 'las', 'country', 'the', 'gc', 'cc', 'course', 'y', 'and', 'e', 'at', 'of', 'resort', 'links', 'park', 'golfclub', 'golfbaan', 'golfklubb', 'gk', 'ev', 'x2', '9', 'standard'];
const toks = x => strip(x).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !GENERIC.includes(w));
const UK = ['united kingdom', 'england', 'scotland', 'wales', 'northern ireland', 'great britain', 'uk'];
const ALIAS = { 'turkiye': ['turkey', 'turkiye'], 'czechia': ['czechia', 'czech republic'], 'netherlands': ['netherlands', 'holland', 'the netherlands'], 'ireland': ['ireland', 'republic of ireland'] };
const sameCountry = (ours, theirs) => { const a = strip(ours).trim(), b = strip(theirs).trim(); if (a === 'united kingdom') return UK.includes(b); return a === b || (ALIAS[a] || []).includes(b); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pj = v => (typeof v === 'string' ? JSON.parse(v) : v);

async function init(sql) { await sql`create table if not exists gs_xc (code text primary key, gca text, country text, r jsonb not null)`; }

/* their course in the shape GolfCore's compare() reads: one layout, a tee per tee with its holes */
const shape = c => ({ layouts: [{ tees: [].concat((c.tees && c.tees.male) || []).map(t => Object.assign({ g: 'M' }, t)).concat(((c.tees && c.tees.female) || []).map(t => Object.assign({ g: 'F' }, t)))
  .map(t => ({ name: t.tee_name || 'Tee', gender: t.g, rating: t.course_rating, slope: t.slope_rating, holes: (t.holes || []).map((h, i) => ({ position: i + 1, par: h.par, yards: h.yardage })) })) }] });

async function run(sql, key, runMs) {
  await init(sql); const t0 = Date.now(), day = new Date().toISOString().slice(0, 10);
  const row = await sql`select v from gs_settings where k = 'xc_state'`, S = row.length ? JSON.parse(row[0].v) : { day: '', calls: 0, searches: 0, done: 0 };
  const imp = await sql`select v from gs_settings where k = 'imp_state'`, I = imp.length ? JSON.parse(imp[0].v) : {};
  if (S.day !== day) { S.day = day; S.calls = 0; }
  const impCalls = I.day === day ? (I.calls || 0) : 0, out = { checked: 0, searches: 0 };
  const room = () => S.calls + impCalls < DAY_CAP && (S.searches + (I.searches || 0)) < SEARCH_CAP;
  const get = async url => { S.calls++; const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } }); const j = await r.json().catch(() => ({})); await sleep(PAUSE_MS); return { ok: r.ok, status: r.status, j }; };
  while (Date.now() - t0 < runMs && room()) {
    const L = await sql`select c.code, c.data from gs_courses c where c.data->>'src' = 'golfcore' and c.data->'loc'->>'country' = any(${EUROPE}::text[]) and not exists (select 1 from gs_xc x where x.code = c.code)
        order by array_position(${EUROPE}::text[], c.data->'loc'->>'country'), c.code limit 12`;
    if (!L.length) { out.finished = true; break; }
    let stop = false;
    for (const m of L) {
      if (Date.now() - t0 >= runMs || !room()) { stop = true; break; }
      const o = pj(m.data), base = String(o.name || '').split(' — ')[0].replace(/\(9 x2\)/, ''), T = toks(base), TS = new Set(toks(o.name));
      let res = { v: 'no-match' }, gid = null;
      if (T.length) {
        const q = T.slice().sort((a, b) => b.length - a.length).slice(0, 2).sort((a, b) => base.toLowerCase().indexOf(a) - base.toLowerCase().indexOf(b)).join(' ');
        const r = await get('https://api.golfcourseapi.com/v1/search?search_query=' + encodeURIComponent(q)); S.searches++; out.searches++;
        if (r.status === 429) { out.limited = true; stop = true; break; }
        const city = strip(o.loc && o.loc.city).trim();
        const cand = ((r.ok && r.j.courses) || []).filter(c => sameCountry(o.loc.country, c.location && c.location.country)).map(c => { const X = toks((c.club_name || '') + ' ' + (c.course_name || '')), inter = X.filter(w => TS.has(w)).length, xc = strip(c.location && c.location.city);
          return { c, s: inter / Math.max(1, new Set(X.concat(Array.from(TS))).size) + (city && xc && (xc.indexOf(city) >= 0 || city.indexOf(xc) >= 0) ? 0.35 : 0) }; }).filter(y => y.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, 2);
        const rank = v => ({ same: 6, close: 5, par: 4, yards: 3, other: 2, 'no-holes': 1 }[v] || 0);
        for (const y of cand) { if (!room()) break;
          const d = await get('https://api.golfcourseapi.com/v1/courses/' + encodeURIComponent(String(y.c.id))); if (!d.ok) continue;
          const c = d.j.course || d.j, cmp = GC.compare(o, shape(c)); cmp.gca = ((c.club_name || '') + (c.course_name && c.course_name !== c.club_name ? ' — ' + c.course_name : '')).slice(0, 70);
          if (gid == null || rank(cmp.v) > rank(res.v) || (rank(cmp.v) === rank(res.v) && (cmp.exact || 0) > (res.exact || 0))) { res = cmp; gid = String(y.c.id); }
          if (cmp.v === 'same') break; }
      }
      res.name = o.name; res.city = (o.loc && o.loc.city) || ''; res.url = o.gcUrl || null;
      await sql`insert into gs_xc (code, gca, country, r) values (${m.code}, ${gid}, ${(o.loc && o.loc.country) || ''}, ${JSON.stringify(res)}) on conflict (code) do update set gca = excluded.gca, country = excluded.country, r = excluded.r`;
      out.checked++; S.done = (S.done || 0) + 1;
    }
    if (stop) break;
  }
  if (!room()) out.capped = (S.searches + (I.searches || 0)) >= SEARCH_CAP ? 'searches' : 'day';
  await sql`insert into gs_settings (k, v) values ('xc_state', ${JSON.stringify(S)}) on conflict (k) do update set v = excluded.v`;
  return Object.assign(out, { done: S.done || 0, callsToday: S.calls + impCalls, searchesTotal: S.searches + (I.searches || 0) });
}

async function status(sql) {
  await init(sql);
  const verdicts = await sql`select country, r->>'v' as v, count(*)::int as n from gs_xc group by 1, 2 order by 1, 2`;
  const left = await sql`select count(*)::int as n from gs_courses c where c.data->>'src' = 'golfcore' and c.data->'loc'->>'country' = any(${EUROPE}::text[]) and not exists (select 1 from gs_xc x where x.code = c.code)`;
  const row = await sql`select v from gs_settings where k = 'xc_state'`;
  return { state: row.length ? JSON.parse(row[0].v) : null, left: left[0].n, verdicts };
}
async function list(sql, what, limit) { await init(sql); const n = Math.max(1, Math.min(400, parseInt(limit, 10) || 100));
  return (await sql`select code, country, r from gs_xc where r->>'v' = ${String(what || 'par')} order by country, code limit ${n}`).map(x => Object.assign({ code: x.code, country: x.country }, pj(x.r))); }

module.exports = { run, status, list };
