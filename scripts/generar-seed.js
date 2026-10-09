// Genera supabase/02_seed.sql a partir de public/js/data.js.
// Uso: node scripts/generar-seed.js   (volver a correrlo cuando cambien las tareas)
const fs = require("fs");
const path = require("path");
const { L, PHASES, TASKS } = require("../public/js/data.js");

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const arr = a => "array[" + a.map(q).join(", ") + "]::text[]";

const out = [];
out.push("-- Generado por scripts/generar-seed.js desde public/js/data.js. No editar a mano.");
out.push("begin;", "");

out.push("insert into public.fuentes (clave, titulo, url) values");
out.push(Object.entries(L).map(([k, [t, u]]) => `  (${q(k)}, ${q(t)}, ${q(u)})`).join(",\n"));
out.push("on conflict (clave) do update set titulo = excluded.titulo, url = excluded.url;", "");

out.push("insert into public.fases (id, numero, nombre, criterio_salida, orden) values");
out.push(PHASES.map((p, i) => `  (${q(p.id)}, ${q(p.n)}, ${q(p.name)}, ${q(p.gate)}, ${i})`).join(",\n"));
out.push("on conflict (id) do update set numero = excluded.numero, nombre = excluded.nombre, criterio_salida = excluded.criterio_salida, orden = excluded.orden;", "");

// orden único: se libera antes de reasignar para no chocar en re-ejecuciones
out.push("update public.tareas set orden = orden + 10000;");
out.push("insert into public.tareas (id, fase_id, responsable, horas, es_hito, titulo, porque, pasos, entregable, criterio_hecho, orden) values");
out.push(TASKS.map((t, i) =>
  `  (${q(t.id)}, ${q(t.f)}, ${q(t.o)}, ${t.h}, ${!!t.gate}, ${q(t.t)}, ${q(t.why)}, ${arr(t.steps)}, ${q(t.out)}, ${q(t.done)}, ${i})`
).join(",\n"));
out.push("on conflict (id) do update set fase_id = excluded.fase_id, responsable = excluded.responsable, horas = excluded.horas, es_hito = excluded.es_hito, titulo = excluded.titulo, porque = excluded.porque, pasos = excluded.pasos, entregable = excluded.entregable, criterio_hecho = excluded.criterio_hecho, orden = excluded.orden;", "");

out.push("delete from public.tarea_dependencias;");
const deps = TASKS.flatMap(t => (t.deps || []).map(d => `  (${q(t.id)}, ${q(d)})`));
if (deps.length) out.push("insert into public.tarea_dependencias (tarea_id, depende_de) values", deps.join(",\n") + ";", "");

out.push("delete from public.tarea_fuentes;");
const res = TASKS.flatMap(t => t.res.map((r, i) => `  (${q(t.id)}, ${q(r)}, ${i})`));
if (res.length) out.push("insert into public.tarea_fuentes (tarea_id, fuente_clave, orden) values", res.join(",\n") + ";", "");

// Estado inicial: mismos valores que defaults() en js/app.js
out.push("insert into public.personas (codigo, nombre, rol) values");
out.push("  ('MJ', 'MJ', 'Datos, legal y plataforma'),\n  ('JQ', 'JQ', 'Marca, producto y clientes')");
out.push("on conflict (codigo) do nothing;", "");

const holidays = ["2026-10-12","2026-11-02","2026-11-16","2026-12-08","2026-12-25","2027-01-01","2027-01-11"];
out.push("insert into public.plan_config (id, fecha_inicio, horas_por_dia, festivos, replanificar) values");
out.push(`  (1, '2026-10-09', 2, array[${holidays.map(q).join(", ")}]::date[], false)`);
out.push("on conflict (id) do nothing;", "");

out.push("commit;", "");
const dest = path.join(__dirname, "..", "supabase", "02_seed.sql");
fs.writeFileSync(dest, out.join("\n"));
console.log("Escrito", dest, "·", TASKS.length, "tareas,", deps.length, "dependencias,", res.length, "fuentes por tarea");
