const { ButtonStyle, ChannelType, ChannelSelectMenuBuilder } = require('discord.js');
const { getModuleConfig, updateModuleConfig } = require('../store');
const { embed, button, row, selectMenu, moduleSelectRow, textModal, truncate, ephemeralPayload } = require('../ui');
const { MODULE_LIST } = require('./registry');

const ID = 'embed';
const MAX_TEMPLATES = 10;
const MAX_FIELDS = 25; // limite Discord
const DEFAULTS = {
  draft: {}, // brouillon en cours : title, url, description, authorName, authorIcon, footerText, image, thumbnail, fields[]
  templates: {}, // id -> { name, data }
};

function cfgOf(guildId) {
  return getModuleConfig(guildId, ID, DEFAULTS);
}

function save(guildId, cfg) {
  updateModuleConfig(guildId, ID, cfg);
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isEmpty(d) {
  return !(
    d.title ||
    d.description ||
    d.authorName ||
    d.footerText ||
    d.image ||
    d.thumbnail ||
    (d.fields && d.fields.length)
  );
}

// Construit l'embed Discord à partir du brouillon (toujours violet).
function buildEmbed(d) {
  const e = embed();
  if (d.title) e.setTitle(d.title);
  if (d.url) e.setURL(d.url);
  if (d.description) e.setDescription(d.description);
  if (d.authorName) e.setAuthor({ name: d.authorName, iconURL: d.authorIcon || undefined });
  if (d.footerText) e.setFooter({ text: d.footerText });
  if (d.image) e.setImage(d.image);
  if (d.thumbnail) e.setThumbnail(d.thumbnail);
  if (d.fields?.length) {
    e.addFields(d.fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })));
  }
  return e;
}

// Fenêtres de saisie : une par "partie" de l'embed.
const MODALS = {
  title: {
    title: 'Titre & lien',
    fields: (d) => [
      { key: 'title', label: 'Titre', max: 256, value: d.title, placeholder: 'Ex : 📢 Annonce importante' },
      { key: 'url', label: 'Lien du titre (optionnel)', max: 500, value: d.url, placeholder: 'https://…' },
    ],
  },
  description: {
    title: 'Description',
    fields: (d) => [
      {
        key: 'description',
        label: 'Description',
        max: 4000,
        paragraph: true,
        value: d.description,
        placeholder: 'Le texte de ton embed. Les retours à la ligne sont acceptés.',
      },
    ],
  },
  meta: {
    title: 'Auteur & pied de page',
    fields: (d) => [
      { key: 'authorName', label: 'Auteur', max: 256, value: d.authorName },
      { key: 'authorIcon', label: 'Icône de l’auteur (URL)', max: 500, value: d.authorIcon, placeholder: 'https://…' },
      { key: 'footerText', label: 'Pied de page', max: 2048, value: d.footerText },
    ],
  },
  images: {
    title: 'Images',
    fields: (d) => [
      { key: 'image', label: 'Grande image (URL)', max: 500, value: d.image, placeholder: 'https://…' },
      { key: 'thumbnail', label: 'Miniature (URL)', max: 500, value: d.thumbnail, placeholder: 'https://…' },
    ],
  },
  field: {
    title: 'Ajouter un champ',
    fields: () => [
      { key: 'name', label: 'Nom du champ', max: 256, required: true, placeholder: 'Ex : Règles' },
      { key: 'value', label: 'Contenu', max: 1024, paragraph: true, required: true },
      { key: 'inline', label: 'Côte à côte ? (oui / non)', max: 3, value: 'non' },
    ],
  },
  tplsave: {
    title: 'Sauver le modèle',
    fields: () => [{ key: 'name', label: 'Nom du modèle', max: 40, required: true, placeholder: 'Ex : Règlement' }],
  },
};

// ---------------------------------------------------------------------------
// Vues
// ---------------------------------------------------------------------------

function render(view, guild) {
  const cfg = cfgOf(guild.id);
  switch (view) {
    case 'delfield':
      return renderDelField(cfg);
    case 'send':
      return renderSend(cfg);
    case 'templates':
      return renderTemplates(cfg);
    case 'clear':
      return renderClear();
    case 'main':
    default:
      return renderMain(cfg);
  }
}

