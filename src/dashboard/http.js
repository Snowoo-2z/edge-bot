// Utilitaires HTTP du tableau de bord (sans framework) : lecture du corps, réponses, en-têtes de sécurité.

const MAX_JSON_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // limite Discord pour une pièce jointe

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Page HTML/JS/CSS : CSP stricte (aucun script inline, aucune ressource externe sauf images https).
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function sendHeaders(res, status, type, extra = {}) {
  res.writeHead(status, { ...PAGE_HEADERS, 'Content-Type': type, ...extra });
}

function sendJson(res, status, body, extraHeaders = {}) {
  sendHeaders(res, status, 'application/json; charset=utf-8', extraHeaders);
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, extraHeaders = {}) {
  sendJson(res, status, { error: message }, extraHeaders);
}

function sendBuffer(res, status, buffer, type) {
  sendHeaders(res, status, type);
  res.end(buffer);
}

// Lit le corps brut, en refusant les corps trop gros (sans tout charger en mémoire).
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      reject(new HttpError(413, 'Fichier ou requête trop volumineux.'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Fichier ou requête trop volumineux.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buffer = await readBody(req, MAX_JSON_BYTES);
  if (!buffer.length) return {};
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('objet attendu');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Corps de requête invalide (JSON attendu).');
  }
}

// Détecte le type d'image à partir de sa signature (on ne fait pas confiance au Content-Type).
function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) {
    return { ext: '.gif', mime: 'image/gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

async function readImage(req) {
  const buffer = await readBody(req, MAX_UPLOAD_BYTES);
  const kind = sniffImage(buffer);
  if (!kind) throw new HttpError(415, 'Format non supporté. Formats acceptés : PNG, JPG, WEBP, GIF.');
  return { buffer, ...kind };
}

module.exports = {
  HttpError,
  PAGE_HEADERS,
  sendHeaders,
  sendJson,
  sendError,
  sendBuffer,
  readJson,
  readImage,
  sniffImage,
};
