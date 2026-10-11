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
// decor : 'bats' (chauves-souris) | 'noel' (guirlande, boules, neige) | null.
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
    decor: 'bats',
  },
  noel: {
    label: 'Noël',
    emoji: '🎄',
    description: 'Vert sapin, rouge et or, guirlande et neige',
    stops: ['#03200f', '#0e4a29', '#9e1b2c'],
    light: '#f7e7c4',
    glow: 'rgba(247,231,196,0.5)',
    frame: 'rgba(242,193,78,0.75)',
    decor: 'noel',
  },
};
const DEFAULT_THEME = 'violet';
const THEME_LIST = Object.entries(THEMES).map(([id, t]) => ({
  id,
  label: t.label,
  emoji: t.emoji,
  description: t.description,
}));

// Générateur pseudo-aléatoire à graine fixe : même carte à chaque rendu.
function seeded(seed) {
  let v = seed;
  return () => {
    v = (v * 16807) % 2147483647;
    return v / 2147483647;
  };
}

// Neige : points de tailles variées, plus denses vers le bas.
function drawSnow(g, count) {
  const rand = seeded(7);
  for (let i = 0; i < count; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const r = 1 + rand() * rand() * 4;
    g.fillStyle = `rgba(255,255,255,${(0.35 + rand() * 0.55).toFixed(2)})`;
    circle(g, x, y, r);
    g.fill();
  }
}

// Guirlande dorée qui pend le long du bord haut, ornée de boules rouges, dorées et blanches.
function drawGarland(g) {
  const x0 = 560;
  const x1 = 985;
  const y0 = 16;
  const sag = 36;
  const yAt = (x) => {
    const u = (x - x0) / (x1 - x0);
    return y0 + sag * 4 * u * (1 - u);
  };

  g.beginPath();
  g.moveTo(x0, y0);
  for (let x = x0; x <= x1; x += 4) g.lineTo(x, yAt(x));
  g.strokeStyle = 'rgba(242,193,78,0.85)';
  g.lineWidth = 3;
  g.stroke();

  const colors = ['#c8102e', '#f2c14e', '#fbfbf5', '#c8102e', '#f2c14e', '#fbfbf5', '#c8102e', '#f2c14e', '#fbfbf5'];
  const n = colors.length;
  colors.forEach((color, i) => {
    const x = x0 + ((i + 0.5) / n) * (x1 - x0);
    const y = yAt(x) + 12;
    const r = 9;
    // Petit bouchon au-dessus de la boule
    g.fillStyle = '#f2c14e';
    g.fillRect(x - 3, y - r - 4, 6, 5);
    // Boule avec reflet
    g.fillStyle = color;
    circle(g, x, y, r);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    circle(g, x - 3, y - 3, 2.5);
    g.fill();
  });
}

// Chauves-souris : silhouettes sombres et discrètes, dans le coin haut-droit.
function drawBat(g, x, y, s) {
  const p = (dx, dy) => [x + dx * s, y + dy * s];
  g.beginPath();
  g.moveTo(...p(0, -0.15));
  g.quadraticCurveTo(...p(-0.35, -0.75), ...p(-1.25, -0.45));
  g.quadraticCurveTo(...p(-0.85, -0.25), ...p(-1.05, 0.25));
  g.quadraticCurveTo(...p(-0.6, 0.1), ...p(-0.3, 0.25));
  g.quadraticCurveTo(...p(-0.1, 0.45), ...p(0, 0.3));
  g.quadraticCurveTo(...p(0.1, 0.45), ...p(0.3, 0.25));
  g.quadraticCurveTo(...p(0.6, 0.1), ...p(1.05, 0.25));
  g.quadraticCurveTo(...p(0.85, -0.25), ...p(1.25, -0.45));
  g.quadraticCurveTo(...p(0.35, -0.75), ...p(0, -0.15));
  g.closePath();
  g.fill();
  // Oreilles
  g.beginPath();
  g.moveTo(...p(-0.22, -0.1));
  g.lineTo(...p(-0.3, -0.42));
  g.lineTo(...p(-0.08, -0.2));
  g.moveTo(...p(0.22, -0.1));
  g.lineTo(...p(0.3, -0.42));
  g.lineTo(...p(0.08, -0.2));
  g.closePath();
  g.fill();
}

function drawBats(g) {
  g.fillStyle = 'rgba(255,200,140,0.42)';
  drawBat(g, 640, 62, 14);
  drawBat(g, 790, 38, 9);
  drawBat(g, 905, 84, 11);
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

// Fond complet d'un thème : dégradé, halos, décor propre au thème, cadre.
// Réutilisé par la carte de bienvenue et la carte de niveau.
function paintBase(g, t) {
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
  if (t.decor === 'bats') {
    drawBats(g);
  } else if (t.decor === 'noel') {
    drawSnow(g, 80);
    drawGarland(g);
  }

  // 3. Cadre arrondi
  roundRect(g, 28, 28, W - 56, H - 56, 34);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = t.frame ?? t.glow.replace(/[\d.]+\)$/, '0.35)');
  g.stroke();
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

  paintBase(g, t);

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

module.exports = {
  renderWelcomeCard,
  paintBase,
  fetchAvatar,
  roundRect,
  circle,
  wrap,
  ensureFonts,
  THEMES,
  THEME_LIST,
  DEFAULT_THEME,
  W,
  H,
};