function renderMain(cfg) {
  const d = cfg.draft;
  const count = Object.keys(cfg.templates).length;
  const empty = isEmpty(d);
  const preview = empty
    ? embed('_Ton embed est vide. Commence par un titre ou une description._')
    : buildEmbed(d);

  return {
    content:
      '🧩 **Créateur d’embed** · remplis les boutons ci-dessous, l’aperçu se met à jour ici. ' +
      'Tous les embeds sont violets.',
    embeds: [preview],
    components: [
      moduleSelectRow(MODULE_LIST, ID),
      row(
        button('cfg:embed:open:title', 'Titre & lien', ButtonStyle.Primary, '✏️'),
        button('cfg:embed:open:description', 'Description', ButtonStyle.Primary, '📝'),
        button('cfg:embed:open:meta', 'Auteur & pied', ButtonStyle.Secondary, '👤'),
        button('cfg:embed:open:images', 'Images', ButtonStyle.Secondary, '🖼️'),
        button('cfg:embed:open:field', 'Ajouter un champ', ButtonStyle.Success, '➕'),
      ),
      row(
        button('cfg:embed:view:delfield', 'Supprimer un champ', ButtonStyle.Secondary, '🗑️').setDisabled(
          !d.fields?.length,
        ),
        button('cfg:embed:open:tplsave', 'Sauver le modèle', ButtonStyle.Secondary, '💾').setDisabled(empty),
        button('cfg:embed:view:templates', `Modèles (${count}/${MAX_TEMPLATES})`, ButtonStyle.Secondary, '📂'),
        button('cfg:embed:view:clear', 'Vider', ButtonStyle.Danger, '🧹').setDisabled(empty),
        button('cfg:embed:view:send', 'Envoyer dans un salon', ButtonStyle.Success, '📌').setDisabled(empty),
      ),
    ],
  };
}

function renderDelField(cfg) {
  const fields = cfg.draft.fields ?? [];
  if (!fields.length) return renderMain(cfg);
  return {
    embeds: [embed('Choisis le champ à supprimer.')],
    components: [
      selectMenu(
        'cfg:embed:delpick',
        'Choisis un champ',
        fields.map((f, i) => ({ label: `${i + 1}. ${f.name}`, value: i, description: truncate(f.value, 100) })),
      ),
      row(button('cfg:embed:view:main', '◀ Retour', ButtonStyle.Danger)),
    ],
  };
}

function renderSend(cfg) {
  if (isEmpty(cfg.draft)) return renderMain(cfg);
  return {
    embeds: [embed('Choisis le salon où envoyer l’embed. Le bot doit pouvoir y écrire et y intégrer des liens.')],
    components: [
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:embed:sendpick')
          .setPlaceholder('Sélectionne un salon')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      row(button('cfg:embed:view:main', '◀ Retour', ButtonStyle.Danger)),
    ],
  };
}

function renderTemplates(cfg) {
  const entries = Object.entries(cfg.templates);
  const components = [];
  if (entries.length) {
    const opts = entries.map(([id, t]) => ({ label: t.name, value: id, description: 'Charger ce modèle' }));
    components.push(selectMenu('cfg:embed:tplload', 'Charger un modèle dans le brouillon', opts));
    components.push(
      selectMenu(
        'cfg:embed:tpldel',
        'Supprimer un modèle',
        entries.map(([id, t]) => ({ label: t.name, value: id, description: 'Suppression définitive' })),
      ),
    );
  }
  components.push(
    row(
      button('cfg:embed:open:tplsave', 'Sauver le brouillon', ButtonStyle.Success, '💾').setDisabled(
        entries.length >= MAX_TEMPLATES || isEmpty(cfg.draft),
      ),
      button('cfg:embed:view:main', '◀ Retour', ButtonStyle.Danger),
    ),
  );
  return {
    embeds: [
      embed(
        entries.length
          ? `Tu as **${entries.length}** modèle(s) sur ${MAX_TEMPLATES}. Charger remplace le brouillon actuel.`
          : `Aucun modèle pour l’instant. Crée un embed puis clique sur **Sauver le brouillon**.`,
      ),
    ],
    components,
  };
}

