// Tableau de bord web (réservé au propriétaire du bot).
//  - Activé seulement si DASHBOARD_PASSWORD est défini (12 caractères minimum). Sinon : 503 sur /dashboard, 404 sur /api.
//  - Accès : https://<service>/dashboard  (mot de passe, puis session de 12 h).
//  - Même serveur HTTP que le health check ; les réglages sont ceux de /config (Supabase).
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const { createApi } = require('./api');
const { sendHeaders } = require('./http');

const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES = {
  '/dashboard': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/dashboard/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/dashboard/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function loadFiles() {
  const loaded = {};
  for (const [urlPath, { file, type }] of Object.entries(FILES)) {
    loaded[urlPath] = { buffer: fs.readFileSync(path.join(PUBLIC_DIR, file)), type };
  }
  return loaded;
}

// getClient() : client Discord courant (peut être null tant que le bot n'est pas connecté).
function createDashboard({ getClient }) {
  const status = auth.configure();
  if (status.enabled) {
    console.log('[dashboard] activé : /dashboard (connexion par mot de passe).');
  } else {
    console.warn(`[dashboard] désactivé : ${status.reason}`);
  }

  const files = loadFiles();
  const api = createApi({ getClient });

  return {
    // Retourne true si la requête a été traitée ici, false sinon (le serveur répond alors 404).
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const isDashboardPath = pathname === '/dashboard' || pathname.startsWith('/dashboard/');

      if (!status.enabled) {
        if (!isDashboardPath) return false;
        sendHeaders(res, 503, 'text/plain; charset=utf-8');
        res.end(`Tableau de bord désactivé : ${status.reason}`);
        return true;
      }

      if (isDashboardPath) {
        const file = files[pathname];
        if (req.method !== 'GET' || !file) {
          sendHeaders(res, 404, 'text/plain; charset=utf-8');
          res.end('Not found');
          return true;
        }
        sendHeaders(res, 200, file.type);
        res.end(file.buffer);
        return true;
      }

      if (pathname.startsWith('/api/')) return api.dispatch(req, res, url);
      return false;
    },
  };
}

module.exports = { createDashboard };
