// Course import from GolfCourseAPI, run by hand by the admin (Profile → Admin → Courses → Import a batch).
// Agreed with the provider: at most 2,000 courses a day, starting with Latin America and moving north, never all at once.
// Each run works for under a minute, pauses between calls, counts every API call against the daily cap, and remembers
// where it stopped (country, search word, queue of found courses) so the next day carries on.
const L = require('./_lib');
const CI = require('./_courseimp');

const SEARCH_CAP = 7000;       // searches in total, as agreed with the provider; the import stops searching when it gets there
const DAY_CAP = 2000;          // API calls per day (search + course), the provider's limit
const RUN_MS = 50000;          // stop well before the 60 s function limit
const PAUSE_MS = 300;          // gap between calls, so the import never hits them all at once

/* south to north; each country is searched by its name and its main golf cities (a course is kept only if GolfCourseAPI places it in that country) */
const PLAN = [
  ['Argentina', ['Buenos Aires', 'Córdoba', 'Rosario', 'Mendoza', 'Mar del Plata', 'Tucumán', 'Salta', 'Bariloche', 'Neuquén', 'Santa Fe', 'Pilar', 'San Isidro', 'La Plata', 'Paraná', 'San Luis', 'Bahía Blanca', 'Villa Allende', 'Carlos Paz', 'Tandil', 'Rafaela', 'Venado Tuerto', 'Resistencia', 'Corrientes', 'Posadas', 'San Juan', 'Jujuy', 'Ushuaia', 'Río Cuarto', 'Pinamar', 'Nordelta']],
  ['Uruguay', ['Montevideo', 'Punta del Este', 'Colonia', 'Salto', 'Canelones', 'Maldonado', 'Paysandú', 'Carmelo']],
  ['Chile', ['Santiago', 'Viña del Mar', 'Valparaíso', 'Concepción', 'La Serena', 'Antofagasta', 'Temuco', 'Puerto Varas', 'Rancagua', 'Iquique', 'Puerto Montt', 'Chicureo', 'Colina', 'Lo Barnechea', 'Papudo']],
  ['Paraguay', ['Asunción', 'Luque', 'Encarnación', 'Ciudad del Este', 'San Bernardino']],
  ['Bolivia', ['La Paz', 'Santa Cruz', 'Cochabamba', 'Sucre', 'Tarija']],
  ['Brazil', ['São Paulo', 'Rio de Janeiro', 'Porto Alegre', 'Curitiba', 'Belo Horizonte', 'Brasília', 'Florianópolis', 'Salvador', 'Recife', 'Fortaleza', 'Campinas', 'Gramado', 'Goiânia', 'Natal', 'Búzios', 'Itu', 'Santos', 'Londrina', 'Ribeirão Preto', 'Costa do Sauípe']],
  ['Peru', ['Lima', 'Arequipa', 'Trujillo', 'Piura', 'Chiclayo', 'Cusco', 'Asia']],
  ['Ecuador', ['Quito', 'Guayaquil', 'Cuenca', 'Manta', 'Salinas']],
  ['Colombia', ['Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Cartagena', 'Bucaramanga', 'Pereira', 'Santa Marta', 'Manizales', 'Cúcuta', 'Ibagué', 'Villavicencio']],
  ['Venezuela', ['Caracas', 'Maracaibo', 'Valencia', 'Barquisimeto', 'Margarita', 'Puerto La Cruz']],
  ['Panama', ['Panama City', 'Coronado', 'Boquete', 'David', 'Playa Blanca']],
  ['Costa Rica', ['San José', 'Guanacaste', 'Liberia', 'Heredia', 'Alajuela', 'Papagayo']],
  ['Nicaragua', ['Managua', 'Granada', 'Rivas']],
  ['Honduras', ['Tegucigalpa', 'San Pedro Sula', 'Roatán', 'La Ceiba']],
  ['El Salvador', ['San Salvador', 'Santa Ana', 'La Libertad']],
  ['Guatemala', ['Guatemala City', 'Antigua', 'Escuintla', 'Quetzaltenango']],
  ['Belize', ['Belize City', 'San Pedro']],
  ['Dominican Republic', ['Santo Domingo', 'Punta Cana', 'La Romana', 'Puerto Plata', 'Santiago de los Caballeros', 'Casa de Campo', 'Cap Cana', 'Juan Dolio']],
  ['Puerto Rico', ['San Juan', 'Dorado', 'Río Grande', 'Humacao', 'Ponce', 'Aguadilla']],
  ['Cuba', ['Havana', 'Varadero']],
  ['Jamaica', ['Montego Bay', 'Ocho Rios', 'Kingston', 'Negril']],
  ['Bahamas', ['Nassau', 'Freeport', 'Exuma', 'Abaco']],
  ['Mexico', ['Mexico City', 'Guadalajara', 'Monterrey', 'Cancún', 'Los Cabos', 'Cabo San Lucas', 'Puerto Vallarta', 'Querétaro', 'Puebla', 'Mérida', 'León', 'San Miguel de Allende', 'Acapulco', 'Mazatlán', 'Playa del Carmen', 'Tijuana', 'Chihuahua', 'Hermosillo', 'Aguascalientes', 'San Luis Potosí', 'Cuernavaca', 'Morelia', 'Toluca', 'Ixtapa', 'Huatulco', 'Nuevo Vallarta', 'Torreón', 'Saltillo', 'Culiacán', 'Veracruz']]
];
/* second pass, after the last country: search every known club by name (lists in _clubnames.js) — how Argentina got its coverage */
const NAMES = require('./_clubnames');
['Uruguay', 'Chile', 'Brazil', 'Mexico', 'United States'].forEach(c => { if (NAMES[c] && NAMES[c].length) PLAN.push([c, NAMES[c], true]); });
const norm = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ALIAS = { 'united states': ['usa', 'us', 'united states of america'], 'brazil': ['brasil'], 'mexico': ['méxico'], 'peru': ['perú'], 'panama': ['panamá'], 'dominican republic': ['republica dominicana'] };
const inCountry = (c, country) => { const k = norm(c && c.location && c.location.country), want = norm(country); return k === want || (ALIAS[want] || []).map(norm).includes(k) || (want === 'puerto rico' && /puerto rico|\bpr\b/.test(k)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runImport(sql, key, runMs) {
  const t0 = Date.now();
  const row = await sql`select v from gs_settings where k = 'imp_state'`;
  const S = row.length ? JSON.parse(row[0].v) : { ci: 0, qi: 0, queue: [], seen: [], day: '', calls: 0, total: 0, log: [] };
  const day = new Date().toISOString().slice(0, 10);
  if (S.day !== day) { S.day = day; S.calls = 0; }
  const seen = new Set(S.seen || []);
  const get = async url => { S.calls++; const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } }); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, j }; };
  const tidy = x => String(x || '').replace(/\t/g, ' ').replace(/^\s*\d{1,4}\s+/, '').replace(/\s+/g, ' ').trim();
  const fullName = (club, course) => { club = tidy(club); let v = tidy(course); if (v.toLowerCase().indexOf(club.toLowerCase()) === 0) v = v.slice(club.length); v = v.replace(/^[\s\-–(]+/, '').replace(/\)\s*$/, '').trim(); return (v ? club + ' — ' + v : club).slice(0, 60); };
  const run = { added: 0, existed: 0, nodata: 0, errors: 0, searches: 0 };
  S.found = S.found || {};
  /* once every country is done, the next batch starts a maintenance pass: the same searches again, keeping only courses not seen before (new courses, new entries) */
  const MAINTENANCE = false;     // off for now: when every country is done, further batches do nothing (no repeat searches)
  if (S.ci >= PLAN.length && !MAINTENANCE) return { ...(S.last || {}), added: 0, searches: 0, finished: true, idle: true, totalAdded: S.total || 0 };
  if (S.ci >= PLAN.length) { S.cycle = (S.cycle || 1) + 1; S.ci = 0; S.qi = 0; S.queue = []; S.found = {}; S.per = {}; S.log = (S.log || []).concat([{ day, maintenance: S.cycle }]).slice(-60); }
  S.searches = S.searches || 0;
  while (Date.now() - t0 < runMs && S.calls < DAY_CAP && S.ci < PLAN.length) {
    const [country, cities, byName] = PLAN[S.ci], words = byName ? cities : [country].concat(cities);
    if (!S.queue.length) {
      if (S.qi >= words.length) { S.log = (S.log || []).concat([{ day, country, done: true }]).slice(-60); S.ci++; S.qi = 0; continue; }
      if (S.searches >= SEARCH_CAP) { run.capped = true; break; }                      // total search allowance used up
      const r = await get('https://api.golfcourseapi.com/v1/search?search_query=' + encodeURIComponent(words[S.qi]));
      run.searches++; S.searches++; S.qi++;
      if (r.status === 429) break;                                   // provider says slow down: stop for today
      if (r.ok) (r.j.courses || []).forEach(c => { if (c && c.id != null && !seen.has(String(c.id)) && inCountry(c, country)) { seen.add(String(c.id)); S.queue.push(String(c.id)); S.found[country] = (S.found[country] || 0) + 1; } });
      await sleep(PAUSE_MS); continue;
    }
    const id = S.queue.shift();
    const R = await CI.adopt(sql, get, id, 'import', fullName);
    if (R.error) run.errors++; else if (R.existed) run.existed++; else if (R.nodata) run.nodata++; else run.added++;
    { const cn = PLAN[S.ci][0], k = R.error ? 'err' : R.existed ? 'existed' : R.nodata ? 'nodata' : 'added'; S.per = S.per || {}; S.per[cn] = S.per[cn] || {}; S.per[cn][k] = (S.per[cn][k] || 0) + 1; }
    await sleep(PAUSE_MS);
  }
  S.total = (S.total || 0) + run.added;
  S.seen = Array.from(seen).slice(-20000);
  S.last = { at: new Date().toISOString(), country: PLAN[Math.min(S.ci, PLAN.length - 1)][0], pass: S.cycle || 1, ...run, callsToday: S.calls, searchesTotal: S.searches, searchCap: SEARCH_CAP };
  await sql`insert into gs_settings (k, v) values ('imp_state', ${JSON.stringify(S)}) on conflict (k) do update set v = excluded.v`;
  return { ...S.last, totalAdded: S.total, finished: S.ci >= PLAN.length };
}
const keyOf = () => String(process.env.GOLFCOURSEAPI_KEY || process.env.GOLF_COURSE_API_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/^(Bearer|Key)\s+/i, '').trim();

/* also callable directly with the CRON_SECRET header, if one day it is scheduled again */
const handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = String(process.env.CRON_SECRET || '');
  if (!secret || !L.safeEq(String(req.headers.authorization || ''), 'Bearer ' + secret)) return res.status(401).json({ error: 'auth' });
  const key = keyOf();
  if (!key) return res.status(503).json({ error: 'no-key' });
  try { await L.init(); const r = await runImport(L.db(), key, RUN_MS); return res.status(200).json({ ok: true, ...r }); }
  catch (e) { return res.status(500).json({ error: 'server', detail: String(e && e.message || e).slice(0, 200) }); }
};
handler.runImport = runImport; handler.PLAN = PLAN; handler.keyOf = keyOf; handler.DAY_CAP = DAY_CAP; handler.SEARCH_CAP = SEARCH_CAP;
module.exports = handler;