function renderClear() {
  return {
    embeds: [embed('Vider le brouillon ? Les modèles sauvegardés sont conservés.')],
    components: [
      row(
        button('cfg:embed:clearok', 'Oui, vider', ButtonStyle.Danger, '🧹'),
        button('cfg:embed:view:main', 'Annuler', ButtonStyle.Secondary),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const [, , action, arg] = interaction.customId.split(':');
  const cfg = cfgOf(guild.id);

  switch (action) {
    case 'view':
      return interaction.update(render(arg, guild));

    case 'open': {
      const spec = MODALS[arg];
      if (!spec) return;
      if (arg === 'tplsave' && Object.keys(cfg.templates).length >= MAX_TEMPLATES) {
        return interaction.reply(ephemeralPayload(`Maximum ${MAX_TEMPLATES} modèles. Supprime-en un avant.`));
      }
      return interaction.showModal(textModal(`cfg:embed:modal:${arg}`, spec.title, spec.fields(cfg.draft)));
    }

    case 'delpick': {
      const index = Number(interaction.values[0]);
      if (cfg.draft.fields?.[index]) {
        cfg.draft.fields.splice(index, 1);
        if (!cfg.draft.fields.length) delete cfg.draft.fields;
        save(guild.id, cfg);
      }
      return interaction.update(renderMain(cfg));
    }

    case 'sendpick': {
      await interaction.deferUpdate();
      try {
        const channel = guild.channels.cache.get(interaction.values[0]) ?? (await guild.channels.fetch(interaction.values[0]));
        await channel.send({ embeds: [buildEmbed(cfg.draft)] });
        await interaction.editReply(renderMain(cfg));
        return interaction.followUp(ephemeralPayload(`✅ Embed envoyé dans <#${channel.id}>.`));
      } catch (err) {
        console.error('[embed] envoi :', err);
        await interaction.editReply(renderMain(cfg));
        return interaction.followUp(
          ephemeralPayload('❌ Envoi impossible. Vérifie que j’ai la permission d’écrire et d’intégrer des liens dans ce salon.'),
        );
      }
    }

    case 'tplload': {
      const tpl = cfg.templates[interaction.values[0]];
      if (!tpl) return interaction.update(render('templates', guild));
      cfg.draft = structuredClone(tpl.data);
      save(guild.id, cfg);
      return interaction.update(renderMain(cfg));
    }

    case 'tpldel': {
      delete cfg.templates[interaction.values[0]];
      save(guild.id, cfg);
      return interaction.update(render('templates', guild));
    }

    case 'clearok': {
      cfg.draft = {};
      save(guild.id, cfg);
      return interaction.update(renderMain(cfg));
    }

    default:
      return;
  }
}

async function handleModal(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const kind = interaction.customId.split(':')[3];
  if (!MODALS[kind]) return;

  const get = (key) => interaction.fields.getTextInputValue(key).trim();
  const cfg = cfgOf(guild.id);
  const d = cfg.draft;
  let note = null;

  switch (kind) {
    case 'title': {
      const url = get('url');
      if (url && !isHttpUrl(url)) return interaction.reply(ephemeralPayload('Le lien doit commencer par https://'));
      d.title = get('title') || undefined;
      d.url = url || undefined;
      break;
    }
    case 'description':
      d.description = get('description') || undefined;
      break;
    case 'meta': {
      const icon = get('authorIcon');
      if (icon && !isHttpUrl(icon)) return interaction.reply(ephemeralPayload('L’icône doit être une URL https://'));
      d.authorName = get('authorName') || undefined;
      d.authorIcon = icon || undefined;
      d.footerText = get('footerText') || undefined;
      break;
    }
    case 'images': {
      const image = get('image');
      const thumb = get('thumbnail');
      if ((image && !isHttpUrl(image)) || (thumb && !isHttpUrl(thumb))) {
        return interaction.reply(ephemeralPayload('Les images doivent être des URL https://'));
      }
      d.image = image || undefined;
      d.thumbnail = thumb || undefined;
      break;
    }
    case 'field': {
      d.fields = d.fields ?? [];
      if (d.fields.length >= MAX_FIELDS) {
        return interaction.reply(ephemeralPayload(`Maximum ${MAX_FIELDS} champs.`));
      }
      const inline = /^(o|oui|y|yes|1|true)$/i.test(get('inline'));
      d.fields.push({ name: get('name'), value: get('value'), inline });
      break;
    }
    case 'tplsave': {
      if (Object.keys(cfg.templates).length >= MAX_TEMPLATES) {
        return interaction.reply(ephemeralPayload(`Maximum ${MAX_TEMPLATES} modèles.`));
      }
      const name = get('name');
      if (!name) return;
      cfg.templates[`tpl${Date.now().toString(36)}`] = { name, data: structuredClone(d) };
      note = `✅ Modèle « ${name} » sauvegardé.`;
      break;
    }
    default:
      return;
  }

  save(guild.id, cfg);
  await interaction.deferUpdate();
  await interaction.editReply(renderMain(cfg));
  if (note) await interaction.followUp(ephemeralPayload(note));
}

module.exports = { ID, DEFAULTS, render, handleComponent, handleModal, buildEmbed };
