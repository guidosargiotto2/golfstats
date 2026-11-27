// Adopt one GolfCourseAPI course into the shared course database (used by players' on-demand lookup and by the daily import).
// Returns { code, course } · { code, course, existed } · { nodata, name, city } · { error }.
async function adopt(sql, get, id, me, fullName) {
      const r = await get('https://api.golfcourseapi.com/v1/courses/' + encodeURIComponent(String(id || '').replace(/[^0-9a-zA-Z_-]/g, '')));
      if (!r.ok) return { error: 'unavailable' };
      const c = r.j.course || r.j, name = fullName(c.club_name, c.course_name);
      const lo = c.location || {}, loc = { country: String(lo.country || '').slice(0, 40), state: String(lo.state || '').slice(0, 40), city: String(lo.city || '').slice(0, 40) };
      const nk = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !['golf', 'club', 'de', 'del', 'el', 'la', 'los', 'las', 'country', 'the', 'gc', 'cc', 'course', 'y', 'and'].includes(w)).sort().join(' ');
      const pd = x => (typeof x.data === 'string' ? JSON.parse(x.data) : x.data);
      /* only the rows that could be this course (same longest word in the name) — never the whole table */
      const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => !['golf', 'club', 'country', 'course', 'resort', 'links'].includes(w)).sort((x, y) => y.length - x.length)[0] || '';
      const all = key.length >= 3 ? await sql`select code, data from gs_courses where translate(lower(data->>'name'), 'áàâãäéèêëíìîïóòôõöúùûüñç', 'aaaaaeeeeiiiiooooouuuunc') like ${'%' + key + '%'}` : await sql`select code, data from gs_courses where lower(data->>'name') = ${name.toLowerCase()}`;
      const have = all.find(x => !pd(x).empty && nk(pd(x).name) === nk(name));
      if (have) return ({ code: have.code, course: pd(have), existed: true });
      // tees: 18-hole sets (a 9-hole card is played twice); men's and ladies' tees with the same yardages become one
      const raw = [].concat((c.tees && c.tees.male) || [], (c.tees && c.tees.female) || []);
      const n18 = raw.some(t => (t.holes || []).length === 18), want = n18 ? 18 : 9, T0 = {};
      raw.forEach(t => { const nm = String(t.tee_name || 'Tee').replace(/[^A-Za-zÀ-ÿ0-9 ]/g, '').trim().slice(0, 20) || 'Tee'; if (T0[nm] || (t.holes || []).length !== want) return;
        let y = t.holes.map(h => +h.yardage), pr = t.holes.map(h => +h.par), si = t.holes.map(h => +h.handicap), cr = +t.course_rating, sl = +t.slope_rating;
        if (!y.every(v => v >= 40 && v <= 800) || !pr.every(v => v >= 3 && v <= 6) || !(cr > 20) || !(sl >= 55)) return;
        if (want === 9) { y = y.concat(y); pr = pr.concat(pr); si = []; cr = Math.round(cr * 20) / 10; }
        T0[nm] = { cr, slope: sl, yds: y, par: pr, si }; });
      const names = Object.keys(T0);
      if (!names.length) return ({ nodata: true, name, city: loc.city });
      const GEN = /\b(damas?|ladies|lady|women|mujeres|femenin[oa]s?|caballeros?|men|mens|hombres|masculin[oa]s?)\b/ig;
      const COL = [['Negras', 'Black', /^(black|negr[oa]s?)$/i], ['Azules', 'Blue', /^(blue|azul(es)?)$/i], ['Blancas', 'White', /^(white|blanc[oa]s?)$/i], ['Rojas', 'Red', /^(red|roj[oa]s?)$/i], ['Doradas', 'Gold', /^(gold|dorad[oa]s?|oro)$/i], ['Amarillas', 'Yellow', /^(yellow|amarill[oa]s?)$/i], ['Verdes', 'Green', /^(green|verdes?)$/i], ['Plateadas', 'Silver', /^(silver|platead[oa]s?|plata)$/i], ['Naranjas', 'Orange', /^(orange|naranjas?)$/i]];
      const base = n => ({ base: n.replace(GEN, ' ').replace(/\s+/g, ' ').trim() || n, g: /\b(damas?|ladies|lady|women|mujeres|femenin[oa]s?)\b/i.test(n) ? 'D' : (/\b(caballeros?|men|mens|hombres|masculin[oa]s?)\b/i.test(n) ? 'C' : '') });
      const label = k => { const tb = base(k); let es = tb.base, en = tb.base; for (const cc of COL) if (cc[2].test(tb.base)) { es = cc[0]; en = cc[1]; break; } if (tb.g) { es += tb.g === 'D' ? ' Damas' : ' Caballeros'; en += tb.g === 'D' ? ' Ladies' : ' Men'; } return es === en ? es : es + ' / ' + en; };
      const by = {}, order = []; names.forEach(k => { const tb = base(k); if (!by[tb.base]) { by[tb.base] = []; order.push(tb.base); } by[tb.base].push({ g: tb.g, t: T0[k] }); });
      const tees = {}; order.forEach(bn => { const Ls = by[bn], sig = x => x.t.yds.join(','), same = Ls.every(x => sig(x) === sig(Ls[0]));
        if (Ls.length === 1 || same) { const pk = Ls.find(x => x.g !== 'D') || Ls[0]; tees[bn] = { label: label(bn), cr: pk.t.cr, slope: pk.t.slope, est: false, yds: pk.t.yds }; }
        else Ls.forEach((x, i) => { let nm = bn + (x.g === 'D' ? ' Damas' : x.g === 'C' ? ' Caballeros' : (i ? ' ' + (i + 1) : '')); if (tees[nm]) nm += ' ' + (i + 1); tees[nm] = { label: label(nm), cr: x.t.cr, slope: x.t.slope, est: false, yds: x.t.yds }; }); });
      const first = T0[names[0]], si = first.si || [], okS = si.length === 18 && si.every(v => v >= 1 && v <= 18) && new Set(si).size === 18;
      let base0 = name.split(/[^A-Za-zÀ-ÿ]+/).filter(w => w.length > 2).map(w => w[0]).join('').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4);
      if (base0.length < 2) base0 = (name.replace(/[^A-Za-z]/g, '').toUpperCase() + 'GC').slice(0, 4);
      const taken = new Set((await sql`select code from gs_courses where code like ${base0 + '%'}`).map(x => x.code).concat(['CGC', 'TER', 'SIG'])); let code = base0, n = 2; while (taken.has(code)) code = base0 + (n++);
      for (const st of all.filter(x => pd(x).empty && nk(pd(x).name) === nk(name))) await sql`delete from gs_courses where code = ${st.code}`;
      const data = { name: (want === 9 ? (name + ' (9 x2)').slice(0, 60) : name), loc, unverified: true, noSI: okS ? undefined : true, addedBy: me, abbr: code, pins: { F: 'red', M: 'white', B: 'blue' }, par: first.par, hcp: okS ? si : first.par.map(() => 0), tees };
      await sql`insert into gs_courses (code, data, upd) values (${code}, ${JSON.stringify(data)}, ${Date.now()})`;
      return ({ code, course: data });
}
module.exports = { adopt };
