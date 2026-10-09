(function () {
"use strict";
const THEME_KEY = "imperiumlab.theme";
const DEFAULT_HOLIDAYS = ["2026-10-12","2026-11-02","2026-11-16","2026-12-08","2026-12-25","2027-01-01","2027-01-11"];
const STATUS = { pend: "Pendiente", doing: "En curso", block: "Bloqueada", done: "Hecha" };
const ST_ORDER = ["pend", "doing", "block", "done"];
const DOW = ["dom","lun","mar","mié","jue","vie","sáb"];
const DOWL = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
const MON = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const MONL = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const PEOPLE = ["MJ", "JQ"];
const TASK = Object.fromEntries(TASKS.map(t => [t.id, t]));
const PHASE = Object.fromEntries(PHASES.map(p => [p.id, p]));

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const TODAY = todayISO();

function defaults() {
  return {
    v: 1,
    names: { MJ: "MJ", JQ: "JQ" },
    roles: { MJ: "Datos, legal y plataforma", JQ: "Marca, producto y clientes" },
    start: "2026-10-09", hpd: 2, holidays: DEFAULT_HOLIDAYS.slice(), replan: false,
    tasks: {}, savedAt: null
  };
}
function merge(base, s) {
  const out = defaults();
  if (!s || typeof s !== "object") return out;
  if (s.names) Object.assign(out.names, s.names);
  if (s.roles) Object.assign(out.roles, s.roles);
  if (typeof s.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.start)) out.start = s.start;
  if ([1, 2, 3, 4].includes(Number(s.hpd))) out.hpd = Number(s.hpd);
  if (Array.isArray(s.holidays)) out.holidays = s.holidays.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
  out.replan = !!s.replan;
  if (s.tasks && typeof s.tasks === "object") {
    for (const [id, v] of Object.entries(s.tasks)) {
      if (!TASK[id] || !v) continue;
      out.tasks[id] = {
        st: STATUS[v.st] ? v.st : "pend",
        steps: Array.isArray(v.steps) ? v.steps.map(Boolean) : [],
        notes: typeof v.notes === "string" ? v.notes : "",
        doneAt: v.doneAt || ""
      };
    }
  }
  out.savedAt = s.savedAt || null;
  return out;
}
let state = defaults();
const ui = { view: "hoy", who: "all", phase: "all", day: null, drawer: null, confirmReset: false };

function hhmm(iso) { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function setSaved(msg, err) { const el = document.getElementById("saved"); if (!el) return; el.textContent = msg; el.classList.toggle("err", !!err); }

/* ---------- Supabase ---------- */
// sb y me llegan desde auth.js cuando hay sesión con segundo factor verificado.
let sb = null, me = null, syncOK = true;
// Última versión confirmada por el servidor, en JSON, para enviar solo lo que cambió.
const synced = { tasks: {}, config: "", names: {} };
function taskRow(id, t) {
  return { tarea_id: id, estado: t.st, pasos_hechos: t.steps.slice(0, 50).map(Boolean), notas: String(t.notes || "").slice(0, 10000), hecha_en: t.doneAt || null };
}
function rowToTask(r) {
  return { st: STATUS[r.estado] ? r.estado : "pend", steps: Array.isArray(r.pasos_hechos) ? r.pasos_hechos.map(Boolean) : [], notes: typeof r.notas === "string" ? r.notas : "", doneAt: r.hecha_en || "" };
}
function configRow() { return { fecha_inicio: state.start, horas_por_dia: state.hpd, festivos: state.holidays.slice(0, 100), replanificar: state.replan }; }
function cleanName(p) { return (state.names[p] || "").trim().slice(0, 40) || p; }
function markSynced() {
  synced.tasks = {};
  for (const id of Object.keys(state.tasks)) synced.tasks[id] = JSON.stringify(taskRow(id, state.tasks[id]));
  synced.config = JSON.stringify(configRow());
  synced.names = { MJ: cleanName("MJ"), JQ: cleanName("JQ") };
}
async function loadRemote() {
  const [cfg, per, prog] = await Promise.all([
    sb.from("plan_config").select("fecha_inicio,horas_por_dia,festivos,replanificar,updated_at").eq("id", 1).maybeSingle(),
    sb.from("personas").select("codigo,nombre,rol"),
    sb.from("tarea_progreso").select("tarea_id,estado,pasos_hechos,notas,hecha_en,updated_at")
  ]);
  for (const r of [cfg, per, prog]) if (r.error) throw r.error;
  const s = { names: {}, roles: {}, tasks: {}, savedAt: null };
  if (cfg.data) Object.assign(s, { start: cfg.data.fecha_inicio, hpd: cfg.data.horas_por_dia, holidays: cfg.data.festivos, replan: cfg.data.replanificar, savedAt: cfg.data.updated_at });
  for (const p of per.data || []) if (PEOPLE.includes(p.codigo)) { s.names[p.codigo] = p.nombre; s.roles[p.codigo] = p.rol; }
  for (const r of prog.data || []) {
    s.tasks[r.tarea_id] = rowToTask(r);
    if (!s.savedAt || r.updated_at > s.savedAt) s.savedAt = r.updated_at;
  }
  state = merge(null, s); // merge descarta valores fuera de formato
  markSynced();
}
async function pushChanges() {
  const up = Object.keys(state.tasks).filter(id => synced.tasks[id] !== JSON.stringify(taskRow(id, state.tasks[id])));
  const del = Object.keys(synced.tasks).filter(id => !state.tasks[id]);
  if (up.length) {
    const rows = up.map(id => taskRow(id, state.tasks[id])); const snap = rows.map(r => JSON.stringify(r));
    const { error } = await sb.from("tarea_progreso").upsert(rows);
    if (error) throw error;
    up.forEach((id, i) => { synced.tasks[id] = snap[i]; });
  }
  if (del.length) {
    const { error } = await sb.from("tarea_progreso").delete().in("tarea_id", del);
    if (error) throw error;
    del.forEach(id => { delete synced.tasks[id]; });
  }
  const cfg = configRow(), cj = JSON.stringify(cfg);
  if (cj !== synced.config) {
    const { error } = await sb.from("plan_config").update(cfg).eq("id", 1);
    if (error) throw error;
    synced.config = cj;
  }
  for (const p of PEOPLE) {
    const n = cleanName(p);
    if (n === synced.names[p]) continue;
    const { error } = await sb.from("personas").update({ nombre: n }).eq("codigo", p);
    if (error) throw error;
    synced.names[p] = n;
  }
}
let saving = null, saveAgain = false, retryTimer = null;
function save() {
  if (!sb) return;
  if (saving) { saveAgain = true; return; }
  clearTimeout(retryTimer);
  setSaved("Guardando…");
  saving = (async () => { do { saveAgain = false; await pushChanges(); } while (saveAgain); })()
    .then(() => { syncOK = true; state.savedAt = new Date().toISOString(); setSaved("Guardado " + hhmm(state.savedAt)); },
      () => { syncOK = false; setSaved("Sin conexión: cambios sin guardar. Reintentando…", true); retryTimer = setTimeout(save, 8000); })
    .finally(() => { saving = null; });
}
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; save(); }, 600); }
function hasPending() { return !!(saveTimer || saving || !syncOK); }

