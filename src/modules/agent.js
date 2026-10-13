// Module « Agent IA (serveur) » : un agent qui lit, crée et modifie le serveur selon un objectif.
// - /agent objectif:… (administrateurs) lance l'agent ;
// - il prépare un plan, que tu valides avec des boutons (réglable) ;
// - chaque action est publiée dans le salon de suivi, un message par étape ;
// - les suppressions demandent toujours une confirmation.
// Configuration : /config → 🧠 Agent IA.
const { randomBytes } = require('node:crypto');
const { ButtonStyle, ChannelType, PermissionFlagsBits, ChannelSelectMenuBuilder } = require('discord.js');
const store = require('../store');
const { embed, button, row, toggleButton, moduleSelectRow, ephemeralPayload } = require('../ui');
const { MODULE_LIST } = require('./registry');
const aiClient = require('../ai-client');
const ai = require('./ai');
const { CATEGORIES, CATEGORY_LABEL } = require('../agent/tools');
const { runAgent, PLAN_TIMEOUT_MS, DELETE_TIMEOUT_MS } = require('../agent/engine');

const ID = 'agent';
const STEP_CHOICES = [5, 8, 12, 16, 20, 25];
const DEFAULT_CATEGORIES = { read: true, create: true, edit: true, send: true, delete: false };

const DEFAULTS = {
  enabled: false,
  model: ai.MODELS[0],
  channelId: '', // salon de suivi ; vide = salon où /agent est lancé
  approval: true, // plan à valider avant exécution
  maxSteps: 12,
  categories: { ...DEFAULT_CATEGORIES },
};

const activeRuns = new Set(); // ids de serveurs où un agent tourne
const decisions = new Map(); // jeton -> { resolve } pour les boutons Valider / Refuser

function cfgOf(guildId) {
  const raw = store.getModuleConfig(guildId, ID, DEFAULTS);
  return {
    ...DEFAULTS,
    ...raw,
    categories: { ...DEFAULT_CATEGORIES, ...(raw.categories ?? {}) },
  };
}

function saveCfg(guildId, cfg) {
  store.updateModuleConfig(guildId, ID, cfg);
}

// ---------------------------------------------------------------------------
// Panneau /config
// ---------------------------------------------------------------------------

function render(view, guild) {
  if (view === 'tools') return renderTools(guild);
  if (view === 'channel') return renderChannel();
  return renderMain(guild);
}

function renderMain(guild) {
  const cfg = cfgOf(guild.id);
  const enabledTools = CATEGORIES.filter((c) => cfg.categories[c]).map((c) => CATEGORY_LABEL[c]);
  return {
    content:
      '🧠 **Agent IA (serveur)** · un agent lit, crée et modifie les salons et rôles selon ton objectif. ' +
      'Lance-le avec `/agent objectif:` (administrateurs). Chaque action est publiée dans le salon de suivi.',
    embeds: [
      embed().addFields(
        { name: 'Module', value: cfg.enabled ? '🟢 Activé' : '⚪ Désactivé', inline: true },
        { name: 'Validation du plan', value: cfg.approval ? '🟢 Oui (recommandé)' : '⚪ Non (exécution directe)', inline: true },
        { name: 'Étapes max', value: String(cfg.maxSteps), inline: true },
        { name: 'Salon de suivi', value: cfg.channelId ? `<#${cfg.channelId}>` : 'Salon de la commande', inline: true },
        { name: 'Modèle', value: cfg.model, inline: true },
        { name: 'Outils', value: enabledTools.length ? enabledTools.join(', ') : 'Aucun', inline: true },
      ),
    ],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        toggleButton('cfg:agent:toggle:enabled', 'Module', cfg.enabled),
        toggleButton('cfg:agent:toggle:approval', 'Validation', cfg.approval),
        button('cfg:agent:cycle:steps', `Étapes : ${cfg.maxSteps}`, ButtonStyle.Secondary, '🔁'),
        button('cfg:agent:cycle:model', 'Modèle', ButtonStyle.Secondary, '🤖'),
      ),
      row(
        button('cfg:agent:view:tools', 'Outils', ButtonStyle.Primary, '🧰'),
        button('cfg:agent:view:channel', 'Salon de suivi', ButtonStyle.Primary, '📍'),
      ),
    ],
  };
}

function renderTools(guild) {
  const cfg = cfgOf(guild.id);
  const help = {
    read: 'Lire les salons, rôles et messages (aussi utilisé pour préparer le plan).',
    create: 'Créer catégories, salons texte/vocaux et rôles (sans permissions particulières).',
    edit: 'Modifier salons (nom, sujet, catégorie) et accès des rôles.',
    send: 'Envoyer des messages dans les salons.',
    delete: 'Supprimer salons et rôles. Chaque suppression est confirmée par un administrateur.',
  };
  return {
    embeds: [embed(CATEGORIES.map((c) => `**${CATEGORY_LABEL[c]}** : ${help[c]}`).join('\n'))],
    components: [
      row(
        ...CATEGORIES.map((c) =>
          toggleButton(`cfg:agent:tool:${c}`, CATEGORY_LABEL[c], cfg.categories[c]),
        ),
      ),
      row(button('cfg:agent:view:main', '◀ Retour', ButtonStyle.Danger)),
    ],
  };
}

