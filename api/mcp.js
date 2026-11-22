// Golfimbul MCP server (read-only) — lets a player's own AI assistant read their game. Lite and Pro.
//   Endpoint: POST /api/mcp?key=gk_...   (or Authorization: Bearer gk_...)
//   Transport: MCP Streamable HTTP, JSON responses (no sessions, no streaming needed).
// Keys are created and revoked by the player in Profile → AI assistant. Only a SHA-256 of each key is stored.
const L = require('./_lib');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Golfimbul is a golf analytics app built on statistical process control. ' +
  'When you discuss trends, use the control limits returned by get_stats and get_tiger5: a round inside the limits is ordinary variation (noise), ' +
  'not improvement or decline. Only call something a real change when there is a signal (a point outside the limits, or 8+ rounds in a row on one side of the average). ' +
  'Strokes gained (SG) is versus a scratch baseline unless stated; negative = strokes lost. Tiger 5 counts five avoidable mistakes per round. ' +
  'You can only read data — nothing can be changed through this connection.';

const r2 = x => Math.round(x * 100) / 100;
const num = x => (x === null || x === undefined || x === '' || isNaN(+x)) ? null : +x;
function xmr(vals) {
  const v = vals.filter(x => x !== null);
  if (v.length < 5) return { n: v.length, note: 'fewer than 5 values — no limits yet' };
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  let mr = 0; for (let i = 1; i < v.length; i++) mr += Math.abs(v[i] - v[i - 1]); mr /= (v.length - 1);
  const ucl = m + 2.66 * mr, lcl = m - 2.66 * mr, sig = [];
  v.forEach((x, i) => { if (x > ucl || x < lcl) sig.push({ index: i, value: x, rule: x > ucl ? 'above upper limit' : 'below lower limit' }); });
  for (let a = 0; a + 8 <= v.length; a++) {
    const w = v.slice(a, a + 8);
    if (w.every(x => x > m)) { sig.push({ index: a + 7, rule: '8 in a row above average' }); break; }
    if (w.every(x => x < m)) { sig.push({ index: a + 7, rule: '8 in a row below average' }); break; }
  }
  return { n: v.length, average: r2(m), upperLimit: r2(ucl), lowerLimit: r2(lcl), latest: v[v.length - 1], inControl: !sig.length, signals: sig };
}
function summary(id, d) {
  return { id, date: d.date, course: d.course, tee: d.tee, holes: d.holesPlayed, score: num(d.score), par: num(d.par), toPar: num(d.stp), toNetPar: num(d.stpNet),
    putts: num(d.putts), fairways: d.fwAtt ? `${d.fw}/${d.fwAtt}` : null, greensInRegulation: num(d.gir), penalties: num(d.pen), avgDrive: num(d.dist),
    strokesGained: { offTheTee: num(d.ott), approach: num(d.app), aroundTheGreen: num(d.atg), putting: num(d.putt), total: num(d.sgtot) },
    tiger5: { threePutts: num(d.p3), doubleBogeys: num(d.db), bogeyOnPar5: num(d.bp5), bogeyFromShortRange: num(d.f150), shortGameMisses: num(d.fx), total: num(d.mtot) },
    handicapIndex: num(d.hi), lesson: d.lesson || undefined };
}
const qv = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };

const TOOLS = [
  { name: 'get_player', description: "The player's name, plan, latest handicap index and how many rounds are logged.", inputSchema: { type: 'object', properties: {} } },
  { name: 'list_rounds', description: 'Rounds logged in Golfimbul, newest first: score, to par, putts, fairways, GIR, penalties, strokes gained by phase and Tiger 5.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD, inclusive' }, to: { type: 'string', description: 'YYYY-MM-DD, inclusive' }, course: { type: 'string', description: 'part of the course name' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 } } } },
  { name: 'get_round', description: 'One round in full, hole by hole, with every shot (lie, distance to the hole, penalty, club if tracked). Use an id from list_rounds, or a date.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD (latest round that day)' } } } },
  { name: 'get_stats', description: 'Control-chart statistics over the latest 18-hole rounds: average, upper/lower limits and signals for score, to par, putts, strokes gained by phase and Tiger 5. Use this before claiming any trend.',
    inputSchema: { type: 'object', properties: { last: { type: 'integer', minimum: 5, maximum: 200, default: 40 } } } },
  { name: 'get_bag', description: "Club distances (median, stock range, long), approach dispersion and tee-shot direction per club, from the player's Garmin import.", inputSchema: { type: 'object', properties: {} } },
  { name: 'get_tiger5', description: "Tiger 5 per round from the player's Garmin rounds, with control limits for the total and the average of each mistake type.",
    inputSchema: { type: 'object', properties: { last: { type: 'integer', minimum: 5, maximum: 300, default: 60 } } } }
];

