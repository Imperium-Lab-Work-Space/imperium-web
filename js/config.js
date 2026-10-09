// Conexión a Supabase. Copia los valores de Project Settings → API.
// La clave "publishable" es pública por diseño: la seguridad la dan RLS y el MFA.
// NUNCA pongas aquí la clave "secret" ni la "service_role".
window.IMPERIUM_CONFIG = Object.freeze({
  supabaseUrl: "https://zvlyvjgbqswfmlqhkgim.supabase.co",
  supabaseKey: "sb_publishable_fLLhgAVcdox2xthiUFcLew_D-TKtWqV",
  // Cierra la sesión tras este tiempo sin actividad.
  idleMinutes: 30
});