/* Cambios de la otra socia en tiempo real. Los propios se ignoran (updated_by = me). */
let refreshPending = false;
function remoteRefresh() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox") { refreshPending = true; return; }
  refresh();
}
document.addEventListener("focusout", () => { if (refreshPending) setTimeout(() => { if (refreshPending) { refreshPending = false; remoteRefresh(); } }, 0); });
function subscribe() {
  sb.channel("plan")
    .on("postgres_changes", { event: "*", schema: "public", table: "tarea_progreso" }, p => {
      if (p.eventType === "DELETE") {
        const id = p.old && p.old.tarea_id;
        if (!id || !state.tasks[id]) return;
        delete state.tasks[id]; delete synced.tasks[id];
      } else {
        const r = p.new;
        if (!r || r.updated_by === me || !TASK[r.tarea_id]) return;
        state.tasks[r.tarea_id] = rowToTask(r);
        synced.tasks[r.tarea_id] = JSON.stringify(taskRow(r.tarea_id, state.tasks[r.tarea_id]));
      }
      remoteRefresh();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "plan_config" }, p => {
      const r = p.new;
      if (!r || r.updated_by === me) return;
      state = merge(null, Object.assign({}, state, { start: r.fecha_inicio, hpd: r.horas_por_dia, holidays: r.festivos, replan: r.replanificar }));
      synced.config = JSON.stringify(configRow());
      remoteRefresh();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "personas" }, p => {
      const r = p.new;
      if (!r || !PEOPLE.includes(r.codigo) || typeof r.nombre !== "string") return;
      state.names[r.codigo] = r.nombre.slice(0, 40); synced.names[r.codigo] = cleanName(r.codigo);
      remoteRefresh();
    })
    .subscribe();
}
window.addEventListener("beforeunload", e => { if (hasPending()) { e.preventDefault(); e.returnValue = ""; } });

function ts(id) {
  if (!state.tasks[id]) state.tasks[id] = { st: "pend", steps: [], notes: "", doneAt: "" };
  return state.tasks[id];
}
function stOf(id) { return state.tasks[id] ? state.tasks[id].st : "pend"; }
function stepsDone(id) { const t = TASK[id]; const s = state.tasks[id]; if (!s) return 0; return t.steps.reduce((n, _, i) => n + (s.steps[i] ? 1 : 0), 0); }
function name(p) { return (state.names[p] || "").trim() || p; }
function ownerLabel(o) { return o === "AMBAS" ? "Ambas" : name(o); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---------- schedule ---------- */
let CAL = null;
function computeSchedule() {
  const days = buildDays(state.start, state.holidays, 500);
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const base = runSchedule(TASKS, { hpd: state.hpd, startIdx: 0 });
  let sched = base;
  if (state.replan) {
    let ti = days.findIndex(d => d >= TODAY);
    if (ti > 0) {
      const skip = new Set(TASKS.filter(t => stOf(t.id) === "done").map(t => t.id));
      sched = runSchedule(TASKS, { hpd: state.hpd, startIdx: ti, skip, fixed: base });
    }
  }
  CAL = { days, idx, sched };
}
function sOf(id) { return CAL.sched[id]; }
function dStart(id) { return CAL.days[sOf(id).s]; }
function dEnd(id) { return CAL.days[sOf(id).e]; }
function isLate(id) { return stOf(id) !== "done" && dEnd(id) < TODAY; }
function waitingOn(id) { return (TASK[id].deps || []).filter(d => stOf(d) !== "done"); }
function personTasks(p) { return TASKS.filter(t => t.o === p || t.o === "AMBAS"); }

function fmt(iso) { const d = new Date(iso + "T12:00:00Z"); return DOW[d.getUTCDay()] + " " + d.getUTCDate() + " " + MON[d.getUTCMonth()]; }
function fmtLong(iso) { const d = new Date(iso + "T12:00:00Z"); return DOWL[d.getUTCDay()] + " " + d.getUTCDate() + " de " + MONL[d.getUTCMonth()]; }
function range(id) { const a = dStart(id), b = dEnd(id); return a === b ? fmt(a) : fmt(a) + " → " + fmt(b); }

/* ---------- progress ---------- */
function pctFor(list, p) {
  let tot = 0, done = 0;
  for (const t of list) { tot += t.h; if (stOf(t.id) === "done") done += t.h; }
  return tot ? Math.round(done / tot * 100) : 0;
}
function hoursLeft(p) { return personTasks(p).filter(t => stOf(t.id) !== "done").reduce((n, t) => n + t.h, 0); }

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg) {
  const root = document.getElementById("toastRoot");
  root.innerHTML = '<div class="toast" role="status">' + esc(msg) + "</div>";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { root.innerHTML = ""; }, 2200);
}
function copyText(text, okMsg) {
  const fallback = () => {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(okMsg); } catch (e) { toast("Selecciona el texto y cópialo"); }
    ta.remove();
  };
  try { navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback); } catch (e) { fallback(); }
}

