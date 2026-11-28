// GolfCore course data (https://www.golfcore.org/developers/): a second source, used here to check the courses Golfimbul already holds
// and to list the ones it lacks. Needs GOLFCORE_API_KEY in the project's environment. Their terms: credit GolfCore and link the course page;
// the data may be stored for this app, never passed on. Every response fetched is kept (gs_gc_index, gs_gc_detail) so nothing is asked twice.

const BASE = 'https://api.golfcore.org/v1';
const key = () => String(process.env.GOLFCORE_API_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
const LATER = ['us', 'ca'];      // United States and Canada: left for a later run
const GAP_MS = 1100;            // Starter plan: 60 requests a minute
const ISO = { 'argentina': 'ar', 'uruguay': 'uy', 'chile': 'cl', 'paraguay': 'py', 'bolivia': 'bo', 'brazil': 'br', 'brasil': 'br', 'peru': 'pe', 'ecuador': 'ec', 'colombia': 'co', 'venezuela': 've',
  'panama': 'pa', 'costa rica': 'cr', 'nicaragua': 'ni', 'honduras': 'hn', 'el salvador': 'sv', 'guatemala': 'gt', 'belize': 'bz', 'dominican republic': 'do', 'puerto rico': 'pr', 'cuba': 'cu',
  'jamaica': 'jm', 'bahamas': 'bs', 'mexico': 'mx', 'united states': 'us', 'usa': 'us', 'united states of america': 'us', 'canada': 'ca', 'spain': 'es', 'portugal': 'pt' };
const strip = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const iso = c => ISO[strip(c).trim()] || null;
const GENERIC = ['golf', 'golfe', 'club', 'clube', 'de', 'del', 'do', 'da', 'el', 'la', 'los', 'las', 'country', 'the', 'gc', 'cc', 'course', 'y', 'and', 'e', 'at', 'of', 'resort', 'links', 'campo', 'campestre', 'x2', '9'];
const toks = x => strip(x).replace(/^\s*\d{1,4}\s+/, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !GENERIC.includes(w));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pj = v => (typeof v === 'string' ? JSON.parse(v) : v);

async function init(sql) {
  await sql`create table if not exists gs_gc_index (slug text primary key, country text not null, name text, city text, region text, d jsonb)`;
  await sql`create table if not exists gs_gc_detail (slug text primary key, d jsonb not null, at bigint not null default 0)`;
  await sql`create table if not exists gs_gc_cmp (code text primary key, slug text, country text, r jsonb not null)`;
}

/* how one of our courses reads against one GolfCore course: the pair of tees whose hole yardages are closest decides */
function compare(ours, d) {
  const op = ours.par || [], OT = Object.keys(ours.tees || {}).map(k => Object.assign({ k }, ours.tees[k])).filter(t => Array.isArray(t.yds) && t.yds.length === 18);
  const twice = OT.length && OT.every(t => t.yds.slice(0, 9).join() === t.yds.slice(9).join());   // a 9-hole card played twice
  let best = null;
  (d.layouts || []).forEach(L => (L.tees || []).forEach(t => {
    let H = (t.holes || []).slice().sort((a, b) => a.position - b.position); if (!H.length || H.some(h => h.yards == null)) return;
    if (H.length === 9 && twice) H = H.concat(H);
    if (H.length !== 18) return;
    OT.forEach(o => { const diff = H.reduce((s, h, i) => s + Math.abs(h.yards - o.yds[i]), 0), exact = H.filter((h, i) => h.yards === o.yds[i]).length;
      if (!best || exact > best.exact || (exact === best.exact && diff < best.diff))
        best = { diff, exact, parDiff: H.filter((h, i) => h.par != null && op[i] != null && h.par !== op[i]).length, cr: [o.cr || null, t.rating || null], sl: [o.slope || null, t.slope || null], tee: [o.k, t.name + (t.gender ? ' ' + t.gender : '')] }; });
  }));
  if (!OT.length) return { v: 'ours-empty' };
  if (!best) return { v: 'no-holes' };          // GolfCore has the course but no complete hole card
  const v = best.exact < 9 ? 'other'             // fewer than half the holes agree: a different course or layout, not a typo
    : best.parDiff ? 'par' : best.diff === 0 ? 'same' : best.diff <= 60 ? 'close' : 'yards';
  return Object.assign({ v }, best);
}

async function run(sql, runMs) {
  const k = key(); if (!k) return { error: 'no-golfcore-key' };
  await init(sql);
  const t0 = Date.now(), row = await sql`select v from gs_settings where k = 'gc_state'`;
  const S = row.length ? JSON.parse(row[0].v) : { phase: 'index', ci: 0, off: 0, last: '', req: 0, countries: null };
  let lastReq = 0;
  const get = async path => { const w = GAP_MS - (Date.now() - lastReq); if (w > 0) await sleep(w); lastReq = Date.now(); S.req++;
    const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + k, Accept: 'application/json', 'User-Agent': 'Golfimbul/1.0 (+https://golfimbul.vercel.app)' } });
    if (r.status === 429) return { limited: true, retry: +r.headers.get('retry-after') || 60 };
    return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})), left: r.headers.get('x-ratelimit-remaining') }; };
  const out = { indexed: 0, compared: 0 };
  if (!S.countries) { const cs = await sql`select distinct lower(coalesce(data->'loc'->>'country','')) as c from gs_courses where (data->>'empty') is null`; S.countries = Array.from(new Set(cs.map(x => iso(x.c)).filter(Boolean))).filter(c => !LATER.includes(c)).sort(); }
  while (Date.now() - t0 < runMs && S.phase !== 'done') {
    if (S.phase === 'index') {                   // every GolfCore course of each country we hold: 200 per request
      if (S.ci >= S.countries.length) { S.phase = 'match'; S.last = ''; continue; }
      const c = S.countries[S.ci], r = await get('/courses?country=' + c + '&limit=200&offset=' + S.off);
      if (r.limited) { out.limited = r.retry; break; } if (!r.ok) { out.error = 'golfcore-' + r.status; break; }
      const L = (r.j.courses || []).map(x => ({ slug: x.slug, country: c, name: x.name || '', city: x.city || '', region: x.region || '', d: { url: x.url, par_total: x.par_total, hole_count: x.hole_count, lat: x.lat, lng: x.lng, coverage: x.coverage || {} } }));
      if (L.length) await sql`insert into gs_gc_index (slug, country, name, city, region, d) select slug, country, name, city, region, d from jsonb_to_recordset(${JSON.stringify(L)}::jsonb) as x(slug text, country text, name text, city text, region text, d jsonb) on conflict (slug) do update set name = excluded.name, city = excluded.city, region = excluded.region, d = excluded.d`;
      out.indexed += L.length; S.off += L.length;
      if (!L.length || S.off >= (r.j.total || 0)) { S.ci++; S.off = 0; }
      continue;
    }
    /* match: each of our courses against the GolfCore courses of its country that share its most distinctive word */
    const mine = await sql`select code, data from gs_courses where (data->>'empty') is null and code > ${S.last} order by code limit 15`;
    if (!mine.length) { S.phase = 'done'; break; }
    for (const m of mine) {
      if (Date.now() - t0 >= runMs) break;
      const o = pj(m.data), c = iso(o.loc && o.loc.country), T = toks(o.name), keyW = T.slice().sort((a, b) => b.length - a.length)[0] || '';
      if (!c || LATER.includes(c)) { S.last = m.code; continue; }
      let res = { v: 'no-match' }, slug = null;
      if (c && keyW.length >= 3) {
        const cand = await sql`select slug, name, city, d from gs_gc_index where country = ${c} and translate(lower(name), 'áàâãäéèêëíìîïóòôõöúùûüñç', 'aaaaaeeeeiiiiooooouuuunc') like ${'%' + keyW + '%'} limit 60`;
        const city = strip(o.loc && o.loc.city).trim(), TS = new Set(T);
        const scored = cand.map(x => { const X = toks(x.name), inter = X.filter(w => TS.has(w)).length, j = inter / Math.max(1, new Set(X.concat(T)).size), xc = strip(x.city);
          return { x, s: j + (city && xc && (xc.indexOf(city) >= 0 || city.indexOf(xc) >= 0) ? 0.35 : 0) }; }).filter(y => y.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, 3);
        let limited = false;
        for (const y of scored) {                // up to three candidates: a club with several courses is one name, many cards
          let det = await sql`select d from gs_gc_detail where slug = ${y.x.slug}`, d = det.length ? pj(det[0].d) : null;
          if (!d) { const r = await get('/courses/' + encodeURIComponent(y.x.slug)); if (r.limited) { out.limited = r.retry; limited = true; break; } if (!r.ok) continue; d = r.j;
            await sql`insert into gs_gc_detail (slug, d, at) values (${y.x.slug}, ${JSON.stringify(d)}, ${Date.now()}) on conflict (slug) do update set d = excluded.d, at = excluded.at`; }
          const cmp = compare(o, d); cmp.gc = y.x.name; cmp.url = (pj(y.x.d) || {}).url || null;
          const rank = v => ({ same: 6, close: 5, par: 4, yards: 3, other: 2, 'no-holes': 1 }[v] || 0);
          if (slug == null || rank(cmp.v) > rank(res.v) || (rank(cmp.v) === rank(res.v) && (cmp.exact || 0) > (res.exact || 0))) { res = cmp; slug = y.x.slug; }
          if (cmp.v === 'same') break;
        }
        if (limited) break;
      }
      res.name = o.name; res.city = (o.loc && o.loc.city) || ''; res.unverified = !!o.unverified;
      await sql`insert into gs_gc_cmp (code, slug, country, r) values (${m.code}, ${res.v === 'no-match' ? null : slug}, ${c || ''}, ${JSON.stringify(res)}) on conflict (code) do update set slug = excluded.slug, country = excluded.country, r = excluded.r`;
      S.last = m.code; out.compared++;
    }
    if (out.limited) break;
  }
  await sql`insert into gs_settings (k, v) values ('gc_state', ${JSON.stringify(S)}) on conflict (k) do update set v = excluded.v`;
  return Object.assign(out, { phase: S.phase, country: S.countries[S.ci] || null, requests: S.req, last: S.last });
}

