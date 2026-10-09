
function isoAdd(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dow(iso) { return new Date(iso + "T12:00:00Z").getUTCDay(); }
function buildDays(start, holidays, count) {
  const out = []; let cur = start; const hs = new Set(holidays);
  while (out.length < count) {
    const w = dow(cur);
    if (w !== 0 && w !== 6 && !hs.has(cur)) out.push(cur);
    cur = isoAdd(cur, 1);
  }
  return out;
}
function runSchedule(tasks, o) {
  // o: {hpd, startIdx, skip:Set(ids), fixed:{id:sched}}
  const hpd = o.hpd, res = {};
  const cur = { MJ: { d: o.startIdx, u: 0 }, JQ: { d: o.startIdx, u: 0 } };
  const place = (c, earliest, h) => {
    if (c.d < earliest) { c.d = earliest; c.u = 0; }
    const sl = []; let rem = h;
    while (rem > 0) {
      const take = Math.min(hpd - c.u, rem);
      sl.push({ d: c.d, h: take });
      c.u += take; rem -= take;
      if (c.u >= hpd) { c.d++; c.u = 0; }
    }
    return sl;
  };
  for (const t of tasks) {
    if (o.skip && o.skip.has(t.id)) { res[t.id] = o.fixed[t.id]; continue; }
    let earliest = o.startIdx;
    for (const dep of (t.deps || [])) {
      const r = res[dep]; if (!r) continue;
      const depT = tasks.find(x => x.id === dep);
      const same = depT && depT.o === t.o && t.o !== "AMBAS";
      earliest = Math.max(earliest, same ? r.e : r.e + 1);
    }
    let slices = [];
    if (t.o === "AMBAS") {
      const need = Math.min(t.h, hpd);
      let day = Math.max(earliest, cur.MJ.d, cur.JQ.d);
      const cap = (c) => c.d < day ? hpd : (c.d === day ? hpd - c.u : 0);
      while (cap(cur.MJ) < need || cap(cur.JQ) < need) day++;
      for (const p of ["MJ", "JQ"]) {
        const c = cur[p];
        if (c.d < day) { c.d = day; c.u = 0; }
        const sl = place(c, day, t.h);
        sl.forEach(s => slices.push({ ...s, p }));
      }
    } else {
      place(cur[t.o], earliest, t.h).forEach(s => slices.push({ ...s, p: t.o }));
    }
    const ds = slices.map(s => s.d);
    res[t.id] = { slices, s: Math.min(...ds), e: Math.max(...ds) };
  }
  return res;
}
if (typeof module !== "undefined") module.exports = { isoAdd, dow, buildDays, runSchedule };