/* ---------- actions ---------- */
function setStatus(id, st) {
  const s = ts(id); s.st = st;
  if (st === "done") s.doneAt = TODAY; else s.doneAt = "";
  save(); refresh();
  toast(id + " · " + STATUS[st]);
}
function toggleStep(id, i, val) {
  const s = ts(id); const t = TASK[id];
  while (s.steps.length < t.steps.length) s.steps.push(false);
  s.steps[i] = val;
  if (val && s.st === "pend") s.st = "doing";
  save(); refresh();
}
function gcalUrl(id) {
  const t = TASK[id];
  const a = dStart(id).replace(/-/g, ""), b = isoAdd(dEnd(id), 1).replace(/-/g, "");
  const det = [ownerLabel(t.o) + " · " + t.h + " h · " + PHASE[t.f].n + " " + PHASE[t.f].name, "", t.why, "", "Paso a paso:"]
    .concat(t.steps.map((s, i) => (i + 1) + ". " + s)).concat(["", "Entregable: " + t.out]).join("\n");
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(t.id + " · " + t.t) +
    "&dates=" + a + "/" + b + "&details=" + encodeURIComponent(det);
}
function stepsText(id) {
  const t = TASK[id];
  return t.id + " · " + t.t + "\n" + ownerLabel(t.o) + " · " + t.h + " h · " + range(id) + "\n\n" +
    t.steps.map((s, i) => (i + 1) + ". " + s).join("\n") + "\n\nEntregable: " + t.out;
}

/* ---------- pieces ---------- */
function ownerChip(o) { return '<span class="chip ' + o + '"><span class="dot ' + o + '"></span>' + esc(ownerLabel(o)) + "</span>"; }
function pill(st) { return '<span class="pill ' + st + '">' + STATUS[st] + "</span>"; }
function badges(id) {
  let h = "";
  if (TASK[id].gate) h += '<span class="pill gate">Puerta</span>';
  if (isLate(id)) h += '<span class="pill late">Atrasada</span>';
  return h;
}
function stepsList(id, compact) {
  const t = TASK[id], s = state.tasks[id];
  return '<ul class="steps">' + t.steps.map((txt, i) => {
    const on = s && s.steps[i];
    return '<li><label><input type="checkbox" data-step="' + id + "|" + i + '"' + (on ? " checked" : "") + "><span>" +
      '<span class="n">' + (i + 1) + "</span>" + esc(txt) + "</span></label></li>";
  }).join("") + "</ul>";
}

/* ---------- summary ---------- */
function renderSummary() {
  const done = TASKS.filter(t => stOf(t.id) === "done").length;
  const pct = pctFor(TASKS);
  const nextGate = TASKS.find(t => t.gate && stOf(t.id) !== "done");
  const late = TASKS.filter(t => isLate(t.id)).length;
  const last = TASKS.reduce((m, t) => dEnd(t.id) > m ? dEnd(t.id) : m, "");
  const people = PEOPLE.map(p => {
    const pp = pctFor(personTasks(p));
    return '<div class="prow"><span class="chip ' + p + '">' + esc(name(p)) + '</span><div class="bar ' + p.toLowerCase() + '"><i style="width:' + pp + '%"></i></div><span class="mono">' + pp + "%</span></div>";
  }).join("");
  document.getElementById("summary").innerHTML =
    '<div class="stat"><div class="lbl">Avance del plan</div><div class="val">' + pct + '%</div><div class="bar"><i style="width:' + pct + '%"></i></div><div class="sub" style="margin-top:6px">' + done + " de " + TASKS.length + " tareas hechas · medido en horas</div></div>" +
    '<div class="stat"><div class="lbl">Por persona</div><div class="people">' + people + '</div><div class="sub" style="margin-top:6px">Faltan ' + hoursLeft("MJ") + " h de " + esc(name("MJ")) + " y " + hoursLeft("JQ") + " h de " + esc(name("JQ")) + "</div></div>" +
    '<div class="stat"><div class="lbl">Próxima puerta</div>' + (nextGate
      ? '<div class="val" style="font-size:18px;margin-top:4px">' + PHASE[nextGate.f].n + " · " + esc(PHASE[nextGate.f].name) + '</div><div class="sub">' + esc(PHASE[nextGate.f].gate) + '</div><div class="sub mono" style="margin-top:4px">Prevista: ' + fmt(dEnd(nextGate.id)) + "</div>"
      : '<div class="val">Todas</div><div class="sub">Las 5 puertas están cruzadas</div>') + "</div>" +
    '<div class="stat"><div class="lbl">Ritmo</div><div class="val">' + (late ? '<span style="color:var(--crit)">' + late + " atrasada" + (late > 1 ? "s" : "") + "</span>" : "Al día") + '</div><div class="sub">Fin previsto: ' + (last ? fmt(last) : "—") + "</div><div class=\"sub\">Inicio: " + fmt(state.start) + " · " + state.hpd + " h/día por persona</div></div>";
}