async function status(sql) {
  await init(sql);
  const row = await sql`select v from gs_settings where k = 'gc_state'`, S = row.length ? JSON.parse(row[0].v) : null;
  const verdicts = await sql`select country, r->>'v' as v, count(*)::int as n from gs_gc_cmp group by 1, 2 order by 1, 2`;
  /* GolfCore courses with a hole-by-hole card that none of ours matched: what we lack, country by country */
  const cover = await sql`select i.country, count(*)::int as total, (count(*) filter (where (i.d->'coverage'->>'scorecard') = 'true'))::int as cards,
      (count(*) filter (where m.slug is not null))::int as matched, (count(*) filter (where m.slug is null and (i.d->'coverage'->>'scorecard') = 'true'))::int as missing
    from gs_gc_index i left join (select distinct slug from gs_gc_cmp where slug is not null and r->>'v' in ('same','close','par','yards')) m on m.slug = i.slug group by 1 order by 1`;
  const mine = await sql`select count(*)::int as n from gs_courses where (data->>'empty') is null`;
  return { state: S && { phase: S.phase, requests: S.req, countries: S.countries, ci: S.ci, last: S.last }, ours: mine[0].n, verdicts, cover };
}

async function list(sql, what, country, limit) {
  await init(sql); const n = Math.max(1, Math.min(300, parseInt(limit, 10) || 100)), c = String(country || '').toLowerCase().slice(0, 2);
  if (what === 'missing') return (await sql`select i.name, i.city, i.region, i.d->>'url' as url from gs_gc_index i where i.country = ${c} and (i.d->'coverage'->>'scorecard') = 'true'
      and not exists (select 1 from gs_gc_cmp m where m.slug = i.slug and m.r->>'v' in ('same','close','par','yards')) order by i.name limit ${n}`);
  return (await sql`select code, slug, country, r from gs_gc_cmp where r->>'v' = ${String(what || 'par')} and (${c} = '' or country = ${c}) order by code limit ${n}`).map(x => Object.assign({ code: x.code, slug: x.slug, country: x.country }, pj(x.r)));
}

module.exports = { run, status, list, compare, key, iso };
