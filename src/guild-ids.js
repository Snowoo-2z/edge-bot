// Serveurs où le bot enregistre ses commandes slash.
// - BUILTIN_GUILD_IDS : serveurs connus, écrits dans le code (toujours inclus).
// - GUILD_IDS (ou l'ancienne GUILD_ID) : serveurs supplémentaires, séparés par des virgules, espaces ou retours à la ligne.
// Les commandes sont enregistrées sur chacun de ces serveurs au démarrage et par `npm run deploy`.
const SNOWFLAKE = /^\d{17,20}$/;

const BUILTIN_GUILD_IDS = ['1546113304932655224'];

function parseGuildIds(env = process.env) {
  const raw = [env.GUILD_IDS, env.GUILD_ID].filter(Boolean).join(',');
  const extra = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = extra.filter((id) => !SNOWFLAKE.test(id));
  if (invalid.length) {
    throw new Error(`Identifiant de serveur invalide (17 à 20 chiffres attendus) : ${invalid.join(', ')}`);
  }
  return [...new Set([...BUILTIN_GUILD_IDS, ...extra])];
}

module.exports = { parseGuildIds, BUILTIN_GUILD_IDS };