/* ---------- views ---------- */
function workdayOnOrAfter(iso) { const d = CAL.days.find(x => x >= iso); return d || CAL.days[0]; }
function renderHoy() {
  if (!ui.day) ui.day = workdayOnOrAfter(TODAY < state.start ? state.start : TODAY);
  const day = ui.day; const di = CAL.idx[day];
  const isWork = di !== undefined;
  const per = { MJ: [], JQ: [] };
  if (isWork) {
    for (const t of TASKS) {
      for (const s of sOf(t.id).slices) if (s.d === di) per[s.p].push({ t, h: s.h });
    }
  }
  let head = '<div class="toolbar"><h2>Qué toca ' + (day === TODAY ? "hoy" : "este día") + '</h2><div class="daynav">' +
    '<button class="btn sm" data-act="dayprev" aria-label="Día laboral anterior">‹</button>' +
    '<span class="d">' + fmtLong(day) + "</span>" +
    '<button class="btn sm" data-act="daynext" aria-label="Día laboral siguiente">›</button>' +
    '<button class="btn sm" data-act="daytoday">Hoy</button></div></div>';
  if (TODAY < state.start && day === CAL.days[0]) head += '<p class="note" style="margin:0 0 14px">El plan arranca el ' + fmtLong(state.start) + ". Esto es lo que toca ese día.</p>";
  if (!isWork) head += '<p class="note warn" style="margin:0 0 14px">Este día no es laboral en el plan (fin de semana, festivo o antes del inicio).</p>';
  const cols = PEOPLE.map(p => {
    const other = PEOPLE.find(x => x !== p);
    const blocks = per[p];
    const hrs = blocks.reduce((n, b) => n + b.h, 0);
    let body;
    if (!blocks.length) {
      const nxt = personTasks(p).find(t => stOf(t.id) !== "done" && dStart(t.id) > day);
      body = '<div class="empty">Sin tarea asignada este día. Adelanta tu siguiente tarea o apoya a ' + esc(name(other)) + "." +
        (nxt && isWork ? '<div style="margin-top:10px"><button class="btn sm" data-open="' + nxt.id + '">Siguiente: ' + nxt.id + " · " + esc(nxt.t) + "</button></div>" : "") + "</div>";
    } else {
      body = '<div class="blocks">' + blocks.map(({ t, h }) => {
        const mine = [...new Set(sOf(t.id).slices.filter(s => s.p === p).map(s => s.d))];
        const k = mine.indexOf(di) + 1;
        const wait = waitingOn(t.id);
        const st = stOf(t.id);
        return '<article class="block"><div class="block-h"><span class="hrs-chip">' + h + ' h</span><span class="tid">' + t.id + "</span>" +
          '<span class="chip">' + PHASE[t.f].n + " · " + esc(PHASE[t.f].name) + "</span>" + pill(st) + badges(t.id) +
          (mine.length > 1 ? '<span class="chip">Sesión ' + k + " de " + mine.length + "</span>" : "") +
          (t.o === "AMBAS" ? '<span class="chip AMBAS">Con ' + esc(name(other)) + "</span>" : "") + "</div>" +
          "<h3>" + esc(t.t) + '</h3><p class="why">' + esc(t.why) + "</p>" + stepsList(t.id) +
          '<div class="block-f">' + (wait.length ? '<span class="wait">Espera: ' + wait.join(", ") + "</span>" : "") +
          '<button class="btn sm" data-open="' + t.id + '">Ver detalle</button>' +
          (st === "pend" ? '<button class="btn sm" data-status="' + t.id + '|doing">Empezar</button>' : "") +
          (st !== "done" ? '<button class="btn sm primary" data-status="' + t.id + '|done">Marcar hecha</button>' : '<span class="pill done">Hecha</span>') +
          "</div></article>";
      }).join("") + "</div>";
    }
    return '<section class="col ' + p + '"><div class="col-h"><div><div class="who">' + esc(name(p)) + '</div><div class="role">' + esc(state.roles[p] || "") + '</div></div><div class="hrs">' + hrs + " h</div></div>" + body + "</section>";
  }).join("");
  return head + '<div class="cols">' + cols + "</div>";
}

function filters(withPhase) {
  const segs = [["all", "Todas"], ["MJ", name("MJ")], ["JQ", name("JQ")]]
    .map(([k, l]) => '<button data-who="' + k + '" aria-pressed="' + (ui.who === k) + '">' + esc(l) + "</button>").join("");
  let ph = "";
  if (withPhase) ph = '<label class="muted" style="font-size:13px">Fase <select id="phaseSel" class="btn sm" style="padding:4px 6px">' +
    '<option value="all">Todas</option>' + PHASES.map(p => '<option value="' + p.id + '"' + (ui.phase === p.id ? " selected" : "") + ">" + p.n + " · " + esc(p.name) + "</option>").join("") + "</select></label>";
  return '<div class="seg" role="group" aria-label="Filtrar por persona">' + segs + "</div>" + ph;
}
function matchWho(t) { return ui.who === "all" || t.o === ui.who || t.o === "AMBAS"; }

function renderTablero() {
  const list = TASKS.filter(t => matchWho(t) && (ui.phase === "all" || t.f === ui.phase));
  const cols = ST_ORDER.map(st => {
    const items = list.filter(t => stOf(t.id) === st).sort((a, b) => sOf(a.id).s - sOf(b.id).s);
    return '<section class="kcol" data-drop="' + st + '"><div class="kcol-h">' + pill(st) + '<span class="c">' + items.length + '</span></div><div class="kcards">' +
      items.map(t => {
        const n = stepsDone(t.id), p = Math.round(n / t.steps.length * 100);
        return '<button class="card" draggable="true" data-drag="' + t.id + '" data-open="' + t.id + '">' +
          '<div class="meta"><span class="tid">' + t.id + "</span>" + ownerChip(t.o) + badges(t.id) + '</div><div class="t">' + esc(t.t) + "</div>" +
          '<div class="meta"><span class="mono">' + range(t.id) + "</span><span>· " + t.h + " h</span><span>· " + n + "/" + t.steps.length + ' pasos</span></div><div class="mini"><i style="width:' + p + '%"></i></div></button>';
      }).join("") + "</div></section>";
  }).join("");
  return '<div class="toolbar"><h2>Tablero</h2>' + filters(true) + '</div><p class="muted" style="margin:-4px 0 12px;font-size:13px">Arrastra una tarjeta para cambiar su estado, o ábrela para ver el paso a paso.</p><div class="kanban">' + cols + "</div>";
}

