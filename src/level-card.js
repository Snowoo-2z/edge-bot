// Carte de niveau (PNG) : avatar, pseudo, niveau, barre de progression, rang et temps en vocal.
// Utilise les mêmes thèmes que la carte de bienvenue ; le thème par défaut est le violet foncé.
const { createCanvas } = require('@napi-rs/canvas');
const { ensureFonts, paintBase, fetchAvatar, roundRect, circle, wrap, THEMES, W, H } = require('./welcome-image');

const LEVEL_DEFAULT_THEME = 'violet_sombre';

function formatVoice(seconds) {
  const totalMinutes = Math.floor(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/**
 * @param {object} opts
 * @param {string} opts.name          pseudo affiché
 * @param {string} [opts.avatarUrl]   URL de l'avatar (png)
 * @param {number} opts.level
 * @param {number} opts.xp            XP totale
 * @param {number} opts.levelStartXp  XP à partir de laquelle le niveau actuel commence
 * @param {number} opts.nextLevelXp   XP du niveau suivant
 * @param {number} opts.rank          position dans le serveur
 * @param {number} opts.voiceSeconds  temps total en vocal
 * @param {string} [opts.theme]
 * @returns {Promise<Buffer>} PNG
 */
async function renderLevelCard({
  name,
  avatarUrl,
  level,
  xp,
  levelStartXp,
  nextLevelXp,
  rank,
  voiceSeconds,
  theme = LEVEL_DEFAULT_THEME,
}) {
  ensureFonts();
  const t = THEMES[theme] ?? THEMES[LEVEL_DEFAULT_THEME];
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');

  paintBase(g, t);

  // Avatar dans un anneau (à gauche)
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

  // Texte (à droite de l'avatar)
  const textX = 350;
  const maxWidth = W - textX - 70;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';

  g.font = '800 54px EdgeTitle';
  g.fillStyle = '#ffffff';
  g.fillText(wrap(g, name, maxWidth, 1)[0] ?? '', textX, 150);

  g.font = '700 40px EdgeBold';
  g.fillStyle = t.light;
  g.fillText(`Niveau ${level}`, textX, 212);

  // Barre de progression
  const barX = textX;
  const barY = 240;
  const barW = maxWidth;
  const barH = 26;
  const span = Math.max(1, nextLevelXp - levelStartXp);
  const ratio = Math.min(1, Math.max(0, (xp - levelStartXp) / span));

  roundRect(g, barX, barY, barW, barH, barH / 2);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fill();

  if (ratio > 0) {
    const fillW = Math.max(barH, barW * ratio);
    const grad = g.createLinearGradient(barX, 0, barX + fillW, 0);
    grad.addColorStop(0, t.light);
    grad.addColorStop(1, '#ffffff');
    roundRect(g, barX, barY, fillW, barH, barH / 2);
    g.fillStyle = grad;
    g.fill();
  }

  g.font = '500 26px EdgeText';
  g.fillStyle = 'rgba(255,255,255,0.88)';
  g.fillText(
    `${Math.floor(xp).toLocaleString('fr-FR')} / ${nextLevelXp.toLocaleString('fr-FR')} XP`,
    barX,
    barY + barH + 42,
  );

  // Rang et temps vocal : ligne du bas, à droite de la barre (le pseudo garde toute la largeur)
  g.textAlign = 'right';
  g.font = '700 28px EdgeBold';
  g.fillStyle = '#ffffff';
  g.fillText(`#${rank}`, W - 70, barY + barH + 42);
  const rankWidth = g.measureText(`#${rank}`).width;
  g.font = '500 26px EdgeText';
  g.fillStyle = 'rgba(255,255,255,0.88)';
  g.fillText(`Vocal : ${formatVoice(voiceSeconds)}`, W - 70 - rankWidth - 26, barY + barH + 42);

  g.font = '700 20px EdgeBold';
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillText('EDGE', W - 70, H - 60);

  return canvas.toBuffer('image/png');
}

module.exports = { renderLevelCard, LEVEL_DEFAULT_THEME, formatVoice };
