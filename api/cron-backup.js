// Weekly backup: every table that holds what golfers gave us (accounts, rounds, profiles, history, bags, teams, requests, settings) and the
// course database, written as gzipped JSON into a PRIVATE GitHub repository, one folder per date. Never into this code repository.
// Needs three environment variables: BACKUP_REPO ("owner/name" of the private repository), GITHUB_BACKUP_TOKEN (a fine-grained token with
// "Contents: read and write" on that repository only) and CRON_SECRET (Vercel sends it with scheduled calls). The founder can also run it by hand.
// Not backed up: copies of other services' data that can be fetched again (gs_gc_index, gs_gc_detail, gs_gc_cmp, gs_xc) and usage counters.
const zlib = require('zlib');
const L = require('./_lib');
const TABLES = ['gs_users', 'gs_profiles', 'gs_rounds', 'gs_history', 'gs_bags', 'gs_follows', 'gs_teams', 'gs_team_members', 'gs_reviews', 'gs_tasks', 'gs_keys', 'gs_settings', 'gs_course_requests', 'gs_course_fixes', 'gs_audit', 'gs_courses'];

async function put(repo, token, path, buf, message) {
  const r = await fetch('https://api.github.com/repos/' + repo + '/contents/' + path, { method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'golfimbul-backup', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: buf.toString('base64') }) });
  return r.status;
}

async function run(sql) {
  const repo = String(process.env.BACKUP_REPO || '').trim(), token = String(process.env.GITHUB_BACKUP_TOKEN || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) return { error: 'backup-not-configured' };
  /* refuse to write people's data anywhere public */
  const info = await fetch('https://api.github.com/repos/' + repo, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'golfimbul-backup' } });
  if (!info.ok) return { error: 'backup-repo-unreachable', status: info.status };
  const meta = await info.json(); if (!meta.private) return { error: 'backup-repo-is-public' };
  const day = new Date().toISOString().slice(0, 10), stamp = new Date().toISOString().slice(11, 19).replace(/:/g, ''), out = { day, tables: {}, bytes: 0 };
  for (const t of TABLES) {
    let rows; try { rows = await sql.query('select * from ' + t); } catch (e) { out.tables[t] = 'missing'; continue; }
    rows = rows.rows || rows;
    const CH = t === 'gs_courses' ? 3000 : 20000;                       // big tables go in parts so no file is too large to send
    for (let i = 0, p = 1; i < Math.max(1, rows.length); i += CH, p++) {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(rows.slice(i, i + CH))));
      const st = await put(repo, token, day + '/' + t + (rows.length > CH ? '.' + p : '') + '-' + stamp + '.json.gz', gz, 'Backup ' + day + ' ' + t);
      if (st !== 201 && st !== 200) { out.tables[t] = 'failed ' + st; break; }
      out.bytes += gz.length; out.tables[t] = rows.length;
    }
  }
  await sql`insert into gs_settings (k, v) values ('backup_last', ${JSON.stringify({ at: new Date().toISOString(), tables: out.tables, bytes: out.bytes })}) on conflict (k) do update set v = excluded.v`;
  return out;
}

const handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = String(process.env.CRON_SECRET || ''), byCron = !!secret && L.safeEq(String(req.headers.authorization || ''), 'Bearer ' + secret);
  const me = byCron ? null : L.auth(req);
  if (!byCron && (me !== L.ADMIN || L.isImp(req))) return res.status(401).json({ error: 'auth' });
  try { await L.init(); const r = await run(L.db()); return res.status(r.error ? 503 : 200).json(Object.assign({ ok: !r.error }, r)); }
  catch (e) { return res.status(500).json({ error: 'server', detail: String(e && e.message || e).slice(0, 200) }); }
};
handler.run = run;
module.exports = handler;
