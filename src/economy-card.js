// Cartes de l'économie (PNG) :
//  - renderProfileCard : carte personnelle de /profile (avatar, solde, rang, série, prochaine récompense).
//  - renderEconomyLeaderboardCard : classement en Edge Dollar de /leaderboard.
// Les montants d'XP ne sont jamais affichés ici. Mêmes thèmes que les autres cartes du bot.
const { createCanvas } = require('@napi-rs/canvas');
const { ensureFonts, paintBase, fetchAvatar, roundRect, circle, wrap, THEMES, W, H } = require('./welcome-image');

const ECONOMY_DEFAULT_THEME = 'violet_sombre';
const HEADER_H = 150;
const ROW_H = 60;
const FOOTER_H = 50;
const MEDAL = ['#f2c14e', '#cfd8dc', '#c98a4b'];

// 1250 -> « 1 250 ». Espace simple : la police du canevas ne garantit pas l'espace insécable.
function formatNumber(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function moneyText(n, symbol) {
  return `${formatNumber(n)} ${symbol}`;
}

// Temps restant avant la prochaine récompense, en français ; 0 ou moins = disponible.
function formatRemaining(ms) {
  if (ms <= 0) return 'disponible maintenant';
  const totalMinutes = Math.ceil(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h ? `dans ${h} h ${String(m).padStart(2, '0')} min` : `dans ${m} min`;
}

function themeOf(name) {
  return THEMES[name] ?? THEMES[ECONOMY_DEFAULT_THEME];
}

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {string|null} [opts.avatarUrl]
 * @param {number} opts.balance
 * @param {string} opts.currencyName
 * @param {string} opts.symbol
 * @param {number} opts.rank
 * @param {number} opts.streak          jours de série
 * @param {number} opts.nextDailyMs     millisecondes avant la prochaine récompense (0 = disponible)
 * @param {string} [opts.theme]
 * @returns {Promise<Buffer>} PNG
 */
async function renderProfileCard({ name, avatarUrl, balance, currencyName, symbol, rank, streak, nextDailyMs, theme }) {
  ensureFonts();
  const t = themeOf(theme);
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  paintBase(g, t);

  // Avatar dans un anneau (à gauche), ou initiale si pas d'avatar.
  const cx = 190;
  const cy = H / 2;
  const r = 100;
  g.save();
  g.shadowColor = t.glow;
  g.shadowBlur = 36;
  circle(g, cx, cy, r + 8);
  g.fillStyle = t.light;
  g.fill();
  g.restore();

  const avatar = avatarUrl ? await fetchAvatar(avatarUrl) : null;
  g.save();
  circle(g, cx, cy, r);
  g.clip();
  if (avatar) {
    g.drawImage(avatar, cx - r, cy - r, r * 2, r * 2);
  } else {
    g.fillStyle = t.stops[1];
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.fillStyle = '#ffffff';
    g.font = '800 110px EdgeTitle';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(name).slice(0, 1).toUpperCase(), cx, cy + 6);
  }
  g.restore();

  // Texte à droite de l'avatar
  const textX = 350;
  const maxWidth = W - textX - 70;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';

  g.font = '800 54px EdgeTitle';
  g.fillStyle = '#ffffff';
  g.fillText(wrap(g, name, maxWidth, 1)[0] ?? '', textX, 120);

  g.font = '700 36px EdgeBold';
  g.fillStyle = t.light;
  g.fillText(currencyName, textX, 176);

  g.font = '800 76px EdgeTitle';
  g.fillStyle = '#ffffff';
  g.fillText(moneyText(balance, symbol), textX, 268);

  g.font = '500 26px EdgeText';
  g.fillStyle = 'rgba(255,255,255,0.88)';
  g.fillText(`#${rank} sur le serveur  ·  Série : ${streak} jour(s)`, textX, 318);
  g.fillText(`Prochaine récompense : ${formatRemaining(nextDailyMs)}`, textX, 356);

  g.textAlign = 'right';
  g.font = '700 20px EdgeBold';
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillText('EDGE', W - 70, 60);

  return canvas.toBuffer('image/png');
}

/**
 * @param {object} opts
 * @param {Array<{rank:number, name:string, balance:number}>} opts.rows
 * @param {string} opts.currencyName
 * @param {string} opts.symbol
 * @param {string} [opts.theme]
 * @param {string} [opts.subtitle]
 * @returns {Promise<Buffer>} PNG
 */
async function renderEconomyLeaderboardCard({ rows, currencyName, symbol, theme, subtitle = '' }) {
  ensureFonts();
  const t = themeOf(theme);
  const H2 = Math.max(400, HEADER_H + Math.max(rows.length, 1) * ROW_H + FOOTER_H);
  const canvas = createCanvas(W, H2);
  const g = canvas.getContext('2d');
  paintBase(g, t, H2);

  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = '800 50px EdgeTitle';
  g.fillStyle = '#ffffff';
  g.fillText('Classement', 70, 100);
  if (subtitle) {
    g.font = '500 24px EdgeText';
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fillText(subtitle, 70, 132);
  }

  if (!rows.length) {
    g.font = '500 30px EdgeText';
    g.fillStyle = 'rgba(255,255,255,0.88)';
    g.fillText(`Personne n’a encore de ${currencyName}. Lance /play pour recevoir ton solde !`, 70, HEADER_H + 40);
  }

  rows.forEach((row, i) => {
    const y = HEADER_H + i * ROW_H;
    roundRect(g, 60, y, W - 120, ROW_H - 10, 14);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fill();

    const cy = y + (ROW_H - 10) / 2;
    circle(g, 100, cy, 21);
    g.fillStyle = MEDAL[i] ?? 'rgba(255,255,255,0.22)';
    g.fill();
    g.font = '800 22px EdgeTitle';
    g.fillStyle = i < 3 ? '#1b1024' : '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(row.rank), 100, cy + 1);

    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = '700 28px EdgeBold';
    g.fillStyle = '#ffffff';
    g.fillText(wrap(g, row.name, 560, 1)[0] ?? '', 140, cy + 10);

    g.textAlign = 'right';
    g.font = '700 28px EdgeBold';
    g.fillStyle = t.light;
    g.fillText(moneyText(row.balance, symbol), W - 90, cy + 10);
  });

  g.textAlign = 'right';
  g.font = '700 20px EdgeBold';
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillText('EDGE', W - 70, H2 - 22);

  return canvas.toBuffer('image/png');
}

module.exports = { renderProfileCard, renderEconomyLeaderboardCard, formatRemaining, formatNumber, ECONOMY_DEFAULT_THEME };