function renderChannel() {
  return {
    embeds: [embed('Choisis le salon où l’agent publie son plan et ses actions.')],
    components: [
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:agent:pick:channel')
          .setPlaceholder('Sélectionne un salon')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      row(
        button('cfg:agent:reset:channel', 'Utiliser le salon de la commande', ButtonStyle.Secondary, '↩️'),
        button('cfg:agent:view:main', '◀ Retour', ButtonStyle.Danger),
      ),
    ],
  };
}

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, arg] = interaction.customId.split(':');
  const cfg = cfgOf(guild.id);

  switch (action) {
    case 'view':
      return interaction.update(render(arg, guild));
    case 'toggle': {
      if (arg === 'enabled') cfg.enabled = !cfg.enabled;
      else if (arg === 'approval') cfg.approval = !cfg.approval;
      else return;
      saveCfg(guild.id, cfg);
      return interaction.update(renderMain(guild));
    }
    case 'cycle': {
      if (arg === 'steps') {
        const i = STEP_CHOICES.indexOf(cfg.maxSteps);
        cfg.maxSteps = STEP_CHOICES[(i + 1) % STEP_CHOICES.length];
      } else if (arg === 'model') {
        const i = ai.MODELS.indexOf(cfg.model);
        cfg.model = ai.MODELS[(i + 1) % ai.MODELS.length];
      } else return;
      saveCfg(guild.id, cfg);
      return interaction.update(renderMain(guild));
    }
    case 'tool': {
      if (!CATEGORIES.includes(arg)) return;
      cfg.categories[arg] = !cfg.categories[arg];
      saveCfg(guild.id, cfg);
      return interaction.update(renderTools(guild));
    }
    case 'pick': {
      if (arg !== 'channel') return;
      cfg.channelId = interaction.values[0];
      saveCfg(guild.id, cfg);
      return interaction.update(renderMain(guild));
    }
    case 'reset': {
      if (arg !== 'channel') return;
      cfg.channelId = '';
      saveCfg(guild.id, cfg);
      return interaction.update(renderMain(guild));
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Commande /agent
// ---------------------------------------------------------------------------

// Demande une validation (boutons). Renvoie true si un administrateur clique « oui », false sinon ou au bout du délai.
function askConfirm(channel, { text, yes, no, timeoutMs = PLAN_TIMEOUT_MS }) {
  const token = randomBytes(6).toString('hex');
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      clearTimeout(timer);
      decisions.delete(token);
      resolve(value);
    };
    timer = setTimeout(() => {
      if (!decisions.has(token)) return;
      channel.send({ content: '⏱️ Délai dépassé : rien n’a été fait.' }).catch(() => {});
      finish(false);
    }, timeoutMs);
    decisions.set(token, { resolve: finish });
    channel
      .send({
        content: text,
        allowedMentions: { parse: [] },
        components: [
          row(
            button(`agent:ok:${token}`, yes, ButtonStyle.Success, '✅'),
            button(`agent:no:${token}`, no, ButtonStyle.Danger, '✖️'),
          ),
        ],
      })
      .catch(() => finish(false));
  });
}

async function handleCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply(ephemeralPayload('Cette commande ne fonctionne que sur un serveur.'));
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) {
    return interaction.reply(ephemeralPayload('Le module Agent IA est désactivé : `/config` → 🧠 Agent IA.'));
  }
  if (!aiClient.isConfigured()) {
    return interaction.reply(ephemeralPayload('Clé MISTRAL_API_KEY absente : l’agent ne peut pas démarrer.'));
  }
  if (activeRuns.has(guild.id)) {
    return interaction.reply(ephemeralPayload('Un agent travaille déjà sur ce serveur. Attends la fin de son exécution.'));
  }
  const goal = interaction.options.getString('objectif', true).trim();
  const preferred = cfg.channelId ? guild.channels.cache.get(cfg.channelId) : null;
  const channel = preferred?.send ? preferred : interaction.channel;
  if (!channel?.send) {
    return interaction.reply(ephemeralPayload('Je ne peux pas écrire dans ce salon : choisis un salon de suivi dans `/config`.'));
  }

  activeRuns.add(guild.id);
  await interaction.reply(
    ephemeralPayload(`🧠 Agent lancé. Suivi et validation dans <#${channel.id}>.`),
  );

  const say = async (content) => {
    try {
      await channel.send({ content: content.length > 1900 ? `${content.slice(0, 1897)}…` : content, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[agent] message de suivi non envoyé :', err.message);
    }
  };

  // Lancement sans attendre : l'interaction est déjà acquittée, le suivi se fait dans le salon.
  runAgent({
    guild,
    goal,
    cfg,
    traceChannelId: channel.id,
    serverName: guild.name,
    say,
    confirm: (opts) => askConfirm(channel, { ...opts, timeoutMs: opts.timeoutMs ?? DELETE_TIMEOUT_MS }),
    chat: aiClient.chat,
  })
    .then((res) => console.log(`[agent] ${guild.id} : ${res.status}, ${res.actions} action(s)`))
    .catch((err) => console.error('[agent] erreur :', err))
    .finally(() => activeRuns.delete(guild.id));
}

// Boutons « Valider / Refuser » (customId agent:ok:<jeton> ou agent:no:<jeton>).
async function handleInteraction(interaction) {
  const [, verb, token] = String(interaction.customId ?? '').split(':');
  const pending = decisions.get(token);
  if (!pending) {
    return interaction.reply(ephemeralPayload('Cette demande n’est plus active.'));
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply(ephemeralPayload('Seuls les administrateurs peuvent valider une action de l’agent.'));
  }
  pending.resolve(verb === 'ok');
  return interaction.update({
    content: `${verb === 'ok' ? '✅ Validé' : '✖️ Refusé'} par ${interaction.user.username}.`,
    components: [],
  });
}

module.exports = {
  ID,
  DEFAULTS,
  STEP_CHOICES,
  cfgOf,
  render,
  handleComponent,
  handleCommand,
  handleInteraction,
  askConfirm,
  activeRuns,
  decisions,
};