function renderCrono() {
  const who = ui.who === "all" ? PEOPLE : [ui.who];
  const lastIdx = Math.max(...TASKS.map(t => sOf(t.id).e));
  const lastDay = CAL.days[lastIdx];
  const per = {};
  for (const t of TASKS) for (const s of sOf(t.id).slices) {
    const key = s.p + "|" + s.d; (per[key] = per[key] || []).push({ t, h: s.h });
  }
  let mon = state.start; while (dow(mon) !== 1) mon = isoAdd(mon, -1);
  const weeks = []; let wn = 1;
  while (mon <= lastDay) {
    const dates = [0, 1, 2, 3, 4].map(i => isoAdd(mon, i));
    const gates = TASKS.filter(t => t.gate && dates.includes(dEnd(t.id)));
    let grid = '<div class="hd"></div>' + dates.map(d => '<div class="hd' + (d === TODAY ? " today" : "") + '">' + fmt(d) + "</div>").join("");
    for (const p of who) {
      grid += '<div class="rowlbl"><span class="dot ' + p + '"></span>' + esc(name(p)) + "</div>";
      for (const d of dates) {
        const di = CAL.idx[d];
        if (di === undefined) { grid += '<div class="off">' + (state.holidays.includes(d) ? "Festivo" : (d < state.start ? "Antes del inicio" : "")) + "</div>"; continue; }
        const items = per[p + "|" + di] || [];
        grid += '<div class="cell' + (d === TODAY ? " today" : "") + '">' + items.map(({ t, h }) =>
          '<button class="tchip ' + t.o + (stOf(t.id) === "done" ? " done" : "") + (isLate(t.id) ? " late" : "") + '" data-open="' + t.id + '"><b>' + t.id + " · " + h + " h" + (t.gate ? " · ◆" : "") + "</b><span>" + esc(t.t) + "</span></button>").join("") + "</div>";
      }
    }
    const thisWeek = TODAY >= mon && TODAY <= isoAdd(mon, 6);
    weeks.push('<section class="week"' + (thisWeek ? ' id="thisweek"' : "") + '><div class="week-h"><h3>Semana ' + wn + '</h3><span class="r">' + fmt(dates[0]) + " a " + fmt(dates[4]) + "</span>" +
      (gates.length ? '<span class="g">' + gates.map(g => '<span class="pill gate">◆ Puerta ' + PHASE[g.f].n + "</span>").join(" ") + "</span>" : "") +
      '</div><div class="gridwrap"><div class="wgrid">' + grid + "</div></div></section>");
    mon = isoAdd(mon, 7); wn++;
  }
  return '<div class="toolbar"><h2>Cronograma</h2>' + filters(false) + '</div><p class="muted" style="margin:-4px 0 12px;font-size:13px">Cada bloque es una sesión de trabajo. ◆ marca una puerta de fase. Los festivos se ajustan en Ajustes.</p><div class="weeks">' + weeks.join("") + "</div>";
}

function renderFases() {
  return '<div class="toolbar"><h2>Fases y puertas</h2>' + filters(false) + '</div><div class="phases">' + PHASES.map(p => {
    const all = TASKS.filter(t => t.f === p.id);
    const list = all.filter(matchWho);
    const pct = pctFor(all);
    const gateT = all.find(t => t.gate);
    const gateOk = gateT && stOf(gateT.id) === "done";
    const s = Math.min(...all.map(t => sOf(t.id).s)), e = Math.max(...all.map(t => sOf(t.id).e));
    const done = all.filter(t => stOf(t.id) === "done").length;
    return '<section class="phase"><div class="phase-h"><div><div class="n">' + p.n + " · " + fmt(CAL.days[s]) + " a " + fmt(CAL.days[e]) + "</div><h3>" + esc(p.name) + '</h3></div><div class="pct">' + pct + '%</div></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="gate"><span class="diamond' + (gateOk ? " ok" : "") + '"></span><span><strong>Puerta:</strong> ' + esc(p.gate) + (gateT ? " (" + gateT.id + ")" : "") + '</span><span class="muted" style="margin-left:auto">' + done + "/" + all.length + " tareas</span></div>" +
      '<div class="tlist">' + list.map(t => '<button class="trow" data-open="' + t.id + '"><span class="tid">' + t.id + '</span><span class="t">' + esc(t.t) + " " + badges(t.id) + "</span>" + ownerChip(t.o) + '<span class="dates mono">' + range(t.id) + "</span></button>").join("") + "</div></section>";
  }).join("") + "</div>";
}

