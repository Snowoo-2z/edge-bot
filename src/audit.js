// Journal d'audit Discord : retrouver qui a fait une action sur une cible (salon, rôle, membre…).
// Utilisé par le module Logs et par la sécurité (anti-nuke). Retourne null si la permission
// « Voir le journal d'audit » manque ou si aucune entrée récente ne correspond.
const DEFAULT_WINDOW_MS = 20_000;

async function auditFor(guild, type, targetId, windowMs = DEFAULT_WINDOW_MS) {
  try {
    const audit = await guild.fetchAuditLogs({ type, limit: 6 });
    return (
      audit.entries.find((e) => (e.targetId ?? e.target?.id) === targetId && Date.now() - e.createdTimestamp < windowMs) ?? null
    );
  } catch {
    return null;
  }
}

module.exports = { auditFor };
