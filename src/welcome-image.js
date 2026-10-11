// Génère la carte de bienvenue (PNG).
// Structure ("squelette") : fond dégradé, halos décoratifs, cadre arrondi,
// avatar dans un anneau, titre et sous-titre. Tout est dessiné par code : aucune image à fournir.
// Le thème (couleurs + décor) est choisi manuellement dans /config ; il ne change pas automatiquement.
const path = require('node:path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const W = 1000;
const H = 400;
// Thèmes disponibles. stops = dégradé (du coin haut-gauche au coin bas-droit).
// decor : 'moon' (lune) | 'snow' (neige) | null.
const THEMES = {
  violet: {
    label: 'Violet',
    emoji: '💜',
    description: 'Le thème par défaut',
    stops: ['#2b0d3f', '#7d3c98', '#9b59b6'],
    light: '#e3c6f5',
    glow: 'rgba(227,198,245,0.55)',
    decor: null,
  },
  violet_sombre: {
    label: 'Violet foncé',
    emoji: '🌑',
    description: 'Une version plus sombre du violet',
    stops: ['#120520', '#2e1049', '#4f1f7a'],
    light: '#c9a6ea',
    glow: 'rgba(201,166,234,0.45)',
    decor: null,
  },
  halloween: {
    label: 'Halloween',
    emoji: '🎃',
    description: 'Octobre : noir, violet et orange, avec une lune',
    stops: ['#0b0610', '#3a1a33', '#d9621a'],
    light: '#ffc98a',
    glow: 'rgba(255,160,70,0.55)',
    decor: 'moon',
  },
  noel: {
    label: 'Noël',
    emoji: '🎄',
    description: 'Vert sapin, rouge et neige',
    stops: ['#04200f', '#0f4a2a', '#a31d2e'],
    light: '#f7e7c4',
    glow: 'rgba(247,231,196,0.5)',
    decor: 'snow',
  },
};
const DEFAULT_THEME = 'violet';
const THEME_LIST = Object.entries(THEMES).map(([id, t]) => ({
  id,
  label: t.label,
  emoji: t.emoji,
  description: t.description,
}));

// Génère des positions de neige stables (même carte à chaque rendu).
function snowflakes(count) {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const flakes = [];
  for (let i = 0; i < count; i++) {
    flakes.push({ x: rand() * W, y: rand() * H, r: 1.5 + rand() * 2.5, a: 0.45 + rand() * 0.45 });
  }
  return flakes;
}

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
async function renderWelcomeCard({ title, subtitle, avatarUrl, initial = '?', showAvatar = true, theme = DEFAULT_THEME }) {
  ensureFonts();
  const t = THEMES[theme] ?? THEMES[DEFAULT_THEME];
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');

  // 1. Fond dégradé du thème
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, t.stops[0]);
  bg.addColorStop(0.55, t.stops[1]);
  bg.addColorStop(1, t.stops[2]);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // 2. Halos décoratifs
  g.fillStyle = 'rgba(255,255,255,0.06)';
  circle(g, 860, 30, 240);
  g.fill();
  circle(g, -30, 390, 180);
  g.fill();
  g.fillStyle = t.glow.replace(/[\d.]+\)$/, '0.10)');
  circle(g, 930, 350, 90);
  g.fill();

  // 2b. Décor propre au thème
  if (t.decor === 'moon') {
    g.save();
    g.shadowColor = 'rgba(255,220,160,0.7)';
    g.shadowBlur = 50;
    g.fillStyle = 'rgba(255,241,207,0.92)';
    circle(g, 925, 62, 36);
    g.fill();
    g.restore();
  } else if (t.decor === 'snow') {
    for (const f of snowflakes(70)) {
      g.fillStyle = `rgba(255,255,255,${f.a.toFixed(2)})`;
      circle(g, f.x, f.y, f.r);
      g.fill();
    }
  }

  // 3. Cadre arrondi
  roundRect(g, 28, 28, W - 56, H - 56, 34);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = t.glow.replace(/[\d.]+\)$/, '0.35)');
  g.stroke();

  // 4. Avatar dans un anneau
  const textX = showAvatar ? 380 : 90;
  if (showAvatar) {
    const cx = 210;
    const cy = H / 2;
    const r = 110;

    // Halo sous l'anneau
    g.save();
    g.shadowColor = t.glow;
    g.shadowBlur = 40;
    g.beginPath();
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

module.exports = { renderWelcomeCard, THEMES, THEME_LIST, DEFAULT_THEME, W, H };
