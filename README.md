# imperium-web
Repositorio principal para el sitio web y la plataforma de Imperium Lab.

## Estructura

| Ruta | Contenido |
|---|---|
| `index.html` | Estructura de la página y pantallas de acceso |
| `css/styles.css` · `css/auth.css` | Estilos de la app y del login |
| `js/config.js` | URL y clave publishable de Supabase |
| `js/auth.js` | Login, verificación en dos pasos, recuperación, cierre por inactividad |
| `js/data.js` · `js/scheduler.js` · `js/app.js` | Contenido del plan, cálculo del cronograma e interfaz |
| `js/vendor/` | `@supabase/supabase-js` 2.117.2 servido localmente (sin CDN) con hash SRI |
| `supabase/` | SQL: esquema y seguridad, datos iniciales, lista de miembros |
| `scripts/generar-seed.js` | Regenera `supabase/02_seed.sql` desde `js/data.js` |
| `vercel.json` | Cabeceras de seguridad HTTP |

## Puesta en marcha

### 1. Supabase: base de datos
En **SQL Editor**, ejecutar en orden:
1. `supabase/01_schema.sql`: tablas, permisos, RLS, auditoría. Se puede volver a ejecutar.
2. `supabase/02_seed.sql`: tareas, fases y fuentes.

### 2. Supabase: autenticación
- **Authentication → Sign In / Providers**: desactivar *Allow new users to sign up*. Dejar solo Email.
- **Authentication → Multi-Factor**: TOTP activado.
- **Authentication → Users → Add user**: crear las dos cuentas (con *Auto Confirm*).
- Ejecutar `supabase/03_miembros.sql` con los dos correos reales.
- **Authentication → URL Configuration**: *Site URL* y *Redirect URLs* = la URL publicada (y `http://localhost:3000` para pruebas).
- **Contraseñas**: mínimo 12 caracteres y activar la protección contra contraseñas filtradas si el plan lo incluye.
- **Rate limits**: revisar los límites de inicio de sesión, verificación y correos.
- **Sesiones**: si el plan lo permite, fijar un tiempo máximo de sesión e inactividad.

Los nombres de los menús pueden cambiar; ver https://supabase.com/docs/guides/auth.

### 3. Configurar la página
En `js/config.js`, pegar la *Project URL* y la clave **publishable** (o *anon*) de **Project Settings → API**.
Nunca la clave *secret* / *service_role*: la página se niega a arrancar si la detecta.

### 4. Publicar
Vercel (recomendado): importar el repo desde GitHub. `vercel.json` aplica CSP, HSTS, anti-clickjacking y demás cabeceras.
GitHub Pages no permite cabeceras propias; la CSP va igual en `index.html`, pero sin protección contra iframes ni HSTS propio.

### Probar en local
La página necesita servirse por HTTP (no abrir el archivo con doble clic):
```
npx serve -l 3000 .
```

## Modelo de seguridad
1. **Lista blanca**: registro público desactivado; solo las cuentas en `public.miembros` acceden a datos.
2. **Segundo factor obligatorio**: cada tabla tiene una política `restrictive` que exige `aal2` (patrón oficial de Supabase), y las funciones de seguridad viven en el esquema `private`, que la API no expone. Sin el código TOTP, la API no devuelve nada, aunque se use la clave publishable directamente.
3. **Mínimo privilegio**: el rol anónimo no tiene permisos; el catálogo es de solo lectura; en `personas` y `plan_config` solo se pueden editar columnas concretas.
4. **Validación en el servidor**: límites de tamaño y formato con `check` constraints; `updated_by` lo pone un trigger.
5. **Auditoría**: cada cambio queda en `public.auditoria` (quién, cuándo, antes y después), que nadie puede editar ni borrar desde la API.
6. **Navegador**: CSP sin scripts externos ni inline, librería servida localmente con SRI, contenido escapado contra XSS, `no-referrer`, flujo PKCE, tokens borrados de la URL, cierre por inactividad (30 min) y botón para cerrar sesión en todos los dispositivos.
7. **Mensajes neutros**: el login y la recuperación no revelan si un correo existe.

Ver el registro de cambios:
```sql
select creado_en, tabla, registro, accion, usuario from public.auditoria order by creado_en desc limit 50;
```
