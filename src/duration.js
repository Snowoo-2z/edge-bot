// Durées lisibles : « 10m », « 2h », « 1j 12h », « 30 minutes », « 1j et 2h ».
// Retourne des millisecondes, ou null si la saisie est invalide. Sans limite de taille :
// chaque appelant applique ses propres bornes.
const UNIT_RE = /(\d+)\s*(jours?|j|days?|d|heures?|hours?|h|minutes?|mins?|min|m)/g;

function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  let total = 0;
  let match;
  UNIT_RE.lastIndex = 0;
  while ((match = UNIT_RE.exec(text)) !== null) {
    const n = Number(match[1]);
    const unit = match[2];
    let unitMs;
    if (/^(j|jours?|d|days?)$/.test(unit)) unitMs = 24 * 60 * 60 * 1000;
    else if (/^(h|heures?|hours?)$/.test(unit)) unitMs = 60 * 60 * 1000;
    else unitMs = 60 * 1000;
    total += n * unitMs;
  }
  // Rien d'autre que des nombres, des unités, des espaces, des virgules et « et » ne doit rester.
  const rest = text.replace(/(\d+)\s*(jours?|j|days?|d|heures?|hours?|h|minutes?|mins?|min|m)/g, '').replace(/[\s,]|et/g, '');
  if (rest.length > 0 || total === 0) return null;
  return total;
}

// Formate des millisecondes en texte court : « 2 h 30 min », « 1 j 4 h ».
function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} j`);
  if (hours) parts.push(`${hours} h`);
  if (minutes || parts.length === 0) parts.push(`${minutes} min`);
  return parts.join(' ');
}

module.exports = { parseDuration, formatDuration };
