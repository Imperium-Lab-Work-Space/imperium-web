/* Acceso: contraseña + verificación en dos pasos (TOTP) obligatoria, lista blanca de miembros,
   recuperación de contraseña y cierre de sesión por inactividad.
   Expone window.ImperiumAuth para que app.js arranque solo cuando hay una sesión válida. */
(function () {
"use strict";
const cfg = window.IMPERIUM_CONFIG || {};
const IDLE_KEY = "imperiumlab.lastActive";
const IDLE_MS = Math.max(5, Number(cfg.idleMinutes) || 30) * 60 * 1000;
const MIN_PASS = 12;

const $ = id => document.getElementById(id);
const authEl = $("auth"), appEl = $("app");
const screens = Array.from(authEl.querySelectorAll("[data-screen]"));
const readyCbs = [];
let sb = null, ctx = null, verifyFactorId = null, enrollFactorId = null, recovering = false, busy = false;

/* ---------- UI ---------- */
function show(name) {
  screens.forEach(s => { s.hidden = s.dataset.screen !== name; });
  const cur = screens.find(s => s.dataset.screen === name);
  const first = cur && cur.querySelector("input:not([type=hidden])");
  if (first) setTimeout(() => first.focus(), 0);
}
function msg(text, ok) {
  const el = $("authMsg");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("ok", !!ok);
}
function lock(form, on) {
  busy = on;
  const b = form && form.querySelector(".auth-submit");
  if (b) b.disabled = on;
}

/* ---------- configuración ---------- */
function checkConfig() {
  const url = String(cfg.supabaseUrl || ""), key = String(cfg.supabaseKey || "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key || key.indexOf("TU_") === 0) return "missing";
  if (/^sb_secret_/.test(key)) return "secret";
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
      if (payload.role === "service_role") return "secret";
    } catch (e) { return "missing"; }
  }
  return "ok";
}

/* ---------- flujo ---------- */
// Serializa route(): dos ejecuciones simultáneas podrían registrar dos factores TOTP.
let routing = null, rerun = false;
function go() {
  if (routing) { rerun = true; return routing; }
  routing = (async () => { do { rerun = false; await route(); } while (rerun); })().finally(() => { routing = null; });
  return routing;
}
async function route() {
  msg("");
  const { data: u, error: uErr } = await sb.auth.getUser(); // valida el token contra el servidor
  if (uErr || !u || !u.user) {
    await sb.auth.signOut({ scope: "local" }).catch(() => {});
    show("login"); return;
  }
  const { data: aal, error: aErr } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aErr) throw aErr;
  if (aal.currentLevel !== "aal2") {
    if (aal.nextLevel === "aal2") await startVerify(); else await startEnroll();
    return;
  }
  if (recovering) { show("newpass"); return; }
  const { data: m, error: mErr } = await sb.from("miembros").select("codigo").eq("user_id", u.user.id).maybeSingle();
  if (mErr || !m) { show("denied"); return; }
  enterApp(u.user, m.codigo);
}

async function startVerify() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  const f = (data.totp || []).find(x => x.status === "verified");
  if (!f) { await startEnroll(); return; }
  verifyFactorId = f.id;
  $("verifyCode").value = "";
  show("verify");
}

