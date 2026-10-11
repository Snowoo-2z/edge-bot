// Système de niveaux basé sur le temps passé en vocal.
//  - Chaque minute passée dans un salon vocal (AFK, micro coupé, casque coupé compris) rapporte XP_PER_MINUTE.
//  - Le temps vocal cumulé est compté en secondes (affiché en heures / minutes).
//  - Niveau = racine(XP / 100) : le niveau N demande 100 × N² XP au total.
//  - Données en mémoire, sauvegardées par lots dans Supabase (table edge_levels).
const { AttachmentBuilder } = require('discord.js');
const store = require('./store');
const { getModuleConfig } = require('./store');
const { embed } = require('./ui');
const { renderLevelCard, LEVEL_DEFAULT_THEME, formatVoice } = require('./level-card');
const levelsModule = require('./modules/levels');

const XP_PER_MINUTE = 20;
const TICK_MS = 60_000;
const FLUSH_MS = 60_000;
const LEADERBOARD_SIZE = 10;

const records = new Map(); // "guildId:userId" -> { guildId, userId, xp, voiceSeconds, dirty }
const inVoice = new Set(); // "guildId:userId" actuellement dans un salon vocal (hors bots)

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

// Au démarrage : repère les membres déjà présents dans un salon vocal.
function scanVoice(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.member?.user.bot) continue;
      inVoice.add(keyOf(guild.id, state.id));
    }
  }
}

// Appelée chaque minute : crédite l'XP et le temps vocal à tous les membres présents en vocal.
function tick() {
  for (const key of inVoice) {
    const [guildId, userId] = key.split(':');
    const rec = recordOf(guildId, userId);
    rec.xp += XP_PER_MINUTE;
    rec.voiceSeconds += TICK_MS / 1000;
    rec.dirty = true;
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
  setInterval(tick, TICK_MS).unref();
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
  const top = guildRanking(guild.id).slice(0, LEADERBOARD_SIZE);
  const medals = ['🥇', '🥈', '🥉'];

  const lines = top.map((rec, i) => {
    const place = medals[i] ?? `**${i + 1}.**`;
    return `${place} <@${rec.userId}> · niveau **${levelFromXp(rec.xp)}** · ${Math.floor(rec.xp).toLocaleString('fr-FR')} XP · 🎙️ ${formatVoice(rec.voiceSeconds)}`;
  });

  const e = embed(
    lines.length
      ? lines.join('\n')
      : 'Personne n’a encore gagné d’XP. Rejoins un salon vocal pour commencer !',
  ).setTitle('🏆 Classement vocal');
  e.setFooter({ text: `${XP_PER_MINUTE} XP par minute en vocal · AFK compris` });

  return interaction.reply({ embeds: [e], allowedMentions: { parse: [] } });
}

// Sauvegarde immédiate à l'arrêt du service (Render envoie SIGTERM lors d'un redéploiement).
async function flushOnExit() {
  await Promise.race([flush(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

module.exports = {
  XP_PER_MINUTE,
  init,
  onVoiceStateUpdate,
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