async function rounds(sql, user) {
  const rows = await sql`select id, data from gs_rounds where username = ${user} and deleted = false`;
  return rows.map(r => ({ id: r.id, d: r.data || {} })).filter(r => r.d && r.d.date).sort((a, b) => a.d.date < b.d.date ? -1 : a.d.date > b.d.date ? 1 : 0);
}
async function callTool(sql, user, name, a) {
  a = a || {};
  if (name === 'get_player') {
    const p = (await sql`select display, plan from gs_profiles where username = ${user}`)[0] || {};
    const R = await rounds(sql, user), last = R[R.length - 1];
    const hi = R.slice().reverse().map(r => num(r.d.hi)).find(x => x !== null);
    return { name: p.display || user, plan: await L.effectivePlan(sql, user, p.plan), handicapIndex: hi === undefined ? null : hi, roundsLogged: R.length,
      firstRound: R[0] ? R[0].d.date : null, latestRound: last ? last.d.date : null, garminImport: !!(await sql`select 1 as x from gs_bags where username = ${user}`).length };
  }
  if (name === 'list_rounds') {
    let R = (await rounds(sql, user)).reverse();
    if (a.from) R = R.filter(r => r.d.date >= a.from);
    if (a.to) R = R.filter(r => r.d.date <= a.to);
    if (a.course) { const c = String(a.course).toLowerCase(); R = R.filter(r => String(r.d.course || '').toLowerCase().includes(c)); }
    const lim = Math.min(200, Math.max(1, parseInt(a.limit, 10) || 30));
    return { total: R.length, rounds: R.slice(0, lim).map(r => summary(r.id, r.d)) };
  }
  if (name === 'get_round') {
    const R = await rounds(sql, user);
    const r = a.id ? R.find(x => x.id === String(a.id)) : R.slice().reverse().find(x => x.d.date === String(a.date || ''));
    if (!r) return { error: 'No round found. Use list_rounds to see ids and dates.' };
    const holes = (r.d.holes || []).map((h, i) => ({ hole: i + 1, par: h.par, yards: h.yd,
      shots: (h.shots || []).map(s => ({ lie: s.lie, distance: s.lie === 'putt' ? `${s.dist} ft` : `${s.dist} yd`, penalty: s.pen || 0, club: s.club || undefined })) }))
      .filter(h => h.shots.length);
    return Object.assign(summary(r.id, r.d), { notes: r.d.notes || undefined, holeByHole: holes });
  }
  if (name === 'get_stats') {
    const last = Math.min(200, Math.max(5, parseInt(a.last, 10) || 40));
    const R = (await rounds(sql, user)).filter(r => (r.d.holesPlayed || 18) >= 18).slice(-last);
    const col = k => xmr(R.map(r => num(r.d[k])));
    return { rounds: R.length, from: R[0] ? R[0].d.date : null, to: R.length ? R[R.length - 1].d.date : null, order: 'oldest to newest (signal index refers to this order)',
      score: col('score'), toPar: col('stp'), putts: col('putts'), penalties: col('pen'),
      strokesGained: { total: col('sgtot'), offTheTee: col('ott'), approach: col('app'), aroundTheGreen: col('atg'), putting: col('putt') },
      tiger5Total: col('mtot'), howToRead: 'inControl=true means every round is ordinary variation — do not call a single good or bad round a trend.' };
  }
  if (name === 'get_bag' || name === 'get_tiger5') {
    const b = await sql`select data from gs_bags where username = ${user}`;
    if (!b.length) return { error: 'No Garmin import yet. The player can add one in Golfimbul → Profile → My bag → Import from Garmin Golf.' };
    const d = b[0].data;
    if (name === 'get_bag') {
      return { source: d.source, updated: d.updated, clubs: (d.clubs || []).map(c => {
        const v = (c.d || []).map(x => x[0]), p = c.disp || [], t = c.tee || {}, tt = (t.L || 0) + (t.H || 0) + (t.R || 0);
        const m = k => p.length ? r2(p.reduce((s, x) => s + x[k], 0) / p.length) : null;
        return { club: c.name, model: c.model || undefined, shots: v.length, medianYards: v.length ? Math.round(qv(v, .5)) : null, stockRange: v.length ? `${Math.round(qv(v, .25))}-${Math.round(qv(v, .75))}` : null,
          longYards90: v.length ? Math.round(qv(v, .9)) : null, approachDispersion: p.length >= 8 ? { shots: p.length, avgLeftRightYards: m(0), avgShortLongYards: m(1), note: 'negative = left / short of the flag' } : undefined,
          teeShots: tt >= 20 ? { left: Math.round(100 * (t.L || 0) / tt) + '%', fairway: Math.round(100 * (t.H || 0) / tt) + '%', right: Math.round(100 * (t.R || 0) / tt) + '%' } : undefined };
      }).filter(c => c.shots >= 8).sort((x, y) => y.medianYards - x.medianYards) };
    }
    const last = Math.min(300, Math.max(5, parseInt(a.last, 10) || 60));
    const T = (d.t5 || []).filter(r => r.n >= 18 && r.sh >= 12).slice(-last);
    if (!T.length) return { error: 'No Tiger 5 data in the Garmin import. Re-import from Garmin to calculate it.' };
    const avg = k => r2(T.reduce((s, r) => s + r[k], 0) / T.length);
    return { rounds: T.length, definitions: d.t5cfg || null, parBasis: 'gross par',
      averagePerRound: { bogeyOnPar5: avg('bp5'), doubleBogeys: avg('db'), threePutts: avg('p3'), bogeyFromShortRange: avg('f150'), shortGameMisses: avg('short'), total: avg('t') },
      totalControlChart: xmr(T.map(r => r.t)), perRound: T.map(r => ({ date: r.d, course: r.c, score: r.sc, total: r.t, bogeyOnPar5: r.bp5, doubleBogeys: r.db, threePutts: r.p3, bogeyFromShortRange: r.f150, shortGameMisses: r.short })) };
  }
  return null;
}