/* ---------- marca ---------- */
function lum(hex) {
  const h = hex.replace("#", ""); const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function verdict(r) { return r >= 4.5 ? '<span class="ok">AA</span>' : r >= 3 ? '<span class="mid">Solo grande</span>' : '<span class="bad">No pasa</span>'; }
const PALETTE = [
  ["Violeta", "#7B5CFF", "Principal (30%). Botones, enlaces, títulos, ícono."],
  ["Azul", "#3B9EFF", "Apoyo. Confianza para clientes comerciales."],
  ["Turquesa", "#2DD4BF", "Apoyo. Degradado en banners y detalles."],
  ["Magenta", "#E85CD8", "Apoyo. Degradado, energía y modernidad."],
  ["Negro violáceo", "#0D0D12", "Fondos oscuros donde el logo debe brillar."],
  ["Naranja", "#FF6B35", "Solo botones de acción (Comprar, Contáctanos)."]
];
const CHANGES = [
  ["Nombre y dominio: «Imperial Tech» y «soyimperialtech.com» pasan a «Imperium Lab» e «imperiumlab.co».", ["T26"]],
  ["Logo: conservar la corona de tres formas y la «I» central, que ahora es la de Imperium. Nuevo wordmark, versiones y tamaño mínimo.", ["T22", "T23", "T24"]],
  ["Pilar 2 «herramientas no-code»: choca con el diferenciador de webs hechas con buenas prácticas verificables.", ["T20", "T26"]],
  ["Promesa con la IA al centro: replantear como «la IA es una herramienta; cada sitio lo revisa y prueba una persona».", ["T21", "T26"]],
  ["Misión y posicionamiento («micronegocios que no pueden pagar una agencia»): alinear con la vertical y los precios decididos.", ["T04", "T05", "T26"]],
  ["Contraste: violeta con texto blanco 4,36:1 y naranja con texto blanco 2,84:1 no pasan WCAG AA para texto normal.", ["T25"]],
  ["Tipografía: el manual describe el estilo pero no nombra las familias.", ["T25"]],
  ["Tono: el manual menciona «vos» en redes; definir tú o usted para el público de Bogotá.", ["T21"]],
  ["Faltan secciones: usos del logo, área de respeto, iconografía, fotografía, componentes web y plantillas.", ["T27", "T28"]]
];
function renderMarca() {
  const sw = PALETTE.map(([n, hex, use]) => {
    const rw = ratio(hex, "#FFFFFF"), rd = ratio(hex, "#0D0D12");
    const best = rw >= rd ? "#FFFFFF" : "#0D0D12";
    return '<div class="sw"><div class="c" style="background:' + hex + '"><span style="background:' + best + ";color:" + hex + '">' + hex + '</span></div><div class="b"><strong>' + n + "</strong><span class=\"muted\">" + esc(use) + "</span>" +
      '<div class="cr"><span>Texto blanco encima</span><span class="mono">' + rw.toFixed(2) + ":1 " + verdict(rw) + "</span></div>" +
      '<div class="cr"><span>Texto #0D0D12 encima</span><span class="mono">' + rd.toFixed(2) + ":1 " + verdict(rd) + "</span></div>" +
      '<button class="btn sm" data-copy="' + hex + '">Copiar ' + hex + "</button></div></div>";
  }).join("");
  const pairs = [
    ["#FF6B35", "#FFFFFF", "Agenda tu diagnóstico", "Actual: naranja con texto blanco"],
    ["#FF6B35", "#0D0D12", "Agenda tu diagnóstico", "Propuesta: naranja con texto oscuro"],
    ["#7B5CFF", "#FFFFFF", "Ver servicios", "Actual: violeta con texto blanco"],
    ["#6A4BF0", "#FFFFFF", "Ver servicios", "Propuesta: violeta un tono más oscuro"],
    ["#0D0D12", "#9D86FF", "Ver servicios", "Propuesta en fondo oscuro: violeta claro"]
  ].map(([bg, fg, txt, lbl]) => {
    const r = ratio(bg, fg);
    return '<div class="pair"><span class="demo" style="background:' + bg + ";color:" + fg + '">' + txt + "</span><span>" + lbl + '</span><span class="mono">' + r.toFixed(2) + ":1 " + verdict(r) + "</span></div>";
  }).join("");
  const changes = CHANGES.map(([txt, ids]) => "<li>" + esc(txt) + " " + ids.map(id => '<button class="btn sm ghost" data-open="' + id + '">' + id + "</button>").join("") + "</li>").join("");
  return '<div class="toolbar"><h2>Marca: qué hay hoy y qué cambia</h2></div>' +
    '<p class="note" style="margin:0 0 14px">Esta paleta sale del manual actual de Imperial Tech (regla 60-30-10: 60% neutros, 30% violeta, 10% degradado). El contraste se calcula con la fórmula de WCAG: AA pide 4,5:1 para texto normal y 3:1 para texto grande.</p>' +
    '<div class="swatches">' + sw + "</div>" +
    '<div class="two" style="margin-top:16px"><div class="panel"><h3>Qué cambia en el manual</h3><ol class="changes">' + changes + "</ol></div>" +
    '<div class="panel"><h3>Botones: actual frente a propuesta</h3><div class="pairs">' + pairs + "</div>" +
    '<h3 style="margin-top:16px">Se conserva</h3><ul class="changes"><li>La regla 60-30-10 y el degradado solo en acentos.</li><li>El naranja reservado para botones de acción.</li><li>El significado de las tres formas: presencia, automatización y crecimiento.</li><li>Los eslóganes, si siguen encajando con la promesa nueva (se revisan en T26).</li></ul></div></div>';
}

/* ---------- ajustes ---------- */
function renderAjustes() {
  const last = state.savedAt ? "Último guardado: " + new Date(state.savedAt).toLocaleString("es-CO") : "Aún no hay cambios guardados.";
  return '<div class="toolbar"><h2>Ajustes</h2></div><div class="form">' +
    '<p class="note' + (syncOK ? "" : " warn") + '" style="margin:0">' + (syncOK
      ? "El progreso se guarda en la base de datos y las dos ven los cambios al instante. " + esc(last)
      : "Hay cambios que no se han podido guardar. Revisa tu conexión; se reintenta solo.") + "</p>" +
    '<div class="row2"><div class="field"><label for="nMJ">Nombre de MJ</label><input id="nMJ" data-set="names.MJ" value="' + esc(state.names.MJ) + '"><span class="hint">Datos, legal y plataforma</span></div>' +
    '<div class="field"><label for="nJQ">Nombre de JQ</label><input id="nJQ" data-set="names.JQ" value="' + esc(state.names.JQ) + '"><span class="hint">Marca, producto y clientes</span></div></div>' +
    '<div class="row2"><div class="field"><label for="start">Fecha de inicio</label><input type="date" id="start" data-set="start" value="' + state.start + '"></div>' +
    '<div class="field"><label for="hpd">Horas al día por persona</label><select id="hpd" data-set="hpd">' + [1, 2, 3, 4].map(n => '<option value="' + n + '"' + (n === state.hpd ? " selected" : "") + ">" + n + " h</option>").join("") + "</select></div></div>" +
    '<div class="field"><label for="hol">Festivos (uno por línea, AAAA-MM-DD)</label><textarea id="hol" data-set="holidays">' + esc(state.holidays.join("\n")) + '</textarea><span class="hint">Festivos de Colombia calculados para oct 2026 a ene 2027. Verifíquenlos con el calendario oficial.</span></div>' +
    '<label class="switch"><input type="checkbox" id="replan" data-set="replan"' + (state.replan ? " checked" : "") + '><span><strong>Reprogramar lo pendiente desde hoy</strong><br><span class="muted">Si se atrasan, las tareas no hechas se recalculan a partir de hoy. Las hechas conservan su fecha.</span></span></label>' +
    '<div class="field"><label>Copia de seguridad</label><div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn primary" data-act="export">Exportar progreso (.json)</button>' +
    '<label class="btn" for="importFile">Importar progreso</label><input type="file" id="importFile" accept="application/json,.json" hidden>' +
    '<button class="btn" data-act="copyweek">Copiar resumen de la semana</button>' +
    '<button class="btn danger" data-act="reset">Borrar todo el progreso</button></div>' +
    (ui.confirmReset ? '<div class="confirm" style="margin-top:8px">¿Borrar estados, pasos y notas de las ' + TASKS.length + ' tareas para las dos? No se puede deshacer. <button class="btn sm danger" data-act="resetyes">Sí, borrar</button><button class="btn sm" data-act="resetno">Cancelar</button></div>' : "") +
    "</div>" +
    '<div class="field"><label>Seguridad</label><div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn" data-act="signoutall">Cerrar sesión en todos los dispositivos</button></div>' +
    '<span class="hint">Úsalo si perdiste un equipo o crees que alguien más entró. La sesión también se cierra sola tras un rato sin actividad.</span></div>' +
    "</div>";
}

/* ---------- drawer ---------- */
function renderDrawer() {
  const root = document.getElementById("drawerRoot");
  if (!ui.drawer) { root.innerHTML = ""; return; }
  const t = TASK[ui.drawer]; const s = ts(t.id); const st = s.st;
  const n = stepsDone(t.id);
  const slices = sOf(t.id).slices;
  const byDay = {};
  slices.forEach(x => { const k = CAL.days[x.d]; byDay[k] = byDay[k] || []; byDay[k].push(x.p); });
  const sessions = Object.entries(byDay).map(([d, ps]) => fmt(d) + " (" + [...new Set(ps)].map(p => esc(name(p))).join(" y ") + ")").join(" · ");
  const deps = (t.deps || []).map(d => '<button data-open="' + d + '"><span class="dot ' + TASK[d].o + '"></span>' + d + " · " + STATUS[stOf(d)] + "</button>").join("");
  const after = TASKS.filter(x => (x.deps || []).includes(t.id)).map(x => '<button data-open="' + x.id + '"><span class="dot ' + x.o + '"></span>' + x.id + "</button>").join("");
  const prevBody = root.querySelector(".dr-b"); const prevScroll = prevBody ? prevBody.scrollTop : 0;
  const anim = ui.justOpened ? " anim" : ""; ui.justOpened = false;
  const res = t.res.map(k => L[k] ? '<li><a href="' + L[k][1] + '" target="_blank" rel="noopener noreferrer">' + esc(L[k][0]) + "</a></li>" : "").join("");
  root.innerHTML = '<div class="scrim" data-act="close"></div><aside class="drawer' + anim + '" role="dialog" aria-modal="true" aria-labelledby="drTitle">' +
    '<div class="dr-h"><div class="dr-top"><span class="tid">' + t.id + '</span><span class="chip">' + PHASE[t.f].n + " · " + esc(PHASE[t.f].name) + "</span>" + ownerChip(t.o) + badges(t.id) +
    '<button class="btn iconbtn ghost x" data-act="close" aria-label="Cerrar">✕</button></div><h2 id="drTitle">' + esc(t.t) + "</h2>" +
    '<div class="statuses" role="group" aria-label="Estado">' + ST_ORDER.map(k => '<button class="' + k + '" data-status="' + t.id + "|" + k + '" aria-pressed="' + (st === k) + '">' + STATUS[k] + "</button>").join("") + "</div></div>" +
    '<div class="dr-b">' +
    '<div class="sec"><h4>Por qué</h4><p>' + esc(t.why) + "</p></div>" +
    '<div class="sec"><dl class="kv"><dt>Responsable</dt><dd>' + esc(ownerLabel(t.o)) + (t.o === "AMBAS" ? " (sesión conjunta)" : "") + "</dd><dt>Esfuerzo</dt><dd>" + t.h + " h" + (t.o === "AMBAS" ? " cada una" : "") + "</dd><dt>Fechas</dt><dd class=\"mono\">" + range(t.id) + "</dd><dt>Sesiones</dt><dd>" + sessions + "</dd></dl></div>" +
    '<div class="sec"><h4>Paso a paso · ' + n + " de " + t.steps.length + "</h4>" + stepsList(t.id) +
    (n === t.steps.length && st !== "done" ? '<div style="margin-top:8px"><button class="btn primary" data-status="' + t.id + '|done">Todos los pasos listos: marcar hecha</button></div>' : "") + "</div>" +
    '<div class="sec"><h4>Entregable</h4><p>' + esc(t.out) + '</p></div><div class="sec"><h4>Listo cuando</h4><p>' + esc(t.done) + "</p></div>" +
    (deps ? '<div class="sec"><h4>Necesita antes</h4><div class="deps">' + deps + "</div></div>" : "") +
    (after ? '<div class="sec"><h4>Desbloquea</h4><div class="deps">' + after + "</div></div>" : "") +
    (res ? '<div class="sec"><h4>Fuentes y recursos</h4><ul class="res">' + res + "</ul></div>" : "") +
    '<div class="sec"><h4>Notas</h4><textarea class="notes" id="notes" data-notes="' + t.id + '" placeholder="Decisiones, enlaces, pendientes…">' + esc(s.notes || "") + "</textarea></div>" +
    '<div class="sec" style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="' + gcalUrl(t.id) + '" target="_blank" rel="noopener noreferrer">Agregar a Google Calendar</a><button class="btn" data-copysteps="' + t.id + '">Copiar paso a paso</button></div>' +
    "</div></aside>";
  const nb = root.querySelector(".dr-b"); if (nb && !anim) nb.scrollTop = prevScroll;
  const x = root.querySelector(".x"); if (x && !root.dataset.focused) { x.focus(); root.dataset.focused = "1"; }
}
function openTask(id) { ui.drawer = id; ui.justOpened = true; document.getElementById("drawerRoot").dataset.focused = ""; renderDrawer(); }
function closeDrawer() { ui.drawer = null; renderDrawer(); }

/* ---------- main render ---------- */
function render() {
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", String(b.dataset.view === ui.view)));
  const v = document.getElementById("view");
  const fn = { hoy: renderHoy, tablero: renderTablero, crono: renderCrono, fases: renderFases, marca: renderMarca, ajustes: renderAjustes }[ui.view];
  v.innerHTML = fn();
  document.getElementById("subtitle").textContent = name("MJ") + " y " + name("JQ") + " · " + state.hpd + " h al día cada una · desde " + fmt(state.start);
}
function refresh() { computeSchedule(); renderSummary(); render(); renderDrawer(); }

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const el = e.target.closest("[data-open],[data-status],[data-act],[data-who],[data-copy],[data-copysteps],.tab");
  if (!el) return;
  if (el.classList.contains("tab")) { ui.view = el.dataset.view; render(); if (ui.view === "crono") { const w = document.getElementById("thisweek"); if (w) w.scrollIntoView({ block: "start" }); } return; }
  if (el.dataset.status) { const [id, st] = el.dataset.status.split("|"); setStatus(id, st); return; }
  if (el.dataset.open) { e.preventDefault(); openTask(el.dataset.open); return; }
  if (el.dataset.who) { ui.who = el.dataset.who; render(); return; }
  if (el.dataset.copy) { copyText(el.dataset.copy, "Copiado " + el.dataset.copy); return; }
  if (el.dataset.copysteps) { copyText(stepsText(el.dataset.copysteps), "Paso a paso copiado"); return; }
  const a = el.dataset.act;
  if (a === "close") closeDrawer();
  else if (a === "dayprev" || a === "daynext") {
    const i = CAL.days.findIndex(d => d >= ui.day);
    const cur = CAL.days[i] === ui.day ? i : (a === "dayprev" ? i : i - 1);
    const ni = Math.max(0, cur + (a === "daynext" ? 1 : -1));
    ui.day = CAL.days[ni]; render();
  }
  else if (a === "daytoday") { ui.day = workdayOnOrAfter(TODAY < state.start ? state.start : TODAY); render(); }
  else if (a === "export") exportJSON();
  else if (a === "copyweek") copyText(weekSummary(), "Resumen copiado");
  else if (a === "signoutall") window.ImperiumAuth.signOutEverywhere();
  else if (a === "reset") { ui.confirmReset = true; render(); }
  else if (a === "resetno") { ui.confirmReset = false; render(); }
  else if (a === "resetyes") { const keep = { names: state.names, roles: state.roles, start: state.start, hpd: state.hpd, holidays: state.holidays }; state = Object.assign(defaults(), keep); ui.confirmReset = false; save(); refresh(); toast("Progreso borrado"); }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.step) { const [id, i] = el.dataset.step.split("|"); toggleStep(id, Number(i), el.checked); return; }
  if (el.id === "phaseSel") { ui.phase = el.value; render(); return; }
  if (el.id === "importFile" && el.files && el.files[0]) { importJSON(el.files[0]); el.value = ""; return; }
  if (el.dataset.set) {
    const k = el.dataset.set;
    if (k === "names.MJ" || k === "names.JQ") state.names[k.split(".")[1]] = el.value.slice(0, 40);
    else if (k === "start") { if (/^\d{4}-\d{2}-\d{2}$/.test(el.value)) { state.start = el.value; ui.day = null; } }
    else if (k === "hpd") state.hpd = Number(el.value);
    else if (k === "holidays") state.holidays = el.value.split(/\s+/).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
    else if (k === "replan") state.replan = el.checked;
    save(); computeSchedule(); renderSummary();
    document.getElementById("subtitle").textContent = name("MJ") + " y " + name("JQ") + " · " + state.hpd + " h al día cada una · desde " + fmt(state.start);
    toast("Ajuste guardado");
  }
});
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.notes) { ts(el.dataset.notes).notes = el.value; saveSoon(); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && ui.drawer) closeDrawer(); });
let dragId = null;
document.addEventListener("dragstart", e => { const c = e.target.closest("[data-drag]"); if (!c) return; dragId = c.dataset.drag; try { e.dataTransfer.setData("text/plain", dragId); e.dataTransfer.effectAllowed = "move"; } catch (x) {} });
document.addEventListener("dragover", e => { const col = e.target.closest("[data-drop]"); if (!col || !dragId) return; e.preventDefault(); document.querySelectorAll(".kcol.over").forEach(x => x !== col && x.classList.remove("over")); col.classList.add("over"); });
document.addEventListener("dragleave", e => { const col = e.target.closest("[data-drop]"); if (col && !col.contains(e.relatedTarget)) col.classList.remove("over"); });
document.addEventListener("drop", e => { const col = e.target.closest("[data-drop]"); if (!col || !dragId) return; e.preventDefault(); const id = dragId; dragId = null; if (stOf(id) !== col.dataset.drop) setStatus(id, col.dataset.drop); else render(); });
document.addEventListener("dragend", () => { dragId = null; document.querySelectorAll(".kcol.over").forEach(x => x.classList.remove("over")); });

