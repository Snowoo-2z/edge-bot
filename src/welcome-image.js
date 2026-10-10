// Génère la carte de bienvenue (PNG) au thème violet.
// Structure ("squelette") : fond dégradé, halos décoratifs, cadre arrondi,
// avatar dans un anneau, titre et sous-titre. Tout est dessiné par code : aucune image à fournir.
const path = require('node:path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const W = 1000;
const H = 400;
const PURPLE = {
  deep: '#2b0d3f',
  mid: '#7d3c98',
  base: '#9b59b6',
  light: '#e3c6f5',
};

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Inter_800ExtraBold.ttf'), 'EdgeTitle');
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Inter_500Medium.ttf'), 'EdgeText');
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Inter_700Bold.ttf'), 'EdgeBold');
  fontsReady = true;
}

function circle(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.closePath();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Découpe le texte en lignes qui tiennent dans maxWidth (max maxLines, avec "…" si coupé).
function wrap(g, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (g.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && g.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = last.trimEnd() + '…';
    return kept;
  }
  return lines;
}

async function fetchAvatar(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.title       texte principal (déjà rempli)
 * @param {string} opts.subtitle    sous-titre (déjà rempli)
 * @param {string} [opts.avatarUrl] URL de l'avatar (png)
 * @param {string} [opts.initial]   lettre affichée si pas d'avatar
 * @param {boolean} opts.showAvatar
 * @returns {Promise<Buffer>} PNG
 */
async function renderWelcomeCard({ title, subtitle, avatarUrl, initial = '?', showAvatar = true }) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');

  // 1. Fond dégradé violet
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, PURPLE.deep);
  bg.addColorStop(0.55, PURPLE.mid);
  bg.addColorStop(1, PURPLE.base);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // 2. Halos décoratifs
  g.fillStyle = 'rgba(255,255,255,0.06)';
  circle(g, 860, 30, 240);
  g.fill();
  circle(g, -30, 390, 180);
  g.fill();
  g.fillStyle = 'rgba(227,198,245,0.10)';
  circle(g, 930, 350, 90);
  g.fill();

  // 3. Cadre arrondi
  roundRect(g, 28, 28, W - 56, H - 56, 34);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(227,198,245,0.35)';
  g.stroke();

  // 4. Avatar dans un anneau
  const textX = showAvatar ? 380 : 90;
  if (showAvatar) {
    const cx = 210;
    const cy = H / 2;
    const r = 110;

    // Halo sous l'anneau
    g.save();
    g.shadowColor = 'rgba(227,198,245,0.55)';
    g.shadowBlur = 40;
    g.beginPath();
    circle(g, cx, cy, r + 8);
    g.fillStyle = PURPLE.light;
    g.fill();
    g.restore();

    const avatar = avatarUrl ? await fetchAvatar(avatarUrl) : null;
    g.save();
    circle(g, cx, cy, r);
    g.clip();
    if (avatar) {
      g.drawImage(avatar, cx - r, cy - r, r * 2, r * 2);
    } else {
      g.fillStyle = PURPLE.mid;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
      g.fillStyle = '#ffffff';
      g.font = '800 120px EdgeTitle';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(initial).slice(0, 1).toUpperCase(), cx, cy + 6);
    }
    g.restore();
  }

  // 5. Titre + sous-titre
  const maxWidth = W - textX - 80;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';

  g.font = '800 66px EdgeTitle';
  g.fillStyle = '#ffffff';
  const titleLines = wrap(g, title, maxWidth, 2);
  const titleLineHeight = 78;
  const titleTop = H / 2 - (titleLines.length * titleLineHeight) / 2 + 40;
  titleLines.forEach((line, i) => g.fillText(line, textX, titleTop + i * titleLineHeight));

  g.font = '500 32px EdgeText';
  g.fillStyle = 'rgba(255,255,255,0.88)';
  const subLines = wrap(g, subtitle, maxWidth, 2);
  const subTop = titleTop + (titleLines.length - 1) * titleLineHeight + 60;
  subLines.forEach((line, i) => g.fillText(line, textX, subTop + i * 42));

  // 6. Signature
  g.font = '700 22px EdgeBold';
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.textAlign = 'right';
  g.fillText('EDGE', W - 70, H - 60);

  return canvas.toBuffer('image/png');
}

module.exports = { renderWelcomeCard, W, H };