async function keyUser(sql, key) {
  if (!/^gk_[a-f0-9]{32}$/.test(key)) return null;
  const h = L.crypto.createHash('sha256').update(key).digest('hex');
  const r = await sql`select id, username from gs_keys where hash = ${h}`;
  if (!r.length) return null;
  await sql`update gs_keys set last_used = now() where id = ${r[0].id}`;
  return r[0].username;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Golfimbul MCP: use POST (MCP Streamable HTTP).' });
  const key = String((req.query && req.query.key) || '').trim() || String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  try {
    await L.init();
    const sql = L.db();
    const user = await keyUser(sql, key);
    if (!user || !(await L.alive(sql, user))) return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or revoked Golfimbul key. Create one in Golfimbul → Profile → AI assistant.' } });
    const plan = await L.effectivePlan(sql, user, ((await sql`select plan from gs_profiles where username = ${user}`)[0] || {}).plan);
    const b = L.body(req), batch = Array.isArray(b), msgs = batch ? b : [b], out = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0' || !m.method) { out.push({ jsonrpc: '2.0', id: (m && m.id) || null, error: { code: -32600, message: 'Invalid request' } }); continue; }
      if (m.id === undefined || m.id === null) continue;            // notifications (e.g. notifications/initialized): nothing to return
      const ok = result => out.push({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') {
        const want = m.params && m.params.protocolVersion;
        ok({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'golfimbul', title: 'Golfimbul', version: '1.0.0' }, instructions: INSTRUCTIONS });
      } else if (m.method === 'ping') ok({});
      else if (m.method === 'tools/list') ok({ tools: TOOLS });
      else if (m.method === 'tools/call') {
        if (L.rank(plan) < 1) { ok({ isError: true, content: [{ type: 'text', text: 'The AI assistant connection is part of Golfimbul Lite and Pro.' }] }); continue; }
        const name = m.params && m.params.name;
        if (!TOOLS.some(t => t.name === name)) { out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool: ' + name } }); continue; }
        const data = await callTool(sql, user, name, m.params.arguments);
        ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: !!(data && data.error) });
      } else if (m.method === 'resources/list') ok({ resources: [] });
      else if (m.method === 'prompts/list') ok({ prompts: [] });
      else out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
    }
    if (!out.length) return res.status(202).end();
    return res.status(200).json(batch ? out : out[0]);
  } catch (e) {
    if (e && e.code === 'NODB') return res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'no database' } });
    console.error(e);
    return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'server error' } });
  }
};
