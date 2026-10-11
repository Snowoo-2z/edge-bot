// Authentification du tableau de bord : un seul mot de passe, défini dans la variable
// d'environnement DASHBOARD_PASSWORD (jamais dans le dépôt).
//  - Sans mot de passe (ou trop court), le tableau de bord est désactivé : toutes ses routes répondent 404.
//  - Le mot de passe est comparé en temps constant (empreintes SHA-256).
//  - Session : jeton aléatoire dans un cookie HttpOnly, Secure, SameSite=Strict. Les sessions vivent en mémoire
//    (elles disparaissent au redémarrage du service, il faut alors se reconnecter).
//  - Après 5 échecs depuis une même IP, cette IP est bloquée 15 minutes.
const crypto = require('node:crypto');

const COOKIE_NAME = 'edge_dash';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 h
const MIN_PASSWORD_LENGTH = 12;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

const sessions = new Map(); // jeton -> date d'expiration (ms)
const failures = new Map(); // IP -> { count, lockedUntil }

let expectedDigest = null;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// Lit DASHBOARD_PASSWORD. Retourne { enabled, reason }.
function configure() {
  const password = process.env.DASHBOARD_PASSWORD ?? '';
  if (!password) {
    expectedDigest = null;
    return { enabled: false, reason: 'DASHBOARD_PASSWORD n’est pas défini.' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    expectedDigest = null;
    return { enabled: false, reason: `DASHBOARD_PASSWORD est trop court (${MIN_PASSWORD_LENGTH} caractères minimum).` };
  }
  expectedDigest = sha256(password);
  return { enabled: true };
}

// Derrière le proxy de Render, la dernière valeur de X-Forwarded-For est l'IP réelle du client
// (le début de l'en-tête peut être fabriqué par le visiteur : on ne le lit donc pas).
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress ?? 'inconnue';
}

// Nettoyage périodique des compteurs d'échecs et des sessions expirées.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failures) if (entry.lockedUntil < now && entry.count === 0) failures.delete(ip);
  for (const [token, expires] of sessions) if (expires < now) sessions.delete(token);
}, 10 * 60 * 1000).unref();

function readCookie(req, name) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// Retourne { ok: true } ou { ok: false, status, retryAfter }.
function login(req, password) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = failures.get(ip) ?? { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) {
    return { ok: false, status: 429, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }

  const given = sha256(typeof password === 'string' ? password : '');
  const valid = expectedDigest !== null && crypto.timingSafeEqual(given, expectedDigest);
  if (!valid) {
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.lockedUntil = now + LOCK_MS;
      entry.count = 0;
      console.warn(`[dashboard] connexions refusées depuis ${ip} : IP bloquée 15 min.`);
    }
    failures.set(ip, entry);
    return { ok: false, status: 401 };
  }

  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, now + SESSION_MS);
  console.log(`[dashboard] connexion réussie depuis ${ip}.`);
  return { ok: true, token };
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function isAuthenticated(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function logout(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (token) sessions.delete(token);
}

module.exports = { configure, login, logout, sessionCookie, clearCookie, isAuthenticated, clientIp };
