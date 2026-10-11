// Système de niveaux (vocal et texte).
//  - Toutes les 30 s passées dans un salon vocal (AFK, micro ou casque coupés compris) : VOICE_XP.
//  - Chaque message écrit : TEXT_XP (sans limite de fréquence). Le vocal rapporte donc plus que le texte.
//  - Le temps vocal cumulé est compté en secondes (affiché en heures / minutes).
//  - Niveau = racine(XP / 100) : le niveau N demande 100 × N² XP au total.
//  - Passage de niveau : message texte dans le salon choisi (module Niveaux), sans image.
//  - L'XP n'est jamais affichée aux membres (ni carte /level, ni /leaderboard).
//  - Données en mémoire, sauvegardées par lots dans Supabase (table edge_levels).
const { AttachmentBuilder } = require('discord.js');
const store = require('./store');
const { getModuleConfig } = require('./store');
const { renderLevelCard, LEVEL_DEFAULT_THEME } = require('./level-card');
const { renderLeaderboardCard } = require('./leaderboard-card');
const levelsModule = require('./modules/levels');
const { VOICE_XP, VOICE_TICK_MS, TEXT_XP } = require('./xp-rules');

const FLUSH_MS = 60_000;
const LEADERBOARD_SIZE = 10;

const records = new Map(); // "guildId:userId" -> { guildId, userId, xp, voiceSeconds, dirty }
const inVoice = new Set(); // "guildId:userId" actuellement dans un salon vocal (hors bots)
let discordClient = null; // renseigné au démarrage, sert à envoyer les annonces de niveau

const keyOf = (guildId, userId) => `${guildId}:${userId}`;

function levelFromXp(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100));
}

function xpForLevel(level) {
  return 100 * level * level;
}

function recordOf(guildId, userId) {
  const key = keyOf(guildId, userId);
  let rec = records.get(key);
  if (!rec) {
    rec = { guildId, userId, xp: 0, voiceSeconds: 0, dirty: false };
    records.set(key, rec);
  }
  return rec;
}

// Ajoute de l'XP et annonce le passage de niveau si le seuil est franchi.
function addXp(guildId, userId, amount) {
  const rec = recordOf(guildId, userId);
  const before = levelFromXp(rec.xp);
  rec.xp += amount;
  rec.dirty = true;
  const after = levelFromXp(rec.xp);
  if (after > before) announceLevelUp(guildId, userId, after);
  return rec;
}

// Message de passage de niveau dans le salon configuré (si le module est activé).
function announceLevelUp(guildId, userId, level) {
  if (!discordClient) return;
  const cfg = getModuleConfig(guildId, levelsModule.ID, levelsModule.DEFAULTS);
  if (!cfg.enabled || !cfg.channelId) return;
  const guild = discordClient.guilds.cache.get(guildId);
  if (!guild) return;
  const content = levelsModule.fill(levelsModule.levelUpText(cfg), { user: `<@${userId}>`, level });
  (async () => {
    try {
      const channel = guild.channels.cache.get(cfg.channelId) ?? (await guild.channels.fetch(cfg.channelId));
      if (!channel?.isTextBased()) return;
      await channel.send({ content, allowedMentions: { users: [userId] } });
    } catch (err) {
      console.error('[niveaux] annonce de niveau :', err.message);
    }
  })();
}

// Charge les niveaux existants depuis Supabase (au démarrage).
async function init() {
  const rows = await store.loadLevelRows();
  for (const row of rows) {
    records.set(keyOf(row.guild_id, row.user_id), {
      guildId: row.guild_id,
      userId: row.user_id,
      xp: Number(row.xp) || 0,
      voiceSeconds: Number(row.voice_seconds) || 0,
      dirty: false,
    });
  }
  console.log(`[niveaux] ${rows.length} membre(s) chargé(s) depuis Supabase.`);
}

// Suivi des entrées / sorties / déplacements dans les salons vocaux.
function onVoiceStateUpdate(oldState, newState) {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;
  const key = keyOf(newState.guild.id, member.id);
  if (newState.channelId) inVoice.add(key);
  else inVoice.delete(key);
}

// Au démarrage : mémorise le client et repère les membres déjà présents dans un salon vocal.
function scanVoice(client) {
  discordClient = client;
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.member?.user.bot) continue;
      inVoice.add(keyOf(guild.id, state.id));
    }
  }
}

// Message écrit sur un serveur : gain d'XP texte (bots et messages privés exclus).
function onMessage(message) {
  if (!message.guild || !message.author || message.author.bot) return;
  addXp(message.guild.id, message.author.id, TEXT_XP);
}

