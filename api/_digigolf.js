// Club history from a club's Digigolf minisite (with Digigolf's permission): search a player by name or registration
// number, list their tournament rounds, then read each scorecard (par and score per hole, playing handicap).
const BASE = 'https://www.digigolf.com.ar/minisite/';
const UA = { 'User-Agent': 'Golfimbul club-history import (golfimbul.vercel.app)', 'Accept': 'text/html' };
const strip = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/g, ' ');
const dmy = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '-' + m[2] + '-' + m[1] : String(d || ''); };

async function search(club, q, from, to) {
  const body = new URLSearchParams({ c: String(club), onStats: '4', 'select-anio-inicio-club-pla': dmy(from), 'select-anio-fin-club-pla': dmy(to), hcp_desde: '', hcp_hasta: '', buscar_nom_mat: String(q), doc: '' });
  const r = await fetch(BASE + 'estadisticas.php?c=' + encodeURIComponent(club) + '&ifr=1', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, UA), body });
  if (!r.ok) throw new Error('digigolf-' + r.status);
  const html = await r.text(), out = [], seen = {};
  html.split(/<li[\s>]/i).forEach(chunk => {
    const hm = chunk.match(/href=["']?(resultados-tarjeta\.php[^"'\s>]+)/i); if (!hm) return;
    const href = hm[1].replace(/&amp;/g, '&'); if (seen[href]) return; seen[href] = 1;
    const cells = strip(chunk.slice(0, chunk.search(/<\/li>/i) > 0 ? chunk.search(/<\/li>/i) : chunk.length)).split('\n').map(x => x.trim()).filter(Boolean);
    const di = cells.findIndex(x => /^\d{2}-\d{2}-\d{4}$/.test(x)); if (di < 0) return;
    const nums = cells.slice(di + 2).filter(x => /^-?\d+([.,]\d+)?$/.test(x));
    const id = (href.match(/[?&]id=([^&]+)/) || [])[1] || '';
    out.push({ name: cells[di - 1] || cells[0], date: cells[di], club: cells[di + 1] || '', gross: nums[0] != null ? +nums[0] : null, hcp: nums.length ? +String(nums[nums.length - 1]).replace(',', '.') : null, id, href });
  });
  return out;
}

async function card(href) {
  if (!/^resultados-tarjeta\.php\?/.test(href)) throw new Error('bad-href');
  const r = await fetch(BASE + href, { headers: UA });
  if (!r.ok) throw new Error('digigolf-' + r.status);
  const t = strip(await r.text()).replace(/\s+/g, ' ');
  const hcp = (t.match(/HCP:\s*(-?\d+)/i) || [])[1];
  const par = t.match(/Par ((?:\d+ ){18})(\d+)/), rd = t.match(/Ronda 1 ((?:\d+ ){18})(\d+)(?: (-?\d+))?/);
  return { hcp: hcp != null ? +hcp : null, par: par ? par[1].trim().split(' ').map(Number) : null, sc: rd ? rd[1].trim().split(' ').map(Number) : null, tot: rd ? +rd[2] : null, net: rd && rd[3] != null ? +rd[3] : null };
}

module.exports = { search, card };
