// Compression des données volumineuses avant stockage dans Supabase (sauvegardes).
// JSON -> gzip (niveau 9) -> base64 : une chaîne texte, lisible par PostgREST sans conversion.
// Les lignes anciennes (jsonb non compressé) restent lisibles : voir store / backup.js.
const zlib = require('node:zlib');

function packJson(value) {
  const json = JSON.stringify(value);
  return zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64');
}

function unpackJson(packed) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'));
}

module.exports = { packJson, unpackJson };