// Appelée toutes les 30 s : crédite l'XP et le temps vocal à tous les membres présents en vocal.
function tick() {
  for (const key of inVoice) {
    const [guildId, userId] = key.split(':');
    const rec = addXp(guildId, userId, VOICE_XP);
    rec.voiceSeconds += VOICE_TICK_MS / 1000;
  }
}

// Envoie à Supabase les lignes modifiées depuis le dernier envoi.
async function flush() {
  const dirty = [...records.values()].filter((rec) => rec.dirty);
  if (!dirty.length) return;
  for (const rec of dirty) rec.dirty = false;
  const rows = dirty.map((rec) => ({
    guild_id: rec.guildId,
    user_id: rec.userId,
    xp: rec.xp,
    voice_seconds: rec.voiceSeconds,
    updated_at: new Date().toISOString(),
  }));
  try {
    await store.saveLevelRows(rows);
  } catch (err) {
    console.error('[niveaux] sauvegarde échouée, nouvel essai au prochain cycle :', err.message);
    for (const rec of dirty) rec.dirty = true;
  }
}

function startTimers() {
  setInterval(tick, VOICE_TICK_MS).unref();
  setInterval(() => flush(), FLUSH_MS).unref();
}

// Classement d'un serveur : [{ userId, xp, voiceSeconds }] trié par XP décroissante (XP > 0 seulement).
function guildRanking(guildId) {
  return [...records.values()]
    .filter((rec) => rec.guildId === guildId && rec.xp > 0)
    .sort((a, b) => b.xp - a.xp || b.voiceSeconds - a.voiceSeconds);
}

function rankOf(guildId, userId) {
  const ranking = guildRanking(guildId);
  const index = ranking.findIndex((rec) => rec.userId === userId);
  return index === -1 ? null : index + 1;
}

async function handleLevel(interaction) {
  const guild = interaction.guild;
  const target = interaction.options.getUser('membre') ?? interaction.user;
  await interaction.deferReply();

  const rec = records.get(keyOf(guild.id, target.id)) ?? { xp: 0, voiceSeconds: 0 };
  const level = levelFromXp(rec.xp);
  const member = await guild.members.fetch(target.id).catch(() => null);
  const name = member?.displayName ?? target.username;
  const rank = rankOf(guild.id, target.id);
  const { theme } = getModuleConfig(guild.id, levelsModule.ID, levelsModule.DEFAULTS);

  // L'XP sert à la barre de progression uniquement : elle n'est pas écrite sur la carte.
  const png = await renderLevelCard({
    name,
    avatarUrl: target.displayAvatarURL({ extension: 'png', size: 256 }),
    level,
    xp: rec.xp,
    levelStartXp: xpForLevel(level),
    nextLevelXp: xpForLevel(level + 1),
    rank: rank ?? '—',
    voiceSeconds: rec.voiceSeconds,
    theme: theme ?? LEVEL_DEFAULT_THEME,
  });

  return interaction.editReply({
    files: [new AttachmentBuilder(png, { name: 'level.png' })],
    allowedMentions: { parse: [] },
  });
}

async function handleLeaderboard(interaction) {
  const guild = interaction.guild;
  await interaction.deferReply();

  const top = guildRanking(guild.id).slice(0, LEADERBOARD_SIZE);
  const ids = top.map((rec) => rec.userId);
  const members = ids.length ? await guild.members.fetch({ user: ids }).catch(() => null) : null;
  const rows = top.map((rec, i) => ({
    rank: i + 1,
    name: members?.get(rec.userId)?.displayName ?? `Membre ${rec.userId.slice(-4)}`,
    level: levelFromXp(rec.xp),
    voiceSeconds: rec.voiceSeconds,
  }));

  const { theme } = getModuleConfig(guild.id, levelsModule.ID, levelsModule.DEFAULTS);
  const png = await renderLeaderboardCard({
    rows,
    theme: theme ?? LEVEL_DEFAULT_THEME,
    subtitle: 'Top 10 du serveur',
  });

  return interaction.editReply({
    files: [new AttachmentBuilder(png, { name: 'leaderboard.png' })],
    allowedMentions: { parse: [] },
  });
}

// Sauvegarde immédiate à l'arrêt du service (Render envoie SIGTERM lors d'un redéploiement).
async function flushOnExit() {
  await Promise.race([flush(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

module.exports = {
  VOICE_XP,
  VOICE_TICK_MS,
  TEXT_XP,
  init,
  onVoiceStateUpdate,
  onMessage,
  scanVoice,
  tick,
  flush,
  flushOnExit,
  startTimers,
  guildRanking,
  rankOf,
  levelFromXp,
  xpForLevel,
  handleLevel,
  handleLeaderboard,
  records,
  inVoice,
};
