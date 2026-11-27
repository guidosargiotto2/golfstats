// Reads a photo of a Golfimbul printed scorecard into shots, hole by hole.
// The photo goes to the vision model for reading and is not stored anywhere by Golfimbul.
// Needs ANTHROPIC_API_KEY in the project's environment; until it is there, ready() is false and nothing is sent.
// Optional: SCAN_MODEL (model id).

const MODEL = () => process.env.SCAN_MODEL || 'claude-sonnet-5-5';
const ready = () => !!process.env.ANTHROPIC_API_KEY;
const LIMIT = 5;   // photos per player per day

const LIES = ['tee', 'fw', 'rough', 'sand', 'rec', 'putt'];
const DISP = ['ok', 'L', 'R', 'S', 'G', 'SL', 'SR', 'GL', 'GR'];
const READ = ['DL', 'D', 'DR', 'L', 'F', 'R', 'UL', 'U', 'UR'];

function prompt(ctx) {
  const es = ctx.lang === 'es';
  const clubs = (ctx.clubs || []).slice(0, 20).map(c => `${c.label} = ${c.code}`).join(', ');
  return `You are reading a photo of a golf scorecard filled in by hand. It is a Golfimbul card: A4, portrait, two tables (holes 1-9 on top, 10-18 below). Columns are holes. Rows are "Shot 1" to "Shot ${ctx.rows || 8}", then "Score" and "Pen". The card is written in ${es ? 'Spanish' : 'English'}.

Each shot cell has, on top, where the shot was played from plus the distance to the hole:
- T tee, F fairway, R rough, ${es ? 'B bunker (sand)' : 'S sand'}, X recovery: distance in ${ctx.units === 'm' ? 'metres' : 'yards'}.
- G green (a putt): distance in feet.
- Shot 1 is always the tee shot; often only the number is written (the hole length), or it is left blank.
${ctx.comp ? '- A small box in the top-right corner may carry a tick (process followed) or a cross (not followed).\n' : ''}${ctx.club ? `- Bottom-left box: the club. The player's labels and their codes: ${clubs || 'Dr, 3W, 5W, 3H, 4i-9i, PW, GW, SW, LW, Pt'}.\n` : ''}${ctx.disp && ctx.disp !== 'off' ? `- Dispersion box: where the ball finished against the target. ${es
    ? 'I left, D right, C short, L long, CI short-left, CD short-right, LI long-left, LD long-right, a tick = on target.'
    : 'L left, R right, S short, LO long, SL short-left, SR short-right, LL long-left, LR long-right, a tick = on target.'} A number next to it is how far it missed.${ctx.disp === 'tee' ? ' Only the tee shot has this box (left or right).' : ''}\n` : ''}${ctx.read ? `- Read box (putts only): slope and break. ${es
    ? 'S uphill, B downhill, I breaks left, D breaks right (BI = downhill, breaking left); a dash = flat and straight.'
    : 'U uphill, D downhill, L breaks left, R breaks right (DL = downhill, breaking left); a dash = flat and straight.'}\n` : ''}
Empty shot rows mean the hole was finished with fewer shots. "Score" is the strokes on the hole; "Pen" is penalty strokes on the hole.
The header may have Player, Course, Date, Tees and Playing handicap, printed or handwritten.

Return ONLY a JSON object, no prose, in this exact shape:
{"date":"YYYY-MM-DD or null","course":"text or null","tee":"text or null","holes":[{"n":1,"score":4,"pen":0,"unsure":false,"shots":[{"lie":"tee|fw|rough|sand|rec|putt","dist":372,"club":"code or null","disp":"ok|L|R|S|G|SL|SR|GL|GR or null","dispYd":null,"read":"DL|D|DR|L|F|R|UL|U|UR or null","comp":true,"unsure":false}]}]}

Rules:
- Use the codes above exactly: long is "G" in disp (so long-left is "GL"); flat and straight read is "F"; comp is true for a tick, false for a cross, null if empty.
- Include only the holes that have something written. Keep shots in order, top to bottom.
- Never invent a value. If a cell cannot be read with confidence, give your best reading and set "unsure":true on that shot; if a whole hole is doubtful set "unsure":true on the hole.
- dist is a number only (no letters). If the tee cell is blank, use null for its dist.`;
}

const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null; };

function clean(j) {
  const out = { date: null, course: null, tee: null, holes: [] };
  if (!j || typeof j !== 'object') return out;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(j.date || ''))) out.date = j.date;
  if (j.course) out.course = String(j.course).slice(0, 80);
  if (j.tee) out.tee = String(j.tee).slice(0, 30);
  const seen = {};
  (Array.isArray(j.holes) ? j.holes : []).slice(0, 18).forEach(h => {
    const n = num(h && h.n, 1, 18); if (!n || seen[n]) return; seen[n] = 1;
    const shots = (Array.isArray(h.shots) ? h.shots : []).slice(0, 14).map((s, i) => {
      if (!s) return null;
      const lie = LIES.includes(s.lie) ? s.lie : (i === 0 ? 'tee' : null); if (!lie) return null;
      const o = { lie, dist: num(s.dist, 1, lie === 'putt' ? 150 : 700) };
      if (s.club) o.club = String(s.club).slice(0, 4);
      if (DISP.includes(s.disp)) o.disp = s.disp;
      const dy = num(s.dispYd, 1, 150); if (dy && o.disp && o.disp !== 'ok') o.dispYd = dy;
      if (lie === 'putt' && READ.includes(s.read)) o.read = s.read;
      if (s.comp === true || s.comp === false) o.comp = s.comp;
      if (s.unsure || (o.dist == null && i > 0)) o.unsure = true;
      return o;
    }).filter(Boolean);
    out.holes.push({ n, score: num(h.score, 1, 20), pen: num(h.pen, 0, 9) || 0, unsure: !!h.unsure, shots });
  });
  out.holes.sort((a, b) => a.n - b.n);
  return out;
}

async function read(dataUrl, ctx) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) { const e = new Error('bad-image'); e.code = 400; throw e; }
  if (m[2].length > 4200000) { const e = new Error('image-too-big'); e.code = 413; throw e; }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL(), max_tokens: 6000, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text: prompt(ctx || {}) }] }] })
  });
  if (!r.ok) { const e = new Error('reader-failed'); e.code = 502; e.detail = r.status; throw e; }
  const j = await r.json();
  const txt = ((j.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '');
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  let parsed = null; try { parsed = JSON.parse(txt.slice(a, b + 1)); } catch (e) {}
  if (!parsed) { const e = new Error('unreadable'); e.code = 422; throw e; }
  return clean(parsed);
}

module.exports = { ready, read, clean, prompt, LIMIT };
