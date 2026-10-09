-- Imperium Lab · Plan de arranque
-- Esquema para Supabase (PostgreSQL). Ejecutar en SQL Editor antes de 02_seed.sql.
-- Se puede volver a ejecutar: tablas, funciones, permisos y políticas se recrean sin duplicarse.
-- Catálogo (fuentes, fases, tareas) = contenido fijo del plan (hoy en js/data.js).
-- Estado (config, personas, progreso) = lo que antes se guardaba en localStorage.
--
-- Modelo de seguridad:
--   1. Solo cuentas creadas a mano (registro público desactivado en el panel).
--   2. Solo cuentas presentes en public.miembros ven o tocan datos (lista blanca).
--   3. Solo sesiones con segundo factor verificado (aal2) pasan las políticas RLS.
--   4. El rol anónimo no tiene ningún permiso sobre las tablas.
--   5. Todo cambio de estado queda registrado en public.auditoria.

-- ---------- Catálogo ----------
create table if not exists public.fuentes (
  clave   text primary key,
  titulo  text not null,
  url     text not null check (url ~ '^https://')
);

create table if not exists public.fases (
  id               text primary key,          -- f0..f4
  numero           text not null,             -- "Fase 0"
  nombre           text not null,
  criterio_salida  text not null,
  orden            smallint not null unique
);

create table if not exists public.tareas (
  id              text primary key,           -- T01..
  fase_id         text not null references public.fases(id),
  responsable     text not null check (responsable in ('MJ','JQ','AMBAS')),
  horas           numeric(4,1) not null check (horas > 0),
  es_hito         boolean not null default false,
  titulo          text not null,
  porque          text not null,
  pasos           text[] not null default '{}',
  entregable      text not null,
  criterio_hecho  text not null,
  orden           smallint not null unique
);

create table if not exists public.tarea_dependencias (
  tarea_id    text not null references public.tareas(id) on delete cascade,
  depende_de  text not null references public.tareas(id) on delete cascade,
  primary key (tarea_id, depende_de),
  check (tarea_id <> depende_de)
);

create table if not exists public.tarea_fuentes (
  tarea_id     text not null references public.tareas(id) on delete cascade,
  fuente_clave text not null references public.fuentes(clave),
  orden        smallint not null,
  primary key (tarea_id, fuente_clave)
);

-- ---------- Estado compartido ----------
create table if not exists public.personas (
  codigo  text primary key check (codigo in ('MJ','JQ')),
  nombre  text not null check (char_length(btrim(nombre)) between 1 and 40),
  rol     text not null default '' check (char_length(rol) <= 80)
);

-- Lista blanca: qué cuenta de Supabase Auth corresponde a qué socia.
create table if not exists public.miembros (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  codigo    text not null unique references public.personas(codigo),
  creado_en timestamptz not null default now()
);

-- Una sola fila (id = 1): configuración del plan.
create table if not exists public.plan_config (
  id             smallint primary key default 1 check (id = 1),
  fecha_inicio   date not null default '2026-10-09',
  horas_por_dia  smallint not null default 2 check (horas_por_dia between 1 and 4),
  festivos       date[] not null default '{}' check (cardinality(festivos) <= 100),
  replanificar   boolean not null default false,
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);

create table if not exists public.tarea_progreso (
  tarea_id     text primary key references public.tareas(id) on delete cascade,
  estado       text not null default 'pend' check (estado in ('pend','doing','block','done')),
  pasos_hechos boolean[] not null default '{}' check (cardinality(pasos_hechos) <= 50),
  notas        text not null default '' check (char_length(notas) <= 10000),
  hecha_en     date,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

-- Bitácora de cambios: solo la escriben los triggers, nadie la puede editar.
create table if not exists public.auditoria (
  id        bigint generated always as identity primary key,
  tabla     text not null,
  registro  text not null,
  accion    text not null check (accion in ('INSERT','UPDATE','DELETE')),
  usuario   uuid,
  antes     jsonb,
  despues   jsonb,
  creado_en timestamptz not null default now()
);

create index if not exists tareas_fase_idx on public.tareas (fase_id);
create index if not exists tarea_dependencias_dep_idx on public.tarea_dependencias (depende_de);
create index if not exists auditoria_fecha_idx on public.auditoria (creado_en desc);

-- ---------- Funciones (esquema private: la API no lo expone) ----------
-- Guía de Supabase: las funciones security definer no deben vivir en esquemas expuestos.
-- Se borran primero las políticas y las versiones anteriores que estaban en public.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
drop function if exists public.es_miembro() cascade;
drop function if exists public.sellar_cambio() cascade;
drop function if exists public.registrar_auditoria() cascade;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ¿La sesión actual es de una socia y pasó el segundo factor?
create or replace function private.es_miembro()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from public.miembros m where m.user_id = auth.uid());
$$;
revoke all on function private.es_miembro() from public, anon;
grant execute on function private.es_miembro() to authenticated;

