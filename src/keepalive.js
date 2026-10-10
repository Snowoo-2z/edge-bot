// Auto-ping : Render met en veille un web service gratuit après ~15 min sans requête entrante.
// Le bot s'envoie donc une requête sur sa propre URL publique toutes les 10 minutes.
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

function startKeepAlive() {
  // RENDER_EXTERNAL_URL est fournie automatiquement par Render (ex. https://edge-bot.onrender.com).
  const base = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) {
    console.log('[keepalive] désactivé : RENDER_EXTERNAL_URL absent (normal en local).');
    return null;
  }

  const interval = Number(process.env.KEEPALIVE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const url = `${base.replace(/\/$/, '')}/health`;

  const every = interval >= 60_000 ? `${Math.round(interval / 60_000)} min` : `${Math.round(interval / 1000)} s`;
  console.log(`[keepalive] ping de ${url} toutes les ${every}`);

  return setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      console.log(`[keepalive] ${new Date().toISOString()} → ${res.status}`);
    } catch (err) {
      console.error('[keepalive] échec du ping :', err.message);
    }
  }, interval);
}

module.exports = { startKeepAlive };
