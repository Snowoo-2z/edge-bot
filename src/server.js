const http = require('node:http');

// Petit serveur HTTP requis par Render (web service) : il doit écouter sur $PORT.
// /health sert au health check de Render et à l'auto-ping (keepalive.js).
function startServer(getStatus) {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), ...getStatus() }));
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
