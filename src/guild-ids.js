// Lecture de la liste des serveurs où enregistrer les commandes.
// GUILD_IDS : un ou plusieurs identifiants séparés par des virgules, espaces ou retours à la ligne.
// GUILD_ID (ancienne variable, un seul serveur) reste accepté. Si aucun n'est défini : enregistrement global.
const SNOWFLAKE = /^\d{17,20}$/;

function parseGuildIds(env = process.env) {
  const raw = [env.GUILD_IDS, env.GUILD_ID].filter(Boolean).join(',');
  const ids = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = ids.filter((id) => !SNOWFLAKE.test(id));
  if (invalid.length) {
    throw new Error(`Identifiant de serveur invalide (17 à 20 chiffres attendus) : ${invalid.join(', ')}`);
  }
  return [...new Set(ids)];
}

module.exports = { parseGuildIds };
