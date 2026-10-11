// Carte du classement (PNG) : top du serveur, avec rang, pseudo, niveau et temps vocal.
// Les montants d'XP ne sont pas affichés sur le classement.
// Même système de thèmes que les autres cartes ; la hauteur s'adapte au nombre de lignes.
const { createCanvas } = require('@napi-rs/canvas');
const { ensureFonts, paintBase, roundRect, circle, wrap, THEMES, W } = require('./welcome-image');
const { formatVoice } = require('./level-card');

const LEVEL_DEFAULT_THEME = 'violet_sombre';
const HEADER_H = 150;
const ROW_H = 60;
const FOOTER_H = 50;
const MEDAL = ['#f2c14e', '#cfd8dc', '#c98a4b'];

/**
 * @param {object} opts
 * @param {Array<{rank:number, name:string, level:number, voiceSeconds:number}>} opts.rows
 * @param {string} [opts.theme]
 * @param {string} [opts.subtitle]
 * @returns {Promise<Buffer>} PNG
 */
async function renderLeaderboardCard({ rows, theme = LEVEL_DEFAULT_THEME, subtitle = '' }) {
  ensureFonts();
  const t = THEMES[theme] ?? THEMES[LEVEL_DEFAULT_THEME];
  const H = Math.max(400, HEADER_H + Math.max(rows.length, 1) * ROW_H + FOOTER_H);
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');

  paintBase(g, t, H);

  // Titre
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
    g.fillText('Personne n’a encore gagné d’XP. Rejoins un salon vocal ou écris un message !', 70, HEADER_H + 40);
    return canvas.toBuffer('image/png');
  }

  rows.forEach((row, i) => {
    const y = HEADER_H + i * ROW_H;

    // Ligne
    roundRect(g, 60, y, W - 120, ROW_H - 10, 14);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fill();

    // Badge de rang
    const cy = y + (ROW_H - 10) / 2;
    circle(g, 100, cy, 21);
    g.fillStyle = MEDAL[i] ?? 'rgba(255,255,255,0.22)';
    g.fill();
    g.font = '800 22px EdgeTitle';
    g.fillStyle = i < 3 ? '#1b1024' : '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(row.rank), 100, cy + 1);

    // Pseudo (tronqué si trop long)
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = '700 28px EdgeBold';
    g.fillStyle = '#ffffff';
    g.fillText(wrap(g, row.name, 300, 1)[0] ?? '', 140, cy + 10);

    // Niveau
    g.font = '500 24px EdgeText';
    g.fillStyle = t.light;
    g.fillText(`Niveau ${row.level}`, 560, cy + 9);

    // Temps vocal (aligné à droite)
    g.textAlign = 'right';
    g.font = '500 24px EdgeText';
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillText(formatVoice(row.voiceSeconds), W - 90, cy + 9);
  });

  g.textAlign = 'right';
  g.font = '700 20px EdgeBold';
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillText('EDGE', W - 70, H - 22);

  return canvas.toBuffer('image/png');
}

module.exports = { renderLeaderboardCard, LEVEL_DEFAULT_THEME };