-- updated_at / updated_by los pone el servidor, nunca el navegador.
create or replace function private.sellar_cambio()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create or replace function private.registrar_auditoria()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  fila jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.auditoria (tabla, registro, accion, usuario, antes, despues)
  values (
    tg_table_name,
    coalesce(fila ->> 'tarea_id', fila ->> 'codigo', fila ->> 'id', '?'),
    tg_op,
    auth.uid(),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;
revoke all on function private.registrar_auditoria() from public, anon, authenticated;
revoke all on function private.sellar_cambio() from public, anon, authenticated;

drop trigger if exists plan_config_sellar on public.plan_config;
create trigger plan_config_sellar before insert or update on public.plan_config
  for each row execute function private.sellar_cambio();
drop trigger if exists tarea_progreso_sellar on public.tarea_progreso;
create trigger tarea_progreso_sellar before insert or update on public.tarea_progreso
  for each row execute function private.sellar_cambio();

drop trigger if exists plan_config_auditar on public.plan_config;
create trigger plan_config_auditar after insert or update or delete on public.plan_config
  for each row execute function private.registrar_auditoria();
drop trigger if exists tarea_progreso_auditar on public.tarea_progreso;
create trigger tarea_progreso_auditar after insert or update or delete on public.tarea_progreso
  for each row execute function private.registrar_auditoria();
drop trigger if exists personas_auditar on public.personas;
create trigger personas_auditar after insert or update or delete on public.personas
  for each row execute function private.registrar_auditoria();
drop trigger if exists miembros_auditar on public.miembros;
create trigger miembros_auditar after insert or update or delete on public.miembros
  for each row execute function private.registrar_auditoria();

-- ---------- Permisos (mínimo privilegio) ----------
-- Supabase da permisos amplios por defecto a anon y authenticated; se quitan todos
-- y se devuelve solo lo que la página usa. RLS filtra además fila por fila.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon;

grant select on public.fuentes, public.fases, public.tareas,
                public.tarea_dependencias, public.tarea_fuentes to authenticated;
grant select on public.miembros, public.auditoria to authenticated;
grant select, update (nombre) on public.personas to authenticated;
grant select, update (fecha_inicio, horas_por_dia, festivos, replanificar) on public.plan_config to authenticated;
grant select, insert, update, delete on public.tarea_progreso to authenticated;

-- ---------- RLS ----------
alter table public.fuentes            enable row level security;
alter table public.fases              enable row level security;
alter table public.tareas             enable row level security;
alter table public.tarea_dependencias enable row level security;
alter table public.tarea_fuentes      enable row level security;
alter table public.personas           enable row level security;
alter table public.miembros           enable row level security;
alter table public.plan_config        enable row level security;
alter table public.tarea_progreso     enable row level security;
alter table public.auditoria          enable row level security;

-- Barrera 1 (patrón oficial de Supabase para exigir MFA): política RESTRICTIVE en
-- todas las tablas. Se combina con AND con cualquier otra política, así que ninguna
-- política permisiva futura puede abrir datos a una sesión sin segundo factor.
do $$
declare t text;
begin
  foreach t in array array['fuentes','fases','tareas','tarea_dependencias','tarea_fuentes',
                           'personas','miembros','plan_config','tarea_progreso','auditoria'] loop
    execute format('create policy "exigir segundo factor" on public.%I as restrictive to authenticated using ((select auth.jwt() ->> ''aal'') = ''aal2'') with check ((select auth.jwt() ->> ''aal'') = ''aal2'')', t);
  end loop;
end $$;

-- Barrera 2: políticas permisivas por operación, solo para socias en la lista blanca.
create policy "miembros leen fuentes"      on public.fuentes            for select to authenticated using ((select private.es_miembro()));
create policy "miembros leen fases"        on public.fases              for select to authenticated using ((select private.es_miembro()));
create policy "miembros leen tareas"       on public.tareas             for select to authenticated using ((select private.es_miembro()));
create policy "miembros leen dependencias" on public.tarea_dependencias for select to authenticated using ((select private.es_miembro()));
create policy "miembros leen tarea_fuentes" on public.tarea_fuentes     for select to authenticated using ((select private.es_miembro()));

create policy "miembros leen personas"   on public.personas for select to authenticated using ((select private.es_miembro()));
create policy "miembros editan personas" on public.personas for update to authenticated
  using ((select private.es_miembro())) with check ((select private.es_miembro()));

-- Cada cuenta puede ver su propia fila (la página la usa para saber si tiene acceso).
create policy "cada cuenta ve su membresía" on public.miembros for select to authenticated
  using (user_id = (select auth.uid()));

create policy "miembros leen config"   on public.plan_config for select to authenticated using ((select private.es_miembro()));
create policy "miembros editan config" on public.plan_config for update to authenticated
  using ((select private.es_miembro())) with check ((select private.es_miembro()));

create policy "miembros leen progreso"   on public.tarea_progreso for select to authenticated using ((select private.es_miembro()));
create policy "miembros crean progreso"  on public.tarea_progreso for insert to authenticated with check ((select private.es_miembro()));
create policy "miembros editan progreso" on public.tarea_progreso for update to authenticated
  using ((select private.es_miembro())) with check ((select private.es_miembro()));
create policy "miembros borran progreso" on public.tarea_progreso for delete to authenticated using ((select private.es_miembro()));

create policy "miembros leen auditoria" on public.auditoria for select to authenticated using ((select private.es_miembro()));

-- ---------- Tiempo real ----------
-- Para que ambas vean los cambios al instante. Realtime respeta las políticas RLS.
do $$
declare t text;
begin
  foreach t in array array['tarea_progreso','plan_config','personas'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