async function startEnroll() {
  const { data: list, error: lErr } = await sb.auth.mfa.listFactors();
  if (lErr) throw lErr;
  // Borra intentos de registro que quedaron a medias para no acumular factores sin verificar.
  for (const f of (list.all || [])) {
    if (f.factor_type === "totp" && f.status !== "verified") await sb.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await sb.auth.mfa.enroll({
    factorType: "totp", issuer: "Imperium Lab", friendlyName: "Imperium Lab " + new Date().toISOString().slice(0, 16)
  });
  if (error) throw error;
  enrollFactorId = data.id;
  const qr = String(data.totp.qr_code || "");
  $("enrollQr").src = qr.indexOf("data:image/svg+xml") === 0 ? qr : "";
  $("enrollSecret").textContent = data.totp.secret || "";
  $("enrollCode").value = "";
  show("enroll");
}

function enterApp(user, codigo) {
  ctx = { client: sb, user: { id: user.id }, codigo };
  touch();
  authEl.hidden = true;
  appEl.hidden = false;
  $("whoChip").textContent = "Sesión: " + codigo;
  readyCbs.splice(0).forEach(cb => cb(ctx));
}

async function signOut(scope) {
  try { await sb.auth.signOut({ scope: scope === "global" ? "global" : "local" }); } catch (e) {}
  try { localStorage.removeItem(IDLE_KEY); } catch (e) {}
  // Recarga para borrar de memoria todo el estado del plan.
  location.replace(location.pathname);
}

/* ---------- formularios ---------- */
let fails = 0, blockedUntil = 0;
async function onLogin(form) {
  const email = $("loginEmail").value.trim(), pass = $("loginPass").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !pass) { msg("Escribe tu correo y tu contraseña."); return; }
  const wait = Math.ceil((blockedUntil - Date.now()) / 1000);
  if (wait > 0) { msg("Demasiados intentos. Espera " + wait + " s."); return; }
  lock(form, true);
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  $("loginPass").value = "";
  lock(form, false);
  if (error) {
    fails++;
    if (fails >= 3) blockedUntil = Date.now() + Math.min(300, 5 * Math.pow(2, fails - 3)) * 1000;
    // Mensaje único: no revela si el correo existe.
    msg(error.status === 429 ? "Demasiados intentos. Espera unos minutos." : "Correo o contraseña incorrectos.");
    return;
  }
  fails = 0;
  await go();
}

async function onTotp(form, factorId, inputId) {
  const code = $(inputId).value.replace(/\D/g, "");
  if (code.length !== 6) { msg("El código tiene 6 dígitos."); return; }
  if (!factorId) { await go(); return; }
  lock(form, true);
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
  $(inputId).value = "";
  lock(form, false);
  if (error) { msg(error.status === 429 ? "Demasiados intentos. Espera unos minutos." : "Código incorrecto o vencido. Usa el código actual de la app."); return; }
  await go();
}

async function onForgot(form) {
  const email = $("forgotEmail").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg("Escribe un correo válido."); return; }
  lock(form, true);
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  lock(form, false);
  if (error && error.status === 429) { msg("Demasiadas solicitudes. Espera unos minutos."); return; }
  // Siempre el mismo mensaje, exista o no la cuenta.
  show("login");
  msg("Si ese correo tiene cuenta, te llegará un enlace en unos minutos. Ábrelo en este navegador.", true);
}

function passScore(p) {
  if (p.length < MIN_PASS) return 0;
  let s = 1;
  if (p.length >= 16) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  if (/(.)\1{3,}/.test(p) || /^(?:123|abc|qwerty|password|contrase)/i.test(p)) s = 1;
  return Math.min(s, 3);
}
function onPassInput() {
  const p = $("newPass").value, s = passScore(p);
  const bar = $("passMeter");
  bar.style.width = (p ? [15, 45, 75, 100][s] : 0) + "%";
  bar.className = s >= 3 ? "good" : s === 2 ? "mid" : "";
  $("passHint").textContent = !p ? "" : p.length < MIN_PASS ? "Faltan " + (MIN_PASS - p.length) + " caracteres." : ["", "Aceptable. Más larga es mejor.", "Buena.", "Muy buena."][s];
}

async function onNewPass(form) {
  const p = $("newPass").value, p2 = $("newPass2").value;
  if (p.length < MIN_PASS) { msg("La contraseña debe tener al menos " + MIN_PASS + " caracteres."); return; }
  if (passScore(p) < 2) { msg("Esa contraseña es fácil de adivinar. Usa una frase más larga o mezcla mayúsculas, números y símbolos."); return; }
  if (p !== p2) { msg("Las dos contraseñas no coinciden."); return; }
  lock(form, true);
  const { error } = await sb.auth.updateUser({ password: p });
  lock(form, false);
  $("newPass").value = ""; $("newPass2").value = ""; onPassInput();
  if (error) {
    const c = error.code || "";
    msg(c === "same_password" ? "Usa una contraseña distinta a la anterior."
      : c === "weak_password" ? "Supabase rechazó la contraseña por débil o filtrada en internet. Elige otra."
      : c === "reauthentication_needed" ? "Por seguridad, cierra sesión y vuelve a pedir el enlace."
      : "No se pudo cambiar la contraseña. Pide un enlace nuevo.");
    return;
  }
  recovering = false;
  await go();
  msg("Contraseña actualizada.", true);
}

