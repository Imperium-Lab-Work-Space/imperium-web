-- Vincula las cuentas de Supabase Auth con cada socia (lista blanca).
-- 1. Crea las dos cuentas en Authentication → Users → Add user → Create new user
--    (marca "Auto Confirm User"). No uses correos compartidos.
-- 2. Reemplaza los dos correos de abajo y ejecuta este archivo en SQL Editor.
-- Una cuenta que no esté aquí puede iniciar sesión, pero no ve ni modifica nada.

insert into public.miembros (user_id, codigo)
select u.id, v.codigo
from (values
  ('CORREO_DE_MJ@ejemplo.com', 'MJ'),
  ('CORREO_DE_JQ@ejemplo.com', 'JQ')
) as v(email, codigo)
join auth.users u on lower(u.email) = lower(v.email)
on conflict (user_id) do update set codigo = excluded.codigo;

-- Comprobación: deben salir 2 filas.
select m.codigo, u.email, u.last_sign_in_at
from public.miembros m join auth.users u on u.id = m.user_id
order by m.codigo;

-- Para quitar el acceso a alguien de inmediato:
--   delete from public.miembros where codigo = 'XX';
-- y en Authentication → Users, "Sign out user" o eliminar la cuenta.
