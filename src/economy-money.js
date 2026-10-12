// Montants de l'économie (Edge Dollar, $) : affichage et saisie. Sans dépendance, partagé par les modules économiques.
const NBSP = '\u00a0';

// 1250 -> « 1 250 » (espace insécable, lisible en français).
function formatNumber(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

// 1250 -> « 1 250 $ » (symbole après le montant, à la française).
function formatMoney(n, cfg = { symbol: '$' }) {
  return `${formatNumber(n)}${NBSP}${cfg.symbol}`;
}

// Saisie d'un montant : chiffres seuls (espaces et symbole tolérés). null si invalide ou nul.
function parseAmount(raw) {
  const digits = String(raw ?? '').replace(/[\s\u00a0\u202f$]/g, '');
  if (!/^\d{1,12}$/.test(digits)) return null;
  const n = Number(digits);
  return n > 0 ? n : null;
}

// Saisie d'un montant qui peut valoir 0 (prix d'abonnement gratuit). null si invalide.
function parseAmountOrZero(raw) {
  const digits = String(raw ?? '').replace(/[\s\u00a0\u202f$]/g, '');
  if (!/^\d{1,12}$/.test(digits)) return null;
  return Number(digits);
}

module.exports = { NBSP, formatNumber, formatMoney, parseAmount, parseAmountOrZero };
