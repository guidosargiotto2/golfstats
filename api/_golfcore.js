// GolfCore course data (https://www.golfcore.org/developers/): a second source, used here to check the courses Golfimbul already holds
// and to list the ones it lacks. Needs GOLFCORE_API_KEY in the project's environment. Their terms: credit GolfCore and link the course page;
// the data may be stored for this app, never passed on. Every response fetched is kept (gs_gc_index, gs_gc_detail) so nothing is asked twice.

const BASE = 'https://api.golfcore.org/v1';
const key = () => String(process.env.GOLFCORE_API_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
const LATER = ['us', 'ca'];      // United States and Canada: left for a later run
const IMPORT_LATER = ['us', 'ca'];   // importing: every country but the United States and Canada for now
const CAP_DEFAULT = 9800;         // requests a month we stay under unless the owner raises it (Starter includes 10,000; beyond that is billed)
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


/* ---- fill what ours lacks, from the GolfCore course it matched hole for hole: the stroke index, and the link GolfCore's terms ask for ---- */
async function fill(sql) {
  await init(sql); const out = { checked: 0, si: 0, link: 0 };
  const rows = await sql`select m.code, m.r, c.data, d.d from gs_gc_cmp m join gs_courses c on c.code = m.code join gs_gc_detail d on d.slug = m.slug where m.r->>'v' in ('same', 'close')`;
  for (const x of rows) { out.checked++;
    const o = pj(x.data), d = pj(x.d), r = pj(x.r); let ch = false;
    if (!o.gcUrl && d.url) { o.gcUrl = d.url; ch = true; out.link++; }
    const noSI = o.noSI || !(o.hcp || []).some(v => v > 0);
    if (noSI) { const tn = (r.tee || [])[1] || ''; let si = null;
      (d.layouts || []).forEach(L => { if (si) return; const hit = (L.tees || []).some(t => (t.name + (t.gender ? ' ' + t.gender : '')) === tn); if (!hit) return;
        const H = (L.holes || []).slice().sort((a, b) => a.position - b.position).map(h => h.stroke_index);
        if (H.length === 18 && H.every(v => Number.isInteger(v) && v >= 1 && v <= 18) && new Set(H).size === 18) si = H; });
      if (si) { o.hcp = si; delete o.noSI; o.siFrom = 'golfcore'; ch = true; out.si++; } }
    if (ch) await sql`update gs_courses set data = ${JSON.stringify(o)}, upd = ${Date.now()} where code = ${x.code}`;
  }
  return out;
}

/* ---- a GolfCore course as Golfimbul stores courses: one per layout, only tees whose own hole pars agree with the layout's card ---- */
const NAME = { ar: 'Argentina', uy: 'Uruguay', cl: 'Chile', py: 'Paraguay', bo: 'Bolivia', br: 'Brazil', pe: 'Peru', ec: 'Ecuador', co: 'Colombia', ve: 'Venezuela', pa: 'Panama', cr: 'Costa Rica', ni: 'Nicaragua', hn: 'Honduras',
  sv: 'El Salvador', gt: 'Guatemala', bz: 'Belize', do: 'Dominican Republic', pr: 'Puerto Rico', cu: 'Cuba', jm: 'Jamaica', bs: 'Bahamas', mx: 'Mexico', us: 'United States', ca: 'Canada', es: 'Spain', pt: 'Portugal' };
let DN = null; const countryName = c => { c = String(c || '').toLowerCase(); if (NAME[c]) return NAME[c]; try { DN = DN || new Intl.DisplayNames(['en'], { type: 'region' }); return DN.of(c.toUpperCase()) || c.toUpperCase(); } catch (e) { return c.toUpperCase(); } };
const tidy = x => String(x || '').replace(/^\s*\d{1,4}\s+/, '').replace(/\s+/g, ' ').trim();
function convert(d) {
  const res = [], many = (d.layouts || []).length > 1;
  (d.layouts || []).forEach(L => {
    let LH = (L.holes || []).slice().sort((a, b) => a.position - b.position); const nine = LH.length === 9; if (nine) LH = LH.concat(LH);
    if (LH.length !== 18 || !LH.every(h => h.par >= 3 && h.par <= 6)) return;
    const par = LH.map(h => h.par), si0 = nine ? [] : LH.map(h => h.stroke_index), okS = si0.length === 18 && si0.every(v => Number.isInteger(v) && v >= 1 && v <= 18) && new Set(si0).size === 18;
    const tees = {}, rated = (L.tees || []).filter(t => t.rating > 20 && t.slope >= 55 && t.yards);
    (L.tees || []).forEach(t => { let H = (t.holes || []).slice().sort((a, b) => a.position - b.position); if (H.length === 9 && nine) H = H.concat(H);
      if (H.length !== 18 || !H.every(h => h.yards >= 40 && h.yards <= 800)) return;
      if (H.some((h, i) => h.par != null && h.par !== par[i])) return;                    // this tee's holes belong to another card: leave it out
      const yds = H.map(h => h.yards), tot = yds.reduce((a, b) => a + b, 0); let cr = t.rating > 20 ? t.rating : null, sl = t.slope >= 55 ? t.slope : null, est = false;
      if (cr && nine && cr < 50) cr = Math.round(cr * 20) / 10;
      if (!cr || !sl) { const near = rated.filter(r => (r.gender || 'M') !== 'F' && Math.abs(r.yards - (nine ? tot / 2 : tot)) <= 40).sort((a, b) => Math.abs(a.yards - tot) - Math.abs(b.yards - tot))[0];
        if (near) { cr = nine && near.rating < 50 ? Math.round(near.rating * 20) / 10 : near.rating; sl = near.slope; est = true; }   // borrowed from the rated tee of the same length: close, not official
        else { cr = Math.round((tot / 220 + 40.9) * 10) / 10; sl = 113; est = true; } }           // the standard yardage rating when no rating is published
      let nm = String(t.name || 'Tee').replace(/[^A-Za-zÀ-ÿ0-9 ]/g, '').trim().slice(0, 20) || 'Tee'; if (t.gender === 'F' && !/damas|ladies|women/i.test(nm)) nm += ' Damas';
      if (tees[nm]) return; tees[nm] = { label: nm, cr, slope: sl, est, yds }; });
    if (!Object.keys(tees).length) {            // no tee carries its own holes: the course's reference card is better than no course, marked as an estimate
      const yds = LH.map(h => h.yards); if (!yds.every(v => v >= 40 && v <= 800)) return;
      const tot = yds.reduce((a, b) => a + b, 0), near = rated.filter(r => (r.gender || 'M') !== 'F').sort((a, b) => Math.abs(a.yards - (nine ? tot / 2 : tot)) - Math.abs(b.yards - (nine ? tot / 2 : tot)))[0];
      const ok = near && Math.abs(near.yards - (nine ? tot / 2 : tot)) <= 40;
      tees.Standard = { label: 'Standard', cr: ok ? (nine && near.rating < 50 ? Math.round(near.rating * 20) / 10 : near.rating) : Math.round((tot / 220 + 40.9) * 10) / 10, slope: ok ? near.slope : 113, est: true, yds }; }
    const nm = tidy(d.name), ln = tidy(L.name);
    res.push({ name: ((many && ln && strip(ln) !== strip(nm) ? nm + ' — ' + ln : nm) + (nine ? ' (9 x2)' : '')).slice(0, 60), loc: { country: countryName(d.country), state: String(d.region || '').slice(0, 40), city: String(d.city || '').slice(0, 40) },
      unverified: true, noSI: okS ? undefined : true, addedBy: 'golfcore', src: 'golfcore', gcUrl: d.url || null, pins: { F: 'red', M: 'white', B: 'blue' }, par, hcp: okS ? si0 : par.map(() => 0), tees });
  });
  return res;
}

/* the month's usage as GolfCore counts it, against the cap we keep (gs_settings 'gc_cap', or the default) */
async function budget(sql, k) {
  const c = await sql`select v from gs_settings where k = 'gc_cap'`, cap = c.length ? (parseInt(c[0].v, 10) || CAP_DEFAULT) : CAP_DEFAULT;
  const r = await fetch(BASE + '/usage', { headers: { Authorization: 'Bearer ' + k, Accept: 'application/json', 'User-Agent': 'Golfimbul/1.0 (+https://golfimbul.vercel.app)' } });
  const j = r.ok ? await r.json().catch(() => ({})) : {};
  return { cap, consumed: j.consumed == null ? null : +j.consumed, included: j.included || null, plan: j.plan || null, left: j.consumed == null ? null : cap - (+j.consumed) };
}

/* ---- the whole GolfCore library as a list (200 a request): which courses exist, where, and whether they carry a hole card ---- */
async function indexAll(sql, runMs) {
  const k = key(); if (!k) return { error: 'no-golfcore-key' };
  await init(sql); const t0 = Date.now(), out = { indexed: 0, requests: 0 };
  const B = await budget(sql, k); out.budget = B; if (B.left != null && B.left <= 0) return Object.assign(out, { capped: true });
  const row = await sql`select v from gs_settings where k = 'gc_idx'`, S = row.length ? JSON.parse(row[0].v) : { off: 0, total: null };
  let lastReq = 0, room = B.left == null ? 1e9 : B.left;
  while (Date.now() - t0 < runMs && !S.done && room > 0) {
    const w = GAP_MS - (Date.now() - lastReq); if (w > 0) await sleep(w); lastReq = Date.now(); out.requests++; room--;
    const r = await fetch(BASE + '/courses?limit=200&offset=' + S.off, { headers: { Authorization: 'Bearer ' + k, Accept: 'application/json', 'User-Agent': 'Golfimbul/1.0 (+https://golfimbul.vercel.app)' } });
    if (r.status === 429) { out.limited = +r.headers.get('retry-after') || 60; break; } if (!r.ok) { out.error = 'golfcore-' + r.status; break; }
    const j = await r.json().catch(() => ({})), L = (j.courses || []).map(x => ({ slug: x.slug, country: String(x.country || '').toLowerCase(), name: x.name || '', city: x.city || '', region: x.region || '', d: { url: x.url, par_total: x.par_total, hole_count: x.hole_count, lat: x.lat, lng: x.lng, coverage: x.coverage || {} } }));
    if (L.length) await sql`insert into gs_gc_index (slug, country, name, city, region, d) select slug, country, name, city, region, d from jsonb_to_recordset(${JSON.stringify(L)}::jsonb) as x(slug text, country text, name text, city text, region text, d jsonb) on conflict (slug) do update set name = excluded.name, city = excluded.city, region = excluded.region, d = excluded.d`;
    out.indexed += L.length; S.off += L.length; S.total = j.total || S.total;
    if (!L.length || (S.total && S.off >= S.total)) S.done = true;
  }
  await sql`insert into gs_settings (k, v) values ('gc_idx', ${JSON.stringify(S)}) on conflict (k) do update set v = excluded.v`;
  return Object.assign(out, { off: S.off, total: S.total, finished: !!S.done });
}

/* ---- bring in the courses GolfCore has with a hole card and we lack (one request each), country by country ---- */
const EUROPE = ['gb', 'ie', 'es', 'pt', 'fr', 'it', 'de', 'nl', 'be', 'lu', 'ch', 'at', 'dk', 'se', 'no', 'fi', 'is', 'pl', 'cz', 'sk', 'hu', 'si', 'hr', 'gr', 'tr', 'bg', 'ro', 'ee', 'lv', 'lt', 'cy', 'mt', 'rs', 'ba', 'me', 'mk', 'al', 'ad', 'mc', 'li', 'sm', 'je', 'gg', 'im', 'fo', 'ua', 'md'];
async function importMissing(sql, runMs, reset, scope) {
  const only = scope === 'europe' ? EUROPE : null;
  const k = key(); if (!k) return { error: 'no-golfcore-key' };
  await init(sql); const t0 = Date.now(), out = { added: 0, nodata: 0, existed: 0, requests: 0 };
  const B = await budget(sql, k); out.budget = B; if (B.left != null && B.left <= 0) return Object.assign(out, { capped: true });
  let room = B.left == null ? 1e9 : B.left;
  const row = await sql`select v from gs_settings where k = 'gc_imp'`, S = row.length ? JSON.parse(row[0].v) : { last: '', added: 0 };
  if (reset) S.last = '';        // the list grew (more countries indexed): walk it again from the start; courses already brought in are skipped without a request
  let lastReq = 0;
  while (Date.now() - t0 < runMs) {
    /* a region asked for: its countries in the order given, taking the courses not read yet (no cursor: a course whose card we already fetched is done) */
    const L = only ? await sql`select i.slug, i.country from gs_gc_index i where i.country = any(${only}::text[]) and (i.d->'coverage'->>'scorecard') = 'true'
        and not exists (select 1 from gs_gc_detail d where d.slug = i.slug) order by array_position(${only}::text[], i.country), i.slug limit 20`
      : await sql`select i.slug, i.country from gs_gc_index i where i.slug > ${S.last} and i.country <> all(${IMPORT_LATER}::text[]) and (i.d->'coverage'->>'scorecard') = 'true'
        and not exists (select 1 from gs_gc_cmp m where m.slug = i.slug and m.r->>'v' in ('same', 'close', 'par', 'yards')) order by i.slug limit 20`;
    if (!L.length) { out.finished = true; break; }
    for (const x of L) { if (Date.now() - t0 >= runMs) break;
      let det = await sql`select d from gs_gc_detail where slug = ${x.slug}`, d = det.length ? pj(det[0].d) : null;
      if (!d) { if (room <= 0) { out.capped = true; break; } room--; const w = GAP_MS - (Date.now() - lastReq); if (w > 0) await sleep(w); lastReq = Date.now(); out.requests++;
        const r = await fetch(BASE + '/courses/' + encodeURIComponent(x.slug), { headers: { Authorization: 'Bearer ' + k, Accept: 'application/json', 'User-Agent': 'Golfimbul/1.0 (+https://golfimbul.vercel.app)' } });
        if (r.status === 429) { out.limited = +r.headers.get('retry-after') || 60; break; }
        d = r.ok ? await r.json().catch(() => null) : null;
        if (!d) { if (only) await sql`insert into gs_gc_detail (slug, d, at) values (${x.slug}, ${JSON.stringify({ failed: r.status })}, ${Date.now()}) on conflict (slug) do nothing`; else S.last = x.slug; continue; }
        await sql`insert into gs_gc_detail (slug, d, at) values (${x.slug}, ${JSON.stringify(d)}, ${Date.now()}) on conflict (slug) do update set d = excluded.d, at = excluded.at`; }
      const cs = convert(d); if (!cs.length) out.nodata++;
      for (const data of cs) {
        const dup = await sql`select code from gs_courses where data->>'gcUrl' = ${data.gcUrl} and data->>'name' = ${data.name} limit 1`; if (dup.length) { out.existed++; continue; }
        let base0 = data.name.split(/[^A-Za-zÀ-ÿ]+/).filter(w => w.length > 2).map(w => w[0]).join('').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4);
        if (base0.length < 2) base0 = (data.name.replace(/[^A-Za-z]/g, '').toUpperCase() + 'GC').slice(0, 4);
        const taken = new Set((await sql`select code from gs_courses where code like ${base0 + '%'}`).map(y => y.code).concat(['CGC', 'TER', 'SIG'])); let code = base0, n = 2; while (taken.has(code)) code = base0 + (n++);
        data.abbr = code; await sql`insert into gs_courses (code, data, upd) values (${code}, ${JSON.stringify(data)}, ${Date.now()})`; out.added++; S.added = (S.added || 0) + 1; }
      if (!only) S.last = x.slug; }
    if (out.limited || out.capped) break;
  }
  await sql`insert into gs_settings (k, v) values ('gc_imp', ${JSON.stringify(S)}) on conflict (k) do update set v = excluded.v`;
  return Object.assign(out, { totalAdded: S.added || 0, last: S.last });
}

module.exports = { run, status, list, compare, key, iso, fill, convert, importMissing, indexAll, budget };
