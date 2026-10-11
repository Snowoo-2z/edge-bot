const http = require('node:http');

// Petit serveur HTTP requis par Render (web service) : il doit écouter sur $PORT.
// getStatus() renvoie { ready, bot } : ready = true seulement quand le bot est connecté à Discord.
//  - /health (health check Render) répond 200 si ready, sinon 503. Ainsi Render ne remplace pas
//    l'instance qui fonctionne par une nouvelle qui attend encore la connexion à Discord.
//  - / et l'auto-ping (keepalive.js) gardent le service éveillé ; /health est aussi utilisé par keepalive.
function startServer(getStatus) {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const { ready, bot } = getStatus();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'starting', bot, uptime: Math.round(process.uptime()) }));
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      const { bot } = getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', bot, uptime: Math.round(process.uptime()) }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Serveur HTTP à l'écoute sur le port ${port}`);
  });
  return server;
}

module.exports = { startServer };