/* ---------- inactividad ---------- */
function touch() { try { localStorage.setItem(IDLE_KEY, String(Date.now())); } catch (e) {} }
function lastActive() { try { return Number(localStorage.getItem(IDLE_KEY)) || 0; } catch (e) { return 0; } }
let lastTouch = 0;
function onActivity() { if (!ctx) return; const n = Date.now(); if (n - lastTouch > 15000) { lastTouch = n; touch(); } }
function checkIdle() { if (ctx && Date.now() - lastActive() > IDLE_MS) signOut("local"); }
["pointerdown", "keydown", "scroll", "touchstart"].forEach(ev => document.addEventListener(ev, onActivity, { passive: true, capture: true }));
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkIdle(); });
setInterval(checkIdle, 30000);

/* ---------- eventos ---------- */
function guard(fn) {
  return async e => {
    if (e) e.preventDefault();
    const f = e ? e.currentTarget : null; // currentTarget se pierde después del primer await
    if (busy) return;
    try { await fn(f); }
    catch (err) { lock(f, false); msg("No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo."); }
  };
}
const form = n => authEl.querySelector('[data-screen="' + n + '"]');
form("login").addEventListener("submit", guard(onLogin));
form("verify").addEventListener("submit", guard(f => onTotp(f, verifyFactorId, "verifyCode")));
form("enroll").addEventListener("submit", guard(f => onTotp(f, enrollFactorId, "enrollCode")));
form("forgot").addEventListener("submit", guard(onForgot));
form("newpass").addEventListener("submit", guard(onNewPass));
$("newPass").addEventListener("input", onPassInput);
authEl.addEventListener("input", e => {
  const el = e.target;
  if (!el.classList.contains("otp")) return;
  el.value = el.value.replace(/\D/g, "").slice(0, 6);
  if (el.value.length === 6) el.form.requestSubmit();
});
authEl.addEventListener("click", e => {
  const go = e.target.closest("[data-go]");
  if (go) { msg(""); if (go.dataset.go === "forgot") $("forgotEmail").value = $("loginEmail").value; show(go.dataset.go); return; }
  const rv = e.target.closest("[data-reveal]");
  if (rv) {
    const inp = $(rv.dataset.reveal), on = inp.type === "password";
    inp.type = on ? "text" : "password";
    rv.textContent = on ? "Ocultar" : "Ver";
    rv.setAttribute("aria-pressed", String(on));
    return;
  }
  const act = e.target.closest("[data-auth-act]");
  if (act && act.dataset.authAct === "signout") signOut("local");
});
$("signOutBtn").addEventListener("click", () => signOut("local"));

/* ---------- arranque ---------- */
window.ImperiumAuth = Object.freeze({
  onReady(cb) { if (ctx) cb(ctx); else readyCbs.push(cb); },
  signOut,
  signOutEverywhere: () => signOut("global")
});

const conf = checkConfig();
if (conf !== "ok" || !window.supabase) {
  show("config");
  if (conf === "secret") msg("La clave de js/config.js es secreta (service_role o secret). Bórrala de inmediato, rótala en Supabase y usa la clave publishable.");
  return;
}
sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
sb.auth.onAuthStateChange(event => {
  // Fuera del callback: llamar a Supabase dentro de él puede bloquear el cliente.
  if (event === "PASSWORD_RECOVERY") { recovering = true; setTimeout(() => guard(go)(), 0); }
  else if (event === "SIGNED_OUT" && ctx) location.replace(location.pathname);
});
(async () => {
  if (lastActive() && Date.now() - lastActive() > IDLE_MS) await sb.auth.signOut({ scope: "local" }).catch(() => {});
  await guard(go)();
  // Quita códigos o tokens de la URL después de procesarlos.
  if (location.search || location.hash) history.replaceState(null, "", location.pathname);
})();
})();