/* ---------- export / import ---------- */
function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "imperium-lab-progreso-" + TODAY + ".json";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast("Archivo exportado");
}
function importJSON(file) {
  if (file.size > 1024 * 1024) { toast("Ese archivo es demasiado grande para ser un progreso"); return; }
  const r = new FileReader();
  r.onload = () => {
    try { const s = JSON.parse(r.result); if (!s || s.v !== 1) throw new Error("v"); state = merge(null, s); save(); ui.day = null; refresh(); toast("Progreso importado"); }
    catch (e) { toast("Ese archivo no es un progreso de este plan"); }
  };
  r.readAsText(file);
}
function weekSummary() {
  let mon = TODAY; while (dow(mon) !== 1) mon = isoAdd(mon, -1);
  const dates = [0, 1, 2, 3, 4].map(i => isoAdd(mon, i));
  const lines = ["Imperium Lab · semana del " + fmt(dates[0]) + " · avance " + pctFor(TASKS) + "%"];
  for (const p of PEOPLE) {
    lines.push("", name(p) + ":");
    const seen = new Set();
    for (const d of dates) { const di = CAL.idx[d]; if (di === undefined) continue;
      for (const t of personTasks(p)) if (!seen.has(t.id) && sOf(t.id).slices.some(s => s.d === di && s.p === p)) { seen.add(t.id); lines.push("- " + t.id + " " + t.t + " · " + STATUS[stOf(t.id)]); } }
    if (!seen.size) lines.push("- Sin tareas asignadas");
  }
  const late = TASKS.filter(t => isLate(t.id));
  if (late.length) lines.push("", "Atrasadas: " + late.map(t => t.id).join(", "));
  return lines.join("\n");
}

/* ---------- theme ---------- */
function applyTheme(t) { if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
let theme = null; try { theme = localStorage.getItem(THEME_KEY); } catch (e) {}
applyTheme(theme);
document.getElementById("themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark"; applyTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
});

/* ---------- boot ---------- */
window.ImperiumAuth.onReady(async ({ client, user }) => {
  sb = client; me = user.id;
  setSaved("Cargando…");
  try { await loadRemote(); }
  catch (e) {
    // Sin datos del servidor no se muestra el plan: editar sobre valores por defecto pisaría el progreso real.
    sb = null;
    setSaved("No se pudo cargar", true);
    document.getElementById("view").innerHTML = '<p class="note warn">No se pudo cargar el plan desde la base de datos. Revisa tu conexión y recarga la página.</p>';
    return;
  }
  setSaved(state.savedAt ? "Guardado " + hhmm(state.savedAt) : "Conectado");
  refresh();
  subscribe();
});
})();

