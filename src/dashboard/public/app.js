// Tableau de bord Edge : interface sans framework ni build.
// Aucun innerHTML : le contenu venant de Discord ou des formulaires est toujours inséré en texte.
(() => {
  'use strict';

  const CH = { TEXT: 0, ANNOUNCE: 5, CATEGORY: 4, FORUM: 15 };
  const TEXT_KINDS = [CH.TEXT, CH.ANNOUNCE];
  const FORUM_KINDS = [CH.TEXT, CH.ANNOUNCE, CH.FORUM];
  const MAX_FIELDS = 25;
  const MAX_TYPES = 25;
  const MAX_UPLOAD = 8 * 1024 * 1024;
  const LAST_GUILD_KEY = 'edgeDashGuild';

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const S = {
    bot: null, // { ready, tag, guilds }
    gid: null,
    data: null, // réponse de /state (serveur sélectionné)
    embedDraft: null, // brouillon de l'embed en cours d'édition (local)
    ticketEdit: null, // éditeur de type de ticket ouvert : { index, data }
    ticketTypes: null, // copie locale de la liste des types
    pubChannel: '',
    backupJob: null, // id de la tâche de sauvegarde / restauration en cours
    backupNote: null, // dernier résultat affiché : { ok, text, details }
    pollingJob: null,
  };

  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------

  const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

  // Crée un élément. Props : class, text, on<événement>, attributs, valeur, cochée, désactivée.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'checked') el.checked = Boolean(value);
      else if (key === 'disabled') el.disabled = Boolean(value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const gp = (path) => `/api/guilds/${S.gid}${path}`;

  function toast(message, ok = true) {
    toastEl.textContent = message;
    toastEl.className = `toast ${ok ? 'ok' : 'err'}`;
    toastEl.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4000);
  }

  // Appel JSON. Un corps Blob (fichier) est envoyé tel quel.
  async function api(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') init.headers['X-Edge-Dashboard'] = '1';
    if (body instanceof Blob) {
      init.body = body;
      init.headers['Content-Type'] = body.type || 'application/octet-stream';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, init);
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
    if (res.status === 401 && path !== '/api/login') {
      showLogin('Session expirée : reconnecte-toi.');
      throw new Error('Session expirée.');
    }
    if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
    return data;
  }

  function busy(button, on) {
    if (button) button.disabled = on;
  }

  function rerender() {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  function channelsOf(kinds) {
    return (S.data.meta.channels || []).filter((c) => kinds.includes(c.type));
  }

  function channelLabel(c) {
    if (c.type === CH.CATEGORY) return `📁 ${c.name}`;
    return `#${c.name}${c.parent ? ` · ${c.parent}` : ''}`;
  }

  function roleById(id) {
    return (S.data.meta.roles || []).find((r) => r.id === id) ?? null;
  }

  function roleItems() {
    return (S.data.meta.roles || []).map((r) => ({ id: r.id, label: r.name, color: r.color }));
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function formatVoice(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(total / 3600)} h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')} min`;
  }

  function pageHead(title, subtitle) {
    return h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', { text: title }), subtitle ? h('p', { class: 'muted', text: subtitle }) : null),
    );
  }

  // -------------------------------------------------------------------------
  // Contrôles de formulaire
  // -------------------------------------------------------------------------

  function wrapField(label, control, hint) {
    return h(
      'div',
      { class: 'field' },
      label ? h('span', { class: 'label', text: label }) : null,
      control,
      hint ? h('div', { class: 'hint', text: hint }) : null,
    );
  }

  function fieldSwitch(label, hint, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
    return h(
      'label',
      { class: 'switch' },
      h('span', null, h('strong', { text: label }), hint ? h('div', { class: 'hint', text: hint }) : null),
      input,
    );
  }

  function fieldSelect(label, value, options, onChange, hint) {
    const select = h(
      'select',
      { onchange: (e) => onChange(e.target.value) },
      options.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === value })),
    );
    return wrapField(label, select, hint);
  }

  function fieldChannel(label, value, kinds, onChange, hint, none = '— Aucun —') {
    const options = [{ value: '', label: none }, ...channelsOf(kinds).map((c) => ({ value: c.id, label: channelLabel(c) }))];
    if (value && !options.some((o) => o.value === value)) {
      options.push({ value, label: `Salon introuvable (${value})` });
    }
    return fieldSelect(label, value ?? '', options, (v) => onChange(v || null), hint);
  }

  function fieldText(label, value, { max, multiline = false, hint, placeholder, required = false, onInput } = {}) {
    const counter = h('div', { class: 'counter' });
    const update = (v) => {
      counter.textContent = max ? `${[...v].length} / ${max}` : '';
    };
    const attrs = {
      placeholder,
      maxlength: max,
      required,
      oninput: (e) => {
        onInput?.(e.target.value);
        update(e.target.value);
      },
    };
    const input = multiline ? h('textarea', { rows: 3, ...attrs }) : h('input', { type: 'text', ...attrs });
    input.value = value ?? '';
    update(input.value);
    return wrapField(label, [input, counter], hint);
  }

  // Liste de cases à cocher (rôles, salons). Renvoie le nouvel ensemble à chaque changement.
  function fieldChecks(label, items, selected, onChange, hint, emptyText = 'Aucun élément disponible sur ce serveur.') {
    const set = new Set(selected ?? []);
    const list = items.length
      ? h(
          'div',
          { class: 'checks' },
          items.map((item) => {
            const dot = h('span', { class: 'dot' });
            if (item.color) dot.style.background = item.color;
            return h(
              'label',
              null,
              h('input', {
                type: 'checkbox',
                checked: set.has(item.id),
                onchange: (e) => {
                  if (e.target.checked) set.add(item.id);
                  else set.delete(item.id);
                  onChange([...set]);
                },
              }),
              dot,
              h('span', { text: item.label }),
            );
          }),
        )
      : h('div', { class: 'hint', text: emptyText });
    return wrapField(label, list, hint);
  }

  function button(label, onClick, { cls = '', title } = {}) {
    return h(
      'button',
      {
        type: 'button',
        class: `btn ${cls}`.trim(),
        title,
        onclick: async (e) => {
          const b = e.currentTarget;
          busy(b, true);
          try {
            await onClick();
          } catch (err) {
            toast(err.message, false);
          } finally {
            busy(b, false);
          }
        },
      },
      label,
    );
  }

  const saveButton = (onClick, label = 'Enregistrer') => h('div', { class: 'actions' }, button(label, onClick, { cls: 'primary' }));

  // Enregistre un module (réglages partiels) et met à jour la copie locale.
  async function saveModule(id, payload, message = 'Enregistré.') {
    const res = await api('PUT', gp(`/modules/${id}`), payload);
    S.data.modules[id] = res.config;
    toast(message);
    rerender();
  }

  // -------------------------------------------------------------------------
  // Connexion et démarrage
  // -------------------------------------------------------------------------

  function showLogin(message = '') {
    S.data = null;
    const error = h('p', { class: 'error', text: message });
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const submit = form.querySelector('button');
          const password = form.elements.password.value;
          busy(submit, true);
          error.textContent = '';
          try {
            await api('POST', '/api/login', { password });
            form.elements.password.value = '';
            await boot();
          } catch (err) {
            error.textContent = err.message;
            busy(submit, false);
          }
        },
      },
      h('label', { class: 'label', for: 'pw', text: 'Mot de passe' }),
      h('input', { id: 'pw', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
      h('button', { type: 'submit', class: 'btn primary', text: 'Se connecter' }),
      error,
    );
    app.replaceChildren(
      h(
        'main',
        { class: 'login' },
        h(
          'div',
          { class: 'login-card' },
          h('h1', { text: 'Edge · Tableau de bord' }),
          h('p', { class: 'muted', text: 'Accès réservé au propriétaire du bot.' }),
          form,
        ),
      ),
    );
    document.getElementById('pw')?.focus();
  }

  function showMessage(title, text, retry = false) {
    app.replaceChildren(
      h(
        'main',
        { class: 'login' },
        h(
          'div',
          { class: 'login-card' },
          h('h1', { text: title }),
          h('p', { class: 'muted', text }),
          retry ? button('Réessayer', boot, { cls: 'primary' }) : null,
        ),
      ),
    );
  }

  // Brouillon d'embed complet (toutes les clés présentes, fields toujours un tableau).
  function normalizeDraft(d) {
    return { title: '', url: '', description: '', authorName: '', authorIcon: '', footerText: '', image: '', thumbnail: '', ...(d ?? {}), fields: clone(d?.fields ?? []) };
  }

  async function loadGuild() {
    S.data = await api('GET', gp('/state'));
    S.embedDraft = normalizeDraft(S.data.modules.embed.draft);
    S.ticketEdit = null;
    S.ticketTypes = null;
  }

  async function boot() {
    let session;
    try {
      session = await api('GET', '/api/session');
    } catch (err) {
      return showMessage('Erreur', err.message, true);
    }
    if (!session.authenticated) return showLogin();

    S.bot = await api('GET', '/api/bot');
    if (!S.bot.ready) {
      // Le bot n'est pas connecté à Discord (limite de débit, redémarrage…) : on réessaie sans bruit.
      showMessage('Bot hors ligne', 'Le bot n’est pas encore connecté à Discord. Cette page se mettra à jour toute seule.');
      clearTimeout(boot.timer);
      boot.timer = setTimeout(() => boot().catch(() => {}), 10_000);
      return;
    }
    if (!S.bot.guilds.length) return showMessage('Aucun serveur', 'Le bot n’est présent sur aucun serveur.');

    const saved = localStorage.getItem(LAST_GUILD_KEY);
    S.gid = S.bot.guilds.some((g) => g.id === saved) ? saved : S.bot.guilds[0].id;
    await loadGuild();
    render();
  }

  async function logout() {
    await api('POST', '/api/logout').catch(() => {});
    showLogin('Déconnecté.');
  }

  // -------------------------------------------------------------------------
  // Structure de la page
  // -------------------------------------------------------------------------

  const PAGES = [
    { id: 'accueil', label: 'Accueil', icon: '🏠', desc: 'Vue d’ensemble du bot et des modules.' },
    { id: 'bienvenue', label: 'Bienvenue', icon: '👋', module: 'welcome', desc: 'Carte de bienvenue à chaque arrivée.' },
    { id: 'niveaux', label: 'Niveaux', icon: '🏅', module: 'levels', desc: 'Carte /level, classement et annonces.' },
    { id: 'suggestions', label: 'Suggestions', icon: '💡', module: 'suggestions', desc: 'Commande /suggestion et votes de 3 jours.' },
    { id: 'giveaways', label: 'Giveaways', icon: '🎁', module: 'giveaways', desc: 'Commande /giveaway et tirages au sort.' },
    { id: 'liens', label: 'Liens', icon: '🔗', module: 'links', desc: 'Blocage des liens et salons libres.' },
    { id: 'tickets', label: 'Tickets', icon: '🎫', module: 'ticket', desc: 'Panneau, types, images et textes.' },
    { id: 'logs', label: 'Logs', icon: '📜', module: 'logs', desc: 'Journal détaillé des événements du serveur.' },
    { id: 'moderation', label: 'Modération', icon: '🛡️', module: 'moderation', desc: 'Commandes de sanction et rôles autorisés.' },
    { id: 'securite', label: 'Sécurité', icon: '🛡️', status: (m) => m.security.raid.enabled || m.security.nuke.enabled, desc: 'Anti-raid, anti-nuke, verrouillage et liste blanche.' },
    { id: 'roles-reaction', label: 'Rôles réaction', icon: '🎭', status: (m) => (m.reaction_roles.panels || []).length > 0, desc: 'Panneaux : réagir à un message donne un rôle.' },
    { id: 'sauvegardes', label: 'Sauvegardes', icon: '💾', module: 'backups', desc: 'Sauvegarde quotidienne, création et restauration.' },
    { id: 'ia', label: 'IA (Mistral)', icon: '🤖', module: 'ai', desc: 'Réponses du bot : prompt, abréviations, graphe de nœuds.' },
    { id: 'embed', label: 'Créateur d’embed', icon: '🧩', desc: 'Construire un embed, modèles, envoi.' },
  ];

  function currentPageId() {
    const id = location.hash.replace(/^#\/?/, '');
    return PAGES.some((p) => p.id === id) ? id : 'accueil';
  }

  function render() {
    if (!S.data) return;
    const id = currentPageId();
    const page = PAGES.find((p) => p.id === id);
    const views = {
      accueil: viewHome,
      bienvenue: viewWelcome,
      niveaux: viewLevels,
      suggestions: viewSuggestions,
      giveaways: viewGiveaways,
      liens: viewLinks,
      tickets: viewTickets,
      embed: viewEmbed,
      logs: viewLogs,
      moderation: viewModeration,
      securite: viewSecurity,
      'roles-reaction': viewReactionRoles,
      sauvegardes: viewBackups,
      ia: viewAi,
    };

    const select = h(
      'select',
      {
        'aria-label': 'Serveur',
        onchange: async (e) => {
          S.gid = e.target.value;
          localStorage.setItem(LAST_GUILD_KEY, S.gid);
          await loadGuild();
          rerender();
        },
      },
      S.bot.guilds.map((g) => h('option', { value: g.id, text: g.name, selected: g.id === S.gid })),
    );

    const nav = PAGES.map((p) =>
      h(
        'a',
        { href: `#/${p.id}`, class: p.id === id ? 'active' : null, 'aria-current': p.id === id ? 'page' : null },
        h('span', { text: p.icon }),
        h('span', { text: p.label }),
      ),
    );

    app.replaceChildren(
      h(
        'div',
        { class: 'layout' },
        h(
          'aside',
          { class: 'side' },
          h('div', { class: 'brand', text: 'Edge · Tableau de bord' }),
          select,
          h('nav', null, nav),
          h('div', { class: 'foot' }, h('button', { type: 'button', class: 'btn small', onclick: logout, text: 'Se déconnecter' })),
        ),
        h('main', { class: 'content', id: 'page' }, views[page.id]()),
      ),
    );
  }

  window.addEventListener('hashchange', () => {
    if (S.data) render();
  });

  // -------------------------------------------------------------------------
  // Accueil
  // -------------------------------------------------------------------------

  function viewHome() {
    const m = S.data.modules;
    const tiles = PAGES.filter((p) => p.id !== 'accueil').map((p) => {
      const on = p.module ? Boolean(m[p.module].enabled) : p.status ? Boolean(p.status(m)) : null;
      return h(
        'a',
        { class: 'tile', href: `#/${p.id}` },
        h(
          'div',
          { class: 'page-head' },
          h('h3', { text: `${p.icon} ${p.label}` }),
          on === null ? null : h('span', { class: on ? 'pill on' : 'pill', text: on ? 'Activé' : 'Désactivé' }),
        ),
        h('p', { class: 'hint', text: p.desc }),
      );
    });
    return h(
      'section',
      null,
      pageHead(`Serveur : ${S.data.guild.name}`, `Bot connecté en tant que ${S.bot.tag}.`),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Commandes disponibles' }),
        h('p', { class: 'muted', text: '/config (réglages, dans Discord) · /level · /leaderboard · /suggestion · /giveaway · /ban · /unban · /kick · /timeout · /untimeout · /warn · /warnings · /unwarn · /purge · /slowmode' }),
        h('p', { class: 'small muted', text: 'Ce tableau de bord modifie les mêmes réglages que /config. Les changements sont appliqués tout de suite.' }),
      ),
      h('div', { class: 'grid' }, tiles),
    );
  }

  // -------------------------------------------------------------------------
  // Bienvenue
  // -------------------------------------------------------------------------

  function themeOptions(list) {
    return list.map((t) => ({ value: t.id, label: `${t.emoji} ${t.label}` }));
  }

  function viewWelcome() {
    const cfg = clone(S.data.modules.welcome);
    const preview = h('img', { alt: 'Aperçu de la carte de bienvenue', width: 1000, height: 400 });
    const refreshPreview = () => {
      const params = new URLSearchParams({
        theme: cfg.theme,
        title: cfg.texts.title,
        subtitle: cfg.texts.subtitle,
        avatar: cfg.showAvatar ? '1' : '0',
        t: String(Date.now()),
      });
      preview.src = `${gp('/preview/welcome')}?${params}`;
    };

    const settings = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Réglages' }),
      fieldSwitch('Module activé', 'Envoie la carte à chaque nouvel arrivant.', cfg.enabled, (v) => (cfg.enabled = v)),
      fieldChannel('Salon', cfg.channelId, TEXT_KINDS, (v) => (cfg.channelId = v)),
      fieldSwitch('Afficher l’avatar', 'Sinon, une lettre est affichée à la place.', cfg.showAvatar, (v) => (cfg.showAvatar = v)),
      fieldSelect('Thème', cfg.theme, themeOptions(S.data.themes.cards), (v) => {
        cfg.theme = v;
        refreshPreview();
      }),
      fieldText('Titre de l’image', cfg.texts.title, { max: 80, hint: 'Variable : {user}', onInput: (v) => (cfg.texts.title = v) }),
      fieldText('Sous-titre de l’image', cfg.texts.subtitle, {
        max: 100,
        hint: 'Variables : {count}, {server}',
        onInput: (v) => (cfg.texts.subtitle = v),
      }),
      fieldText('Message au-dessus de l’image', cfg.texts.message, {
        max: 500,
        multiline: true,
        hint: 'Variables : {user} (mention), {server}, {count}. Envoyé en texte, pas en embed.',
        onInput: (v) => (cfg.texts.message = v),
      }),
      saveButton(() =>
        saveModule('welcome', {
          enabled: cfg.enabled,
          channelId: cfg.channelId,
          showAvatar: cfg.showAvatar,
          theme: cfg.theme,
          texts: cfg.texts,
        }),
      ),
    );

    const side = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Aperçu' }),
      h('p', { class: 'hint', text: 'Données d’exemple (Alice, membre n°42).' }),
      preview,
      h('div', { class: 'actions' }, button('Actualiser l’aperçu', async () => refreshPreview(), { cls: 'primary' })),
    );

    setTimeout(refreshPreview, 0);
    return h('section', null, pageHead('👋 Bienvenue', 'Carte PNG envoyée à chaque arrivée.'), h('div', { class: 'two' }, settings, side));
  }

  // -------------------------------------------------------------------------
  // Niveaux
  // -------------------------------------------------------------------------

  function viewLevels() {
    const cfg = clone(S.data.modules.levels);
    const previewImg = h('img', { alt: 'Aperçu', class: '', width: 1000 });
    const showPreview = (name) => {
      previewImg.src = `${gp(`/preview/${name}`)}?${new URLSearchParams({ theme: cfg.theme, t: String(Date.now()) })}`;
    };
    const tableBox = h('div', { class: 'table-wrap' }, h('p', { class: 'muted', text: 'Chargement du classement…' }));

    loadLevelsTable(tableBox);

    const settings = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Réglages' }),
      fieldSwitch('Annonces de passage de niveau', 'Message texte dans le salon choisi.', cfg.enabled, (v) => (cfg.enabled = v)),
      fieldChannel('Salon des annonces', cfg.channelId, TEXT_KINDS, (v) => (cfg.channelId = v)),
      fieldSelect('Thème des cartes /level et /leaderboard', cfg.theme, themeOptions(S.data.themes.cards), (v) => (cfg.theme = v)),
      fieldText('Message d’annonce', cfg.texts.levelUp, {
        max: 300,
        required: true,
        hint: 'Variables : {user} (mention), {level}. Exemple : Bravo à {user} qui passe {level}',
        onInput: (v) => (cfg.texts.levelUp = v),
      }),
      saveButton(() => saveModule('levels', { enabled: cfg.enabled, channelId: cfg.channelId, theme: cfg.theme, texts: cfg.texts })),
    );

    const preview = h(
      'div',
      { class: 'card card-preview' },
      h('h2', { text: 'Aperçus' }),
      h('div', { class: 'actions' }, button('Carte /level', async () => showPreview('level')), button('Classement /leaderboard', async () => showPreview('leaderboard'))),
      previewImg,
    );

    const table = h(
      'div',
      { class: 'card' },
      h('div', { class: 'page-head' }, h('h2', { text: 'Classement (top 50)' }), button('Actualiser', async () => loadLevelsTable(tableBox))),
      h('p', { class: 'hint', text: 'L’XP n’est visible que dans ce tableau de bord, jamais affichée aux membres.' }),
      tableBox,
    );

    return h('section', null, pageHead('🏅 Niveaux', 'XP vocal (20 XP toutes les 30 s) et XP texte (5 XP par message).'), h('div', { class: 'two' }, settings, preview), table);
  }

  async function loadLevelsTable(box) {
    try {
      const { rows, total } = await api('GET', gp('/levels'));
      if (!rows.length) {
        box.replaceChildren(h('p', { class: 'muted', text: 'Aucune activité enregistrée pour le moment.' }));
        return;
      }
      box.replaceChildren(
        h(
          'table',
          null,
          h('thead', null, h('tr', null, ...['#', 'Membre', 'Niveau', 'Vocal', 'XP'].map((t) => h('th', { text: t })))),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                null,
                h('td', { text: r.rank }),
                h('td', { text: r.name }),
                h('td', { text: r.level }),
                h('td', { text: formatVoice(r.voiceSeconds) }),
                h('td', { text: r.xp }),
              ),
            ),
          ),
        ),
        h('p', { class: 'hint', text: `${total} membre(s) avec de l’XP sur ce serveur.` }),
      );
    } catch (err) {
      box.replaceChildren(h('p', { class: 'error', text: err.message }));
    }
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  function viewSuggestions() {
    const cfg = clone(S.data.modules.suggestions);
    const box = h('div', { class: 'table-wrap' }, h('p', { class: 'muted', text: 'Chargement…' }));
    const load = async () => {
      try {
        const { rows } = await api('GET', gp('/suggestions'));
        if (!rows.length) {
          box.replaceChildren(h('p', { class: 'muted', text: 'Aucune suggestion pour le moment.' }));
          return;
        }
        box.replaceChildren(
          h(
            'table',
            null,
            h('thead', null, h('tr', null, ...['Suggestion', 'Pour', 'Contre', 'État', 'Publiée le'].map((t) => h('th', { text: t })))),
            h(
              'tbody',
              null,
              rows.map((s) =>
                h(
                  'tr',
                  null,
                  h('td', { text: s.content.length > 160 ? `${s.content.slice(0, 160)}…` : s.content }),
                  h('td', { text: s.up }),
                  h('td', { text: s.down }),
                  h('td', null, h('span', { class: s.closed ? 'pill' : 'pill on', text: s.closed ? 'Vote terminé' : `Ouvert jusqu’au ${fmtDate(s.endsAt)}` })),
                  h('td', { text: fmtDate(s.createdAt) }),
                ),
              ),
            ),
          ),
        );
      } catch (err) {
        box.replaceChildren(h('p', { class: 'error', text: err.message }));
      }
    };
    load();

    const settings = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Réglages' }),
      fieldSwitch('Commande /suggestion activée', 'Les membres peuvent proposer une idée ; elle est publiée avec deux boutons de vote.', cfg.enabled, (v) => (cfg.enabled = v)),
      fieldChannel('Salon de publication', cfg.channelId, TEXT_KINDS, (v) => (cfg.channelId = v)),
      saveButton(() => saveModule('suggestions', { enabled: cfg.enabled, channelId: cfg.channelId })),
    );
    const list = h('div', { class: 'card' }, h('div', { class: 'page-head' }, h('h2', { text: 'Suggestions récentes' }), button('Actualiser', load)), box);
    return h('section', null, pageHead('💡 Suggestions', 'Chaque suggestion reste ouverte 3 jours aux votes.'), settings, list);
  }

  // -------------------------------------------------------------------------
  // Giveaways
  // -------------------------------------------------------------------------

  function viewGiveaways() {
    const cfg = clone(S.data.modules.giveaways);
    const box = h('div', { class: 'table-wrap' }, h('p', { class: 'muted', text: 'Chargement…' }));
    const load = async () => {
      try {
        const { rows } = await api('GET', gp('/giveaways'));
        if (!rows.length) {
          box.replaceChildren(h('p', { class: 'muted', text: 'Aucun giveaway pour le moment.' }));
          return;
        }
        box.replaceChildren(
          h(
            'table',
            null,
            h('thead', null, h('tr', null, ...['Lot', 'Gagnants', 'Participants', 'Fin', 'Action'].map((t) => h('th', { text: t })))),
            h(
              'tbody',
              null,
              rows.map((g) =>
                h(
                  'tr',
                  null,
                  h('td', { text: g.prize }),
                  h('td', { text: g.ended ? `${g.winnerIds.length} tiré(s)` : g.winners }),
                  h('td', { text: g.participants }),
                  h('td', null, h('span', { class: g.ended ? 'pill' : 'pill on', text: g.ended ? 'Terminé' : fmtDate(g.endsAt) })),
                  h(
                    'td',
                    null,
                    g.ended
                      ? null
                      : button(
                          'Terminer maintenant',
                          async () => {
                            if (!confirm(`Terminer le giveaway « ${g.prize} » maintenant et tirer les gagnants ?`)) return;
                            await api('POST', gp(`/giveaways/${encodeURIComponent(g.id)}/end`));
                            toast('Giveaway terminé, gagnants tirés.');
                            await load();
                          },
                          { cls: 'danger small' },
                        ),
                  ),
                ),
              ),
            ),
          ),
        );
      } catch (err) {
        box.replaceChildren(h('p', { class: 'error', text: err.message }));
      }
    };
    load();

    const settings = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Réglages' }),
      fieldSwitch('Commande /giveaway activée', null, cfg.enabled, (v) => (cfg.enabled = v)),
      fieldChannel('Salon par défaut', cfg.channelId, TEXT_KINDS, (v) => (cfg.channelId = v), 'Utilisé si la commande ne précise pas de salon.', '— Salon courant —'),
      fieldChecks(
        'Rôles autorisés à créer un giveaway',
        roleItems(),
        cfg.creatorRoleIds,
        (v) => (cfg.creatorRoleIds = v),
        'Les membres qui ont « Gérer le serveur » peuvent toujours créer un giveaway.',
      ),
      saveButton(() => saveModule('giveaways', { enabled: cfg.enabled, channelId: cfg.channelId, creatorRoleIds: cfg.creatorRoleIds })),
    );
    const list = h(
      'div',
      { class: 'card' },
      h('div', { class: 'page-head' }, h('h2', { text: 'Giveaways' }), button('Actualiser', load)),
      h('p', { class: 'hint', text: 'Pour créer un giveaway, utilise /giveaway dans Discord.' }),
      box,
    );
    return h('section', null, pageHead('🎁 Giveaways', 'Tirage au sort automatique à la fin de la durée.'), settings, list);
  }

  // -------------------------------------------------------------------------
  // Liens
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // IA (Mistral) : prompt système, abréviations, graphe de nœuds (style Unreal)
  // -------------------------------------------------------------------------

  const AI_MODELS = [
    { value: 'ministral-14b-2512', label: 'Ministral 14B (recommandé)' },
    { value: 'ministral-8b-2512', label: 'Ministral 8B (plus léger, moins cher)' },
  ];
  const AI_TEMPS = [
    { value: '0.2', label: 'Précis (0,2)' },
    { value: '0.5', label: 'Équilibré (0,5)' },
    { value: '0.8', label: 'Créatif (0,8)' },
  ];
  const AI_MAX_ABBR = 100;
  const GRAPH_COLORS = { event: '#b9832b', logic: '#2f7fb8', action: '#9b59b6' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Brouillon gardé dans S : les modifications non enregistrées survivent aux repeints.
  function aiDraft() {
    if (!S.aiDraft || S.aiDraft.gid !== S.gid) {
      const cfg = clone(S.data.modules.ai) ?? {};
      cfg.abbreviations = cfg.abbreviations ?? [];
      cfg.channelIds = cfg.channelIds ?? [];
      cfg.graph = cfg.graph ?? { n: [], w: [] };
      S.aiDraft = { gid: S.gid, cfg };
      S.aiView = null;
    }
    return S.aiDraft.cfg;
  }

  // État de la vue (zoom, position, sélection) : jamais enregistré.
  function aiView() {
    if (!S.aiView) {
      S.aiView = {
        panX: 60,
        panY: 50,
        zoom: 1,
        sel: new Set(), // identifiants des nœuds sélectionnés
        hist: { past: [], future: [], lastKey: null, lastAt: 0 }, // Annuler / Rétablir (en mémoire, par page)
        space: false, // Espace maintenu : glisser = déplacer la vue
        overCanvas: false,
        lastWorld: null,
        menu: false,
        status: '',
        drag: null,
        panMoved: false,
      };
    }
    return S.aiView;
  }

  // Sauvegarde automatique : chaque modification part peu après la dernière action.
  // Un seul envoi à la fois par serveur ; le brouillon complet est envoyé à chaque fois.
  const AI_AUTOSAVE_MS = 1200;
  const aiSave = { pending: new Map(), sends: new Map(), timer: null, failed: false, message: '', at: null };

  const aiPayload = (cfg) => ({
    enabled: cfg.enabled,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    temperature: cfg.temperature,
    maxReplyTokens: cfg.maxReplyTokens,
    channelIds: cfg.channelIds,
    cooldownSeconds: cfg.cooldownSeconds,
    memoryEnabled: cfg.memoryEnabled,
    memoryMaxNotes: cfg.memoryMaxNotes,
    // Une abréviation à moitié saisie n'est pas envoyée : elle reste affichée et sera enregistrée une fois complète.
    abbreviations: (cfg.abbreviations ?? []).filter((a) => String(a.short ?? '').trim() && String(a.meaning ?? '').trim()),
    graph: cfg.graph,
  });

  function aiState() {
    if (aiSave.sends.size) return 'saving';
    if (aiSave.pending.size) return 'dirty';
    return aiSave.failed ? 'error' : 'saved';
  }

  function aiStatusText() {
    switch (aiState()) {
      case 'saving':
        return 'Enregistrement…';
      case 'dirty':
        return 'Modifications en attente d’enregistrement…';
      case 'error':
        return `⚠ Non enregistré (${aiSave.message}). Tes modifications restent affichées : elles seront renvoyées à la prochaine modification.`;
      default:
        return aiSave.at
          ? `✓ Enregistré à ${aiSave.at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
          : '✓ Tout est enregistré';
    }
  }

  function paintAiSave() {
    for (const el of document.querySelectorAll('.ai-save')) {
      el.textContent = aiStatusText();
      el.dataset.state = aiState();
    }
  }

  // Appelée après chaque modification : le brouillon part dans AI_AUTOSAVE_MS.
  function markAiDirty() {
    aiSave.pending.set(S.gid, { gid: S.gid, cfg: aiDraft() });
    clearTimeout(aiSave.timer);
    aiSave.timer = setTimeout(() => flushAi(), AI_AUTOSAVE_MS);
    paintAiSave();
  }

  // Envoie les brouillons en attente. Renvoie une promesse qui se résout quand les envois en cours sont finis.
  function flushAi() {
    clearTimeout(aiSave.timer);
    aiSave.timer = null;
    for (const [gid, target] of [...aiSave.pending]) {
      if (aiSave.sends.has(gid)) continue; // l'envoi en cours relancera celui-ci à la fin
      aiSave.pending.delete(gid);
      aiSave.sends.set(gid, sendAi(target));
    }
    paintAiSave();
    return Promise.all([...aiSave.sends.values()]);
  }

  async function sendAi(target) {
    paintAiSave();
    try {
      const res = await api('PUT', `/api/guilds/${target.gid}/modules/ai`, aiPayload(target.cfg));
      if (S.gid === target.gid && S.data) S.data.modules.ai = res.config;
      aiSave.at = new Date();
      aiSave.failed = false;
      aiSave.message = '';
    } catch (err) {
      aiSave.failed = true;
      aiSave.message = err.message;
    } finally {
      aiSave.sends.delete(target.gid);
      // Une modification faite pendant l'envoi part maintenant. Pas de boucle : après un échec, seul un nouveau changement relance.
      flushAi();
    }
  }

  // Filet de sécurité : fermer l'onglet ou changer d'appli envoie ce qui reste, et prévient avant de quitter.
  function aiKeepAlive() {
    for (const target of aiSave.pending.values()) {
      fetch(`/api/guilds/${target.gid}/modules/ai`, {
        method: 'PUT',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Edge-Dashboard': '1' },
        body: JSON.stringify(aiPayload(target.cfg)),
      }).catch(() => {});
    }
  }
  window.addEventListener('pagehide', aiKeepAlive);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') aiKeepAlive();
  });
  window.addEventListener('beforeunload', (e) => {
    if (aiSave.pending.size || aiSave.sends.size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Plein écran de l'éditeur : API plein écran du navigateur, avec repli en plein cadre si elle est refusée.
  function applyFsState() {
    const on = Boolean(aiView().fs);
    if (!graphRefs) return;
    graphRefs.wrap.classList.toggle('graph-fs', on);
    graphRefs.fsButton.textContent = on ? '✕ Quitter le plein écran' : '⛶ Plein écran';
  }

  function setGraphFullscreen(on) {
    aiView().fs = on;
    applyFsState();
    if (on) {
      const request = graphRefs?.wrap.requestFullscreen?.();
      request?.catch?.(() => {}); // refusé : le plein cadre CSS reste affiché
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && S.aiView?.fs) setGraphFullscreen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.aiView?.fs && !S.aiView?.menu) setGraphFullscreen(false);
  });

  // « abréviation = signification » ou « abréviation : signification », une par ligne.
  function parseAbbreviationLines(raw) {
    return String(raw ?? '')
      .split('\n')
      .map((line) => {
        const m = line.match(/^([^=:]+)[=:](.+)$/);
        return m ? { short: m[1].trim(), meaning: m[2].trim() } : null;
      })
      .filter((x) => x && x.short && x.meaning);
  }

  // Élément DOM simple : attributs, texte, enfants.
  function ge(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c);
    return el;
  }

  function svgEl(name, attrs = {}) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  // Éléments de l'éditeur courant (recréés à chaque affichage de la page).
  let graphRefs = null;
  // Fragment copié (Ctrl+C) : gardé pendant toute la session de la page.
  let graphClip = null;

  const graphNow = () => aiDraft().graph;
  const HIST_LIMIT = 200;
  const HIST_COALESCE_MS = 1200;
  const roleNameOf = (id) => roleById(id)?.name ?? id;

  // ---- Historique : Annuler / Rétablir --------------------------------------
  // Un instantané (copie) de l'état d'avant la modification est gardé. Les frappes dans un même champ
  // (clé « key ») et les déplacements forment un seul pas tant qu'ils se suivent à moins de 1,2 s.
  function pushHistory(snapshot, key = null) {
    const hist = aiView().hist;
    const now = Date.now();
    if (key && hist.lastKey === key && now - hist.lastAt < HIST_COALESCE_MS) {
      hist.lastAt = now;
      return;
    }
    hist.past.push(snapshot);
    if (hist.past.length > HIST_LIMIT) hist.past.shift();
    hist.future = [];
    hist.lastKey = key;
    hist.lastAt = now;
  }

  // Retire de la sélection les nœuds qui n'existent plus (après suppression, annulation…).
  function pruneSelection() {
    const view = aiView();
    const ids = new Set(graphNow().n.map((n) => n.i));
    view.sel = new Set([...view.sel].filter((id) => ids.has(id)));
  }

  // Modification du graphe par une fonction pure : annulable, sauvegardée, repeinte.
  // En cas de refus (boucle, limite, pin invalide…), le graphe ne change pas et le message s'affiche.
  function commit(change, { ok = '', key = null } = {}) {
    const view = aiView();
    const before = clone(graphNow());
    let next;
    try {
      next = change(graphNow());
    } catch (err) {
      view.status = err.message;
      repaintGraph();
      return false;
    }
    pushHistory(before, key);
    aiDraft().graph = next;
    view.status = ok;
    pruneSelection();
    markAiDirty();
    repaintGraph();
    return true;
  }

  // Modification in place (champ de l'inspecteur, déplacement) : l'instantané est pris avant.
  function editNodeData(n, key, mutate) {
    pushHistory(clone(graphNow()), key);
    mutate();
    refreshSummary(n);
    markAiDirty();
  }

  function travel(from, to) {
    const view = aiView();
    const stack = view.hist[from];
    if (!stack.length) {
      view.status = from === 'past' ? 'Rien à annuler.' : 'Rien à rétablir.';
      repaintGraph();
      return;
    }
    view.hist[to].push(clone(graphNow()));
    aiDraft().graph = stack.pop();
    view.hist.lastKey = null;
    view.hist.lastAt = 0;
    view.status = from === 'past' ? 'Annulé.' : 'Rétabli.';
    pruneSelection();
    markAiDirty();
    repaintGraph();
  }
  const undo = () => travel('past', 'future');
  const redo = () => travel('future', 'past');

  // ---- Sélection, presse-papiers ---------------------------------------------
  const selectedNodes = () => graphNow().n.filter((n) => aiView().sel.has(n.i));

  function selectedFragment() {
    const nodes = selectedNodes().map((n) => clone(n));
    const keep = new Set(nodes.map((n) => n.i));
    const wires = graphNow()
      .w.filter(([a, , b]) => keep.has(a) && keep.has(b))
      .map((w) => [...w]);
    return { n: nodes, w: wires };
  }

  function copySelection() {
    const view = aiView();
    if (!view.sel.size) {
      view.status = 'Sélectionne des nœuds à copier.';
      repaintGraph();
      return false;
    }
    graphClip = selectedFragment();
    view.status = `${graphClip.n.length} nœud(s) copié(s).`;
    repaintGraph();
    return true;
  }

  // Colle un fragment : les nouveaux nœuds (et leurs fils internes) deviennent la sélection.
  function pasteFragment(fragment, offset, ok) {
    const view = aiView();
    let ids = [];
    const done = commit(
      (g) => {
        const r = EdgeAiGraph.pasteFragment(g, fragment, offset);
        ids = r.ids;
        return r.graph;
      },
      { ok },
    );
    if (done && ids.length) {
      view.sel = new Set(ids);
      repaintGraph();
    }
  }

  function pasteClip() {
    const view = aiView();
    if (!graphClip?.n.length) {
      view.status = 'Rien à coller : copie d’abord (Ctrl+C).';
      repaintGraph();
      return;
    }
    const minX = Math.min(...graphClip.n.map((n) => n.x));
    const minY = Math.min(...graphClip.n.map((n) => n.y));
    // Collé à l'endroit de la souris si elle est sur le canevas, sinon décalé de 40 px.
    const at = view.overCanvas && view.lastWorld ? view.lastWorld : { x: minX + 40, y: minY + 40 };
    pasteFragment(graphClip, { x: Math.round(at.x - minX), y: Math.round(at.y - minY) }, 'Collé.');
  }

  function duplicateSelection() {
    const view = aiView();
    if (!view.sel.size) {
      view.status = 'Sélectionne des nœuds à dupliquer.';
      repaintGraph();
      return;
    }
    pasteFragment(selectedFragment(), { x: 40, y: 40 }, 'Dupliqué.');
  }

  function deleteSelection() {
    const view = aiView();
    const ids = [...view.sel];
    if (!ids.length) return;
    view.sel = new Set();
    commit((g) => EdgeAiGraph.removeNodes(g, ids), { ok: ids.length > 1 ? `${ids.length} nœuds supprimés.` : 'Nœud supprimé.' });
  }

  // Cadre les nœuds (ou tout le graphe) dans la zone visible.
  function frameNodes(list) {
    const view = aiView();
    const r = graphRefs.viewport.getBoundingClientRect();
    if (!list.length) {
      view.panX = 60;
      view.panY = 50;
      view.zoom = 1;
      applyTransform();
      return;
    }
    const minX = Math.min(...list.map((n) => n.x));
    const minY = Math.min(...list.map((n) => n.y));
    const maxX = Math.max(...list.map((n) => n.x + EdgeAiGraph.NODE_W));
    const maxY = Math.max(...list.map((n) => n.y + EdgeAiGraph.nodeHeight(n)));
    const zoom = r.width && r.height ? Math.min(r.width / (maxX - minX + 80), r.height / (maxY - minY + 80)) : 1;
    view.zoom = Math.max(0.4, Math.min(1.5, zoom));
    view.panX = r.width / 2 - ((minX + maxX) / 2) * view.zoom;
    view.panY = r.height / 2 - ((minY + maxY) / 2) * view.zoom;
    applyTransform();
  }

  // Centre un nœud dans la zone visible, sans changer le zoom.
  function centerOn(n) {
    const view = aiView();
    const r = graphRefs.viewport.getBoundingClientRect();
    view.panX = r.width / 2 - (n.x + EdgeAiGraph.NODE_W / 2) * view.zoom;
    view.panY = r.height / 2 - (n.y + EdgeAiGraph.nodeHeight(n) / 2) * view.zoom;
    applyTransform();
  }

  function worldPoint(e) {
    const view = aiView();
    const r = graphRefs.viewport.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.panX) / view.zoom, y: (e.clientY - r.top - view.panY) / view.zoom };
  }

  function centerWorld() {
    const view = aiView();
    const r = graphRefs.viewport.getBoundingClientRect();
    const n = graphNow().n.length;
    return {
      x: (r.width / 2 - view.panX) / view.zoom + (n % 5) * 24 - 60,
      y: (r.height / 2 - view.panY) / view.zoom + (n % 5) * 24 - 40,
    };
  }

  function addNodeAt(type, x, y) {
    const view = aiView();
    let id = null;
    const done = commit(
      (g) => {
        const result = EdgeAiGraph.addNode(g, type, x, y);
        id = result.id;
        return result.graph;
      },
      { ok: 'Nœud ajouté.' },
    );
    if (done && id) {
      view.sel = new Set([id]);
      repaintGraph();
    }
  }

  function wirePath(p1, p2) {
    const d = Math.max(60, Math.abs(p2.x - p1.x) / 2);
    return `M ${p1.x} ${p1.y} C ${p1.x + d} ${p1.y}, ${p2.x - d} ${p2.y}, ${p2.x} ${p2.y}`;
  }

  function applyTransform() {
    const view = aiView();
    graphRefs.world.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  }

  function paintWires() {
    const g = graphNow();
    const byId = new Map(g.n.map((n) => [n.i, n]));
    graphRefs.svg.replaceChildren();
    g.w.forEach(([a, p, b, q], index) => {
      const p1 = EdgeAiGraph.pinPosition(byId.get(a), p, 'out');
      const p2 = EdgeAiGraph.pinPosition(byId.get(b), q, 'in');
      if (!p1 || !p2) return;
      const path = svgEl('path', { class: 'wire', d: wirePath(p1, p2) });
      // Clic sur un fil : il est supprimé.
      path.addEventListener('click', (e) => {
        e.stopPropagation();
        commit((gg) => EdgeAiGraph.disconnect(gg, index), { ok: 'Fil supprimé.' });
      });
      graphRefs.svg.append(path);
    });
  }

  function refreshSummary(n) {
    const el = graphRefs.nodesLayer.querySelector(`[data-summary="${n.i}"]`);
    if (el) el.textContent = EdgeAiGraph.summaryOf(n, roleNameOf);
  }

  function nodeEl(n) {
    const def = EdgeAiGraph.CATALOG[n.t];
    const view = aiView();
    const ins = EdgeAiGraph.insOf(n);
    const outs = EdgeAiGraph.outsOf(n);
    const rows = EdgeAiGraph.nodeRows(n);
    const el = ge(
      'div',
      {
        class: 'gn' + (view.sel.has(n.i) ? ' sel' : ''),
        'data-node': n.i,
        style: `left:${n.x}px;top:${n.y}px;width:${EdgeAiGraph.NODE_W}px;height:${EdgeAiGraph.nodeHeight(n)}px`,
      },
      ge('div', { class: 'gn-head', style: `background:${GRAPH_COLORS[def.group]}`, text: def.label }),
    );
    ins.forEach((p, i) => {
      const y = EdgeAiGraph.pinOffset(i);
      el.append(
        ge('div', { class: 'gn-pin', 'data-pin': p, 'data-dir': 'in', 'data-node': n.i, style: `left:0px;top:${y}px` }),
        ge('span', { class: 'gn-plabel in', style: `left:16px;top:${y}px`, text: EdgeAiGraph.pinLabel(n, p) }),
      );
    });
    outs.forEach((p, i) => {
      const y = EdgeAiGraph.pinOffset(i);
      el.append(
        ge('div', {
          class: 'gn-pin',
          'data-pin': p,
          'data-dir': 'out',
          'data-node': n.i,
          style: `left:${EdgeAiGraph.NODE_W}px;top:${y}px`,
        }),
        ge('span', { class: 'gn-plabel out', style: `right:16px;top:${y}px`, text: EdgeAiGraph.pinLabel(n, p) }),
      );
    });
    el.append(
      ge('div', {
        class: 'gn-body',
        'data-summary': n.i,
        style: `top:${EdgeAiGraph.HEADER_H + rows * EdgeAiGraph.ROW_H + 2}px`,
        text: EdgeAiGraph.summaryOf(n, roleNameOf),
      }),
    );
    return el;
  }

  function paintStatus() {
    const g = graphNow();
    const view = aiView();
    const unwired = EdgeAiGraph.unwiredActions(g).length;
    const warn = !view.status && unwired > 0;
    const picked = view.sel.size > 1 ? ` · ${view.sel.size} nœuds sélectionnés` : '';
    graphRefs.status.className = 'hint graph-status' + (warn ? ' warn' : '');
    graphRefs.status.textContent =
      view.status ||
      (unwired
        ? `⚠ ${unwired} consigne(s) ou action(s) non reliée(s) : elles ne s’appliquent jamais.`
        : `${g.n.length} nœud(s), ${g.w.length} fil(s)${picked}. Glisse une sortie vers une entrée.`);
  }

  // Champ « rôles » (un ou plusieurs rôles, limite selon le nœud).
  function roleField(n, max, hint) {
    return fieldChecks(
      `Rôles${max === 10 ? ' (10 maximum)' : ''}`,
      roleItems(),
      n.d?.roleIds ?? [],
      (v) => {
        const view = aiView();
        if (v.length > max) {
          view.status = `${max} rôles maximum pour ce nœud.`;
          repaintGraph();
          return;
        }
        editNodeData(n, null, () => (n.d = { ...(n.d ?? {}), roleIds: v }));
        view.status = '';
        repaintGraph();
      },
      hint,
    );
  }

  function paintInspector() {
    const view = aiView();
    const ids = [...view.sel];
    const n = ids.length === 1 ? graphNow().n.find((x) => x.i === ids[0]) : null;
    const children = [ge('h3', { text: 'Détails' })];
    if (ids.length > 1) {
      children.push(
        ge('p', { class: 'graph-node-title', text: `${ids.length} nœuds sélectionnés` }),
        ge('p', { class: 'hint', text: 'Glisse l’un des nœuds sélectionnés pour déplacer le groupe.' }),
        h(
          'div',
          { class: 'actions' },
          button('Copier', async () => copySelection(), { cls: 'small' }),
          button('Dupliquer', async () => duplicateSelection(), { cls: 'small' }),
          button('Supprimer', async () => deleteSelection(), { cls: 'danger small' }),
        ),
      );
    } else if (!n) {
      children.push(ge('p', { class: 'hint', text: 'Sélectionne un nœud pour régler ses données.' }));
    } else {
      children.push(ge('p', { class: 'graph-node-title', text: EdgeAiGraph.CATALOG[n.t].label }));
      if (n.t === 'kw') {
        children.push(
          fieldText('Mots-clés (séparés par des virgules)', (n.d?.keywords ?? []).join(', '), {
            max: 1000,
            hint: 'Mot entier, sans accents ni majuscules : « bug » ne matche pas « bugs ».',
            onInput: (v) =>
              editNodeData(n, `kw:${n.i}`, () => (n.d = { ...(n.d ?? {}), keywords: v.split(',').map((s) => s.trim()).filter(Boolean) })),
          }),
        );
      }
      if (n.t === 'channel') {
        children.push(
          fieldChecks(
            'Salons',
            channelsOf(TEXT_KINDS).map((c) => ({ id: c.id, label: channelLabel(c) })),
            n.d?.channelIds ?? [],
            (v) => {
              editNodeData(n, null, () => (n.d = { ...(n.d ?? {}), channelIds: v }));
              repaintGraph();
            },
            'Le nœud est vrai pour un message posté dans l’un de ces salons.',
          ),
        );
      }
      if (n.t === 'role') children.push(roleField(n, EdgeAiGraph.LIMITS.roles, 'Vrai si le membre qui écrit a au moins un de ces rôles.'));
      if (n.t === 'mentionRole') {
        children.push(roleField(n, EdgeAiGraph.LIMITS.roles, 'Vrai si le message mentionne (ping) au moins un de ces rôles.'));
      }
      if (n.t === 'grant') {
        children.push(
          roleField(
            n,
            EdgeAiGraph.LIMITS.grantRoles,
            'Si l’entrée « si vrai » est vraie, l’IA peut donner ces rôles quand la personne le demande. ' +
              'Refusé : rôle administrateur ou géré par une intégration.',
          ),
        );
      }
      if (n.t === 'and' || n.t === 'or') {
        children.push(
          fieldSelect(
            'Nombre d’entrées',
            String(EdgeAiGraph.insOf(n).length),
            [2, 3, 4, 5, 6].map((k) => ({ value: String(k), label: `${k} entrées` })),
            (v) => commit((g) => EdgeAiGraph.setInputCount(g, n.i, Number(v)), { ok: 'Entrées mises à jour.' }),
            'Les fils branchés sur les entrées retirées sont supprimés.',
          ),
        );
      }
      if (n.t === 'add') {
        children.push(
          fieldText('Consigne ajoutée au prompt', n.d?.text ?? '', {
            max: 500,
            multiline: true,
            hint: 'Ajoutée au prompt seulement pour les messages où l’entrée « si vrai » est vraie.',
            onInput: (v) => editNodeData(n, `text:${n.i}`, () => (n.d = { ...(n.d ?? {}), text: v })),
          }),
        );
      }
      if (['not', 'mention'].includes(n.t)) {
        children.push(ge('p', { class: 'hint', text: 'Ce nœud n’a pas de réglage : seul son branchement compte.' }));
      }
      children.push(
        button(
          'Supprimer ce nœud',
          async () => deleteSelection(),
          { cls: 'danger small' },
        ),
      );
    }
    children.push(
      ge('p', {
        class: 'hint graph-help',
        text:
          'Glisse depuis une sortie (à droite) vers une entrée (à gauche). Clic droit sur le fond : ajouter un nœud. ' +
          'Glisser sur le fond : déplacer la vue. Clic sur un nœud : sélectionner (Maj + clic pour ajouter). Maj + glisser sur le fond : rectangle de sélection. ' +
          'Ctrl+Z / Ctrl+Y : annuler / rétablir. Ctrl+C, Ctrl+V, Ctrl+D : copier, coller, dupliquer. Ctrl+A : tout sélectionner. F : cadrer. Suppr : supprimer.',
      }),
    );
    graphRefs.inspector.replaceChildren(...children);
  }

  // Repeint tout le graphe (nœuds, fils, état, détails) à partir du brouillon.
  function repaintGraph() {
    if (!graphRefs) return;
    applyTransform();
    paintWires();
    graphRefs.nodesLayer.replaceChildren(...graphNow().n.map(nodeEl));
    paintStatus();
    paintInspector();
  }

  // Rafraîchit seulement la sélection visible (pendant un glisser, sans reconstruire les nœuds).
  function paintSelection() {
    const view = aiView();
    graphRefs.nodesLayer.querySelectorAll('.gn').forEach((el) => el.classList.toggle('sel', view.sel.has(el.dataset.node)));
    paintStatus();
    paintInspector();
  }

  function closeMenu() {
    if (!graphRefs) return;
    graphRefs.menuLayer.replaceChildren();
    aiView().menu = false;
  }

  // Texte cherchable d'un nœud : libellé, mots-clés, consigne complète, rôles, salons.
  function searchTextOf(n) {
    const d = n.d ?? {};
    const channels = (d.channelIds ?? []).map((id) => channelNameOf(id)).join(' ');
    return [EdgeAiGraph.CATALOG[n.t].label, (d.keywords ?? []).join(' '), d.text ?? '', (d.roleIds ?? []).map(roleNameOf).join(' '), channels]
      .join(' ');
  }

  // Recherche par mots : chaque mot tapé doit être un mot du texte (« prix » ne trouve pas « prixe » ;
  // les mots d'au moins 4 lettres acceptent le début d'un mot : « consig » trouve « consigne »).
  function textMatchesWords(text, words) {
    const tokens = EdgeAiGraph.foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.every((w) => tokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w))));
  }

  // Résultats du menu d'ajout : types de nœuds, puis nœuds existants qui correspondent à la recherche.
  function menuGroups(query) {
    const words = EdgeAiGraph.foldText(query).split(/\s+/).filter(Boolean);
    const matches = (text) => textMatchesWords(text, words);
    const groups = [];
    for (const group of EdgeAiGraph.GROUPS) {
      const types = Object.entries(EdgeAiGraph.CATALOG)
        .filter(([, def]) => def.group === group.id)
        .filter(([, def]) => !words.length || matches(`${def.label} ${def.aliases ?? ''} ${group.label}`))
        .map(([type, def]) => ({ label: def.label, run: (world) => ({ kind: 'add', type, world }) }));
      if (types.length) groups.push({ title: group.label, items: types });
    }
    if (words.length) {
      const existing = graphNow()
        .n.filter((n) => matches(searchTextOf(n)))
        .map((n) => ({
          label: `${EdgeAiGraph.CATALOG[n.t].label} — ${EdgeAiGraph.summaryOf(n, roleNameOf)}`,
          run: () => ({ kind: 'focus', id: n.i }),
        }));
      if (existing.length) groups.unshift({ title: 'Dans le graphe', items: existing });
    }
    return groups;
  }

  function openMenu(sx, sy, world) {
    closeMenu();
    const view = aiView();
    const search = ge('input', {
      type: 'search',
      class: 'graph-menu-search',
      placeholder: 'Rechercher : « prix », « rôle », « ET »…',
      'aria-label': 'Rechercher un nœud',
      autocomplete: 'off',
    });
    const list = ge('div', { class: 'graph-menu-list' });
    const menu = ge('div', { class: 'graph-menu', style: `left:${sx}px;top:${sy}px` }, search, list);
    let active = 0;
    let items = [];

    const act = (result) => {
      closeMenu();
      if (result.kind === 'add') addNodeAt(result.type, world.x, world.y);
      else {
        const n = graphNow().n.find((x) => x.i === result.id);
        if (!n) return;
        view.sel = new Set([n.i]);
        centerOn(n);
        repaintGraph();
      }
    };

    const paint = () => {
      const groups = menuGroups(search.value.trim());
      items = [];
      let index = 0;
      const rendered = groups.map((group) =>
        ge(
          'div',
          null,
          ge('div', { class: 'graph-menu-title', text: group.title }),
          group.items.map((item) => {
            const i = index;
            index += 1;
            items.push(item);
            return ge('button', {
              type: 'button',
              class: 'graph-menu-item' + (i === active ? ' active' : ''),
              text: item.label,
              onclick: () => act(item.run(world)),
            });
          }),
        ),
      );
      active = Math.min(active, Math.max(0, items.length - 1));
      list.replaceChildren(...(rendered.length ? rendered : [ge('p', { class: 'hint', text: 'Aucun résultat.' })]));
      list.querySelectorAll('.graph-menu-item').forEach((el, k) => el.classList.toggle('active', k === active));
    };

    search.addEventListener('input', () => {
      active = 0;
      paint();
    });
    search.addEventListener('keydown', (e) => {
      // Rien de ce qui est tapé ici ne doit agir sur le canevas (Suppr, Ctrl+Z, Espace…).
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        graphRefs.viewport.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[active]) act(items[active].run(world));
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        list.querySelectorAll('.graph-menu-item').forEach((el, k) => el.classList.toggle('active', k === active));
        list.querySelectorAll('.graph-menu-item')[active]?.scrollIntoView?.({ block: 'nearest' });
      }
    });
    graphRefs.menuLayer.replaceChildren(menu);
    aiView().menu = true;
    paint();
    search.focus();
  }

  // Un fil se termine sur une broche de sens opposé.
  function finishWire(from, to) {
    const view = aiView();
    if (from.dir === to.dir) {
      view.status = 'Relie une sortie à une entrée.';
      return;
    }
    const out = from.dir === 'out' ? from : to;
    const inp = from.dir === 'in' ? from : to;
    commit((g) => EdgeAiGraph.connect(g, out.node, out.pin, inp.node, inp.pin), { ok: 'Fil créé.' });
  }

  // Broche sous le pointeur, avec une tolérance de 14 px (zone de prise élargie).
  function pinAt(x, y) {
    const hit = document.elementFromPoint?.(x, y)?.closest?.('.gn-pin');
    if (hit) return hit;
    let best = null;
    let bestD = 14 * 14;
    graphRefs.nodesLayer.querySelectorAll('.gn-pin').forEach((el) => {
      const r = el.getBoundingClientRect();
      const d2 = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        best = el;
      }
    });
    return best;
  }

  // Clic gauche sur une broche : fil. Clic gauche sur un nœud : sélection et glisser (groupe).
  // Glisser sur le fond : déplacement de la vue. Maj + glisser sur le fond : rectangle de sélection.
  // Maj + clic : ajouter ou retirer un nœud. Clic droit, clic milieu ou Espace + glisser : vue.
  function onGraphPointerDown(e) {
    const view = aiView();
    view.panMoved = false; // un nouveau geste repart de zéro (le menu ne s'ouvre pas après un glisser)
    if (e.target.closest('.graph-menu')) return;
    if (view.menu) closeMenu();
    if (e.target.closest('path.wire')) return;
    graphRefs.viewport.focus({ preventScroll: true });
    const pinEl = e.target.closest('.gn-pin');
    const nodeHit = e.target.closest('.gn');
    graphRefs.viewport.setPointerCapture?.(e.pointerId);
    view.lastWorld = worldPoint(e);
    if (e.button === 1) e.preventDefault();

    if (e.button === 0 && !view.space && pinEl) {
      e.preventDefault();
      const node = pinEl.dataset.node;
      const pin = pinEl.dataset.pin;
      const dir = pinEl.dataset.dir;
      let from = { node, pin, dir };
      // Depuis une entrée déjà reliée : on détache le fil et on repart de sa sortie.
      if (dir === 'in') {
        const idx = graphNow().w.findIndex(([, , b, q]) => b === node && q === pin);
        if (idx >= 0) {
          const [a, p] = graphNow().w[idx];
          pushHistory(clone(graphNow()), null);
          aiDraft().graph = EdgeAiGraph.disconnect(graphNow(), idx);
          markAiDirty();
          from = { node: a, pin: p, dir: 'out' };
        }
      }
      view.drag = { kind: 'wire', from };
      const temp = svgEl('path', { class: 'temp' });
      graphRefs.svg.append(temp);
      view.drag.temp = temp;
    } else if (e.button === 0 && !view.space && nodeHit) {
      e.preventDefault();
      const id = nodeHit.dataset.node;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const wasSelected = view.sel.has(id);
      if (additive && wasSelected) {
        view.sel.delete(id);
        paintSelection();
        return;
      }
      if (additive) view.sel.add(id);
      else if (!wasSelected) view.sel = new Set([id]);
      view.status = '';
      const starts = new Map(selectedNodes().map((n) => [n.i, { x: n.x, y: n.y }]));
      view.drag = {
        kind: 'node',
        id,
        startWorld: worldPoint(e),
        starts,
        moved: false,
        // Clic sur un nœud d'une sélection multiple sans glisser : la sélection se réduit à ce nœud.
        collapse: !additive && wasSelected && view.sel.size > 1,
        before: clone(graphNow()),
      };
      paintSelection();
    } else if (e.button === 1 || e.button === 2 || (e.button === 0 && (view.space || !e.shiftKey))) {
      // Fond vide, glisser de base : déplacement de la vue. Un simple clic sur le fond désélectionne.
      view.drag = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, pan0: { x: view.panX, y: view.panY }, moved: false, deselect: e.button === 0 && !view.space };
      view.panMoved = false;
    } else {
      // Maj + glisser sur le fond : rectangle de sélection, ajouté à la sélection existante.
      view.drag = { kind: 'marquee', start: worldPoint(e), additive: true, base: new Set(view.sel), moved: false, rect: null };
      paintSelection();
    }
  }

  function intersects(n, rect) {
    return (
      n.x < rect.x + rect.w &&
      n.x + EdgeAiGraph.NODE_W > rect.x &&
      n.y < rect.y + rect.h &&
      n.y + EdgeAiGraph.nodeHeight(n) > rect.y
    );
  }

  function onGraphPointerMove(e) {
    const view = aiView();
    view.lastWorld = worldPoint(e);
    const d = view.drag;
    if (!d) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.start.x;
      const dy = e.clientY - d.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        d.moved = true;
        view.panMoved = true;
      }
      view.panX = d.pan0.x + dx;
      view.panY = d.pan0.y + dy;
      applyTransform();
    } else if (d.kind === 'node') {
      const w = worldPoint(e);
      const dx = w.x - d.startWorld.x;
      const dy = w.y - d.startWorld.y;
      for (const n of graphNow().n) {
        const s = d.starts.get(n.i);
        if (!s) continue;
        const nx = Math.max(-5000, Math.min(5000, Math.round(s.x + dx)));
        const ny = Math.max(-5000, Math.min(5000, Math.round(s.y + dy)));
        if (nx !== s.x || ny !== s.y) d.moved = true;
        n.x = nx;
        n.y = ny;
        const el = graphRefs.nodesLayer.querySelector(`[data-node="${n.i}"]`);
        if (el) {
          el.style.left = `${nx}px`;
          el.style.top = `${ny}px`;
        }
      }
      paintWires();
    } else if (d.kind === 'marquee') {
      const w = worldPoint(e);
      if (Math.abs(w.x - d.start.x) + Math.abs(w.y - d.start.y) > 3) d.moved = true;
      const rect = {
        x: Math.min(d.start.x, w.x),
        y: Math.min(d.start.y, w.y),
        w: Math.abs(w.x - d.start.x),
        h: Math.abs(w.y - d.start.y),
      };
      d.rect = rect;
      view.sel = new Set([...d.base, ...graphNow().n.filter((n) => intersects(n, rect)).map((n) => n.i)]);
      paintMarquee(rect);
      paintSelection();
    } else if (d.kind === 'wire') {
      const from = graphNow().n.find((x) => x.i === d.from.node);
      const fromPos = from && EdgeAiGraph.pinPosition(from, d.from.pin, 'out');
      if (!fromPos) return;
      d.temp.setAttribute('d', wirePath(fromPos, view.lastWorld));
    }
  }

  function paintMarquee(rect) {
    let box = graphRefs.marquee;
    if (!rect) {
      box?.remove();
      graphRefs.marquee = null;
      return;
    }
    if (!box) {
      box = ge('div', { class: 'graph-marquee' });
      graphRefs.marquee = box;
      graphRefs.world.append(box);
    }
    box.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
  }

  function onGraphPointerUp(e) {
    const view = aiView();
    const d = view.drag;
    view.drag = null;
    if (!d) return;
    if (d.kind === 'pan') {
      // La vue a déjà suivi le pointeur ; un simple clic sur le fond vide désélectionne.
      if (d.deselect && !d.moved && view.sel.size) {
        view.sel = new Set();
        repaintGraph();
      }
    } else if (d.kind === 'node') {
      if (d.moved) {
        pushHistory(d.before, null);
        markAiDirty();
      } else if (d.collapse) {
        view.sel = new Set([d.id]);
      }
      repaintGraph();
    } else if (d.kind === 'marquee') {
      paintMarquee(null);
      repaintGraph();
    } else if (d.kind === 'wire') {
      d.temp.remove();
      // Le fil détaché (entrée déjà reliée) reste retiré si la sortie n'est pas branchée ailleurs.
      const target = pinAt(e.clientX, e.clientY);
      if (target) {
        finishWire(d.from, { node: target.dataset.node, pin: target.dataset.pin, dir: target.dataset.dir });
      }
      repaintGraph();
    }
  }

  function onGraphWheel(e) {
    e.preventDefault();
    const view = aiView();
    const r = graphRefs.viewport.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const zoom = Math.max(0.4, Math.min(1.8, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    const wx = (mx - view.panX) / view.zoom;
    const wy = (my - view.panY) / view.zoom;
    view.panX = mx - wx * zoom;
    view.panY = my - wy * zoom;
    view.zoom = zoom;
    applyTransform();
  }

  function onGraphContextMenu(e) {
    e.preventDefault();
    const view = aiView();
    if (view.panMoved) {
      view.panMoved = false;
      return;
    }
    const r = graphRefs.viewport.getBoundingClientRect();
    openMenu(e.clientX - r.left, e.clientY - r.top, worldPoint(e));
  }

  function onGraphKeyDown(e) {
    const view = aiView();
    // Pas de raccourcis depuis la recherche du menu ni depuis les champs.
    if (e.target.closest?.('.graph-menu') || e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'Escape') {
      if (view.menu) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      view.space = true;
      graphRefs.viewport.classList.add('panning');
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod) {
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else if (k === 'c' && view.sel.size) {
        e.preventDefault();
        copySelection();
      } else if (k === 'v') {
        e.preventDefault();
        pasteClip();
      } else if (k === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (k === 'a') {
        e.preventDefault();
        view.sel = new Set(graphNow().n.map((n) => n.i));
        repaintGraph();
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && view.sel.size) {
      e.preventDefault();
      deleteSelection();
    } else if (k === 'f') {
      e.preventDefault();
      frameNodes(view.sel.size ? selectedNodes() : graphNow().n);
    }
  }

  function onGraphKeyUp(e) {
    if (e.key === ' ') {
      const view = aiView();
      view.space = false;
      graphRefs.viewport.classList.remove('panning');
    }
  }

  // Éditeur complet : barre d'outils, canevas (nœuds et fils), panneau de détails.
  function buildGraphEditor() {
    const viewport = ge('div', { class: 'graph-viewport', tabindex: '0' });
    const world = ge('div', { class: 'graph-world' });
    const svg = svgEl('svg', { class: 'graph-wires', width: 1, height: 1 });
    const nodesLayer = ge('div', { class: 'graph-nodes' });
    const menuLayer = ge('div');
    world.append(svg, nodesLayer);
    viewport.append(world, menuLayer);
    const status = ge('p', { class: 'hint graph-status' });
    const inspector = ge('div', { class: 'graph-inspector' });
    graphRefs = { viewport, world, svg, nodesLayer, menuLayer, status, inspector, marquee: null };

    viewport.addEventListener('pointerdown', onGraphPointerDown);
    viewport.addEventListener('pointermove', onGraphPointerMove);
    viewport.addEventListener('pointerup', onGraphPointerUp);
    viewport.addEventListener('pointercancel', onGraphPointerUp);
    viewport.addEventListener('pointerenter', () => (aiView().overCanvas = true));
    viewport.addEventListener('pointerleave', () => (aiView().overCanvas = false));
    viewport.addEventListener('wheel', onGraphWheel, { passive: false });
    viewport.addEventListener('contextmenu', onGraphContextMenu);
    viewport.addEventListener('auxclick', (e) => e.preventDefault());
    viewport.addEventListener('blur', () => {
      aiView().space = false;
      viewport.classList.remove('panning');
    });

    const view = aiView();
    const fsButton = button('⛶ Plein écran', async () => setGraphFullscreen(!aiView().fs), { cls: 'small' });
    graphRefs.fsButton = fsButton;
    const toolbar = ge(
      'div',
      { class: 'graph-toolbar' },
      fsButton,
      button('↶ Annuler', async () => undo(), { cls: 'small', title: 'Ctrl+Z' }),
      button('↷ Rétablir', async () => redo(), { cls: 'small', title: 'Ctrl+Y ou Ctrl+Maj+Z' }),
      ...Object.entries(EdgeAiGraph.CATALOG).map(([type, def]) =>
        button(
          `+ ${def.label}`,
          async () => {
            const c = centerWorld();
            addNodeAt(type, c.x, c.y);
          },
          { cls: 'small' },
        ),
      ),
      button('Cadrer (F)', async () => frameNodes(graphNow().n), { cls: 'small' }),
      button('−', async () => {
        view.zoom = Math.max(0.4, view.zoom / 1.2);
        applyTransform();
      }, { cls: 'small' }),
      button('+', async () => {
        view.zoom = Math.min(1.8, view.zoom * 1.2);
        applyTransform();
      }, { cls: 'small' }),
    );

    toolbar.append(ge('span', { class: 'hint ai-save', 'data-state': aiState(), text: aiStatusText() }));
    const wrap = ge('div', { class: 'graph-wrap' }, ge('div', null, toolbar, viewport, status), inspector);
    graphRefs.wrap = wrap;
    // Raccourcis : actifs dans tout l'éditeur (canevas, barre d'outils), sauf dans les champs.
    wrap.addEventListener('keydown', onGraphKeyDown);
    wrap.addEventListener('keyup', onGraphKeyUp);
    applyFsState();
    repaintGraph();
    return wrap;
  }

  // Toute saisie dans la page IA déclenche la sauvegarde, sauf les champs marqués data-nosave (test, lot).
  function onAiEdit(e) {
    if (e.target.closest('[data-nosave]')) return;
    markAiDirty();
  }

  function viewAi() {
    const d = aiDraft();
    const test = S.aiTest ?? null;
    const textChannels = channelsOf(TEXT_KINDS);

    const abbrRows = d.abbreviations.map((a, i) =>
      h(
        'div',
        { class: 'row' },
        fieldText('Abréviation', a.short, { max: 30, onInput: (v) => (a.short = v) }),
        fieldText('Signification', a.meaning, { max: 200, onInput: (v) => (a.meaning = v) }),
        h(
          'div',
          { class: 'actions' },
          button(
            'Supprimer',
            async () => {
              d.abbreviations.splice(i, 1);
              markAiDirty();
              rerender();
            },
            { cls: 'danger small' },
          ),
        ),
      ),
    );

    const addBulk = async () => {
      const parsed = parseAbbreviationLines(S.aiBulk);
      if (!parsed.length) throw new Error('Aucune ligne reconnue : écris « abréviation = signification ».');
      const seen = new Set(d.abbreviations.map((a) => a.short.toLowerCase()));
      let added = 0;
      for (const item of parsed) {
        if (seen.has(item.short.toLowerCase())) continue;
        if (d.abbreviations.length >= AI_MAX_ABBR) break;
        seen.add(item.short.toLowerCase());
        d.abbreviations.push(item);
        added += 1;
      }
      S.aiBulk = '';
      markAiDirty();
      toast(`${added} abréviation(s) ajoutée(s). Pense à enregistrer.`);
      rerender();
    };

    let resultBlock = null;
    if (test?.kind === 'preview') {
      resultBlock = h(
        'div',
        { class: 'card' },
        h('h3', { text: 'Prompt système final (version enregistrée)' }),
        h('p', {
          class: 'hint',
          text: test.active.length
            ? `Consignes actives : ${test.active.map((a) => a.text).join(' | ')}`
            : 'Aucune consigne active pour ce message.',
        }),
        h('p', {
          class: 'hint',
          text: test.tools?.length ? `Outils proposés au modèle : ${test.tools.join(', ')}` : 'Aucun outil proposé pour ce message.',
        }),
        h('pre', { class: 'ai-pre', text: test.system }),
      );
    } else if (test?.kind === 'reply') {
      resultBlock = h(
        'div',
        { class: 'card' },
        h('h3', { text: 'Réponse de Mistral' }),
        h('p', { class: 'ai-pre', text: test.text }),
        test.actions?.length
          ? h('p', { class: 'hint', text: `Actions demandées par le modèle (simulées, rien n’a été enregistré ni attribué) : ${test.actions.map((a) => a.name).join(', ')}` })
          : null,
      );
    }

    const testBody = () => ({
      message: S.aiTestInput ?? '',
      channelId: S.aiTestChannel || undefined,
      mentioned: Boolean(S.aiTestMention),
    });

    const memoryBox = h('div', null, h('p', { class: 'muted', text: 'Chargement…' }));

    const root = h(
      'section',
      null,
      pageHead(
        '🤖 IA (Mistral)',
        'Le bot répond avec Ministral 14B. Tout est enregistré automatiquement, peu après ta dernière modification.',
      ),
      h('p', { class: 'hint ai-save', 'data-state': aiState(), text: aiStatusText() }),
      h(
        'div',
        { class: 'card' },
        fieldSwitch(
          'IA activée',
          'Le bot répond quand on le mentionne, et librement dans les salons choisis.',
          d.enabled,
          (v) => (d.enabled = v),
        ),
        fieldSelect(
          'Modèle',
          d.model,
          AI_MODELS,
          (v) => (d.model = v),
          'Clé requise : MISTRAL_API_KEY sur l’hébergeur. Elle n’apparaît jamais ici.',
        ),
        fieldSelect('Créativité', String(d.temperature), AI_TEMPS, (v) => (d.temperature = Number(v))),
        fieldNumber('Longueur maximale de la réponse (tokens, 50 à 1000)', d.maxReplyTokens, {
          min: 50,
          max: 1000,
          onInput: (v) => (d.maxReplyTokens = v),
        }),
        fieldNumber('Délai entre deux réponses à un même membre (secondes, 0 à 600)', d.cooldownSeconds, {
          min: 0,
          max: 600,
          onInput: (v) => (d.cooldownSeconds = v),
        }),
        fieldChecks(
          'Salons de réponse libre',
          textChannels.map((c) => ({ id: c.id, label: channelLabel(c) })),
          d.channelIds,
          (v) => (d.channelIds = v),
          'Sans salon choisi, le bot ne répond que lorsqu’on le mentionne.',
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Prompt système' }),
        fieldText('Rôle et règles du bot', d.systemPrompt, {
          max: 2000,
          multiline: true,
          required: true,
          onInput: (v) => (d.systemPrompt = v),
        }),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: `Abréviations (${d.abbreviations.length} / ${AI_MAX_ABBR})` }),
        h('p', { class: 'hint', text: 'Le bot comprendra ces abréviations dans les messages des membres.' }),
        d.abbreviations.length
          ? h('div', null, abbrRows)
          : h('p', { class: 'muted', text: 'Aucune abréviation pour le moment.' }),
        h(
          'div',
          { class: 'actions' },
          button(
            'Ajouter une abréviation',
            async () => {
              if (d.abbreviations.length >= AI_MAX_ABBR) throw new Error(`${AI_MAX_ABBR} abréviations maximum.`);
              d.abbreviations.push({ short: '', meaning: '' });
              markAiDirty();
              rerender();
            },
            { cls: 'primary' },
          ),
        ),
        h('h3', { text: 'Ajout en lot' }),
        h('div', { 'data-nosave': true }, fieldText('Une par ligne : abréviation = signification', S.aiBulk ?? '', {
          max: 5000,
          multiline: true,
          onInput: (v) => (S.aiBulk = v),
        })),
        h('div', { class: 'actions' }, button('Ajouter ces lignes', addBulk)),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Graphe de réponse' }),
        h('p', {
          class: 'hint',
          text:
            'Les événements (mot-clé, salon, mention, rôle, ping de rôle) et la logique (ET, OU à 2 à 6 entrées, NON) décident quelles consignes sont ajoutées au prompt, et quels rôles l’IA peut donner.',
        }),
        buildGraphEditor(),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Mémoire des membres' }),
        h('p', {
          class: 'hint',
          text:
            'Le bot peut retenir quelques notes sur chaque membre, uniquement quand la personne le demande (« retiens que… », « oublie ce que tu sais de moi »). ' +
            'Chaque personne a sa propre mémoire. Désactivée par défaut.',
        }),
        fieldSwitch('Mémoire activée', 'Active les outils « retenir » et « oublier » pour le bot.', d.memoryEnabled, (v) => (d.memoryEnabled = v)),
        fieldNumber('Notes gardées par personne (5 à 50)', d.memoryMaxNotes, {
          min: 5,
          max: 50,
          onInput: (v) => (d.memoryMaxNotes = v),
        }),
      ),
      h(
        'div',
        { class: 'card', 'data-nosave': true },
        h('h3', { text: 'Notes enregistrées' }),
        h('p', { class: 'hint', text: 'Modifie ou efface les notes d’un membre. Une note par ligne, 200 caractères maximum.' }),
        memoryBox,
      ),
      h(
        'div',
        { class: 'card', 'data-nosave': true },
        h('h2', { text: 'Tester' }),
        fieldText('Message d’exemple', S.aiTestInput ?? '', {
          max: 500,
          onInput: (v) => (S.aiTestInput = v),
        }),
        fieldSelect(
          'Salon du test',
          S.aiTestChannel ?? '',
          [{ value: '', label: '— aucun —' }, ...textChannels.map((c) => ({ value: c.id, label: channelLabel(c) }))],
          (v) => (S.aiTestChannel = v),
          'Pour tester les nœuds « Salon ».',
        ),
        fieldSwitch('Le bot est mentionné', 'Pour tester le nœud « Bot mentionné ».', Boolean(S.aiTestMention), (v) => (S.aiTestMention = v)),
        h(
          'div',
          { class: 'actions' },
          button('Voir le prompt final', async () => {
            const res = await api('POST', gp('/ai/preview'), testBody());
            S.aiTest = { kind: 'preview', ...res };
            rerender();
          }),
          button('Tester avec Mistral (consomme des tokens)', async () => {
            const res = await api('POST', gp('/ai/test'), testBody());
            S.aiTest = { kind: 'reply', text: res.reply, actions: res.actions ?? [] };
            rerender();
          }),
        ),
        resultBlock,
      ),
      saveButton(async () => {
        markAiDirty();
        await flushAi();
        if (aiSave.failed) throw new Error(aiSave.message);
        toast('Module IA enregistré.');
      }, 'Enregistrer maintenant'),
    );
    root.addEventListener('input', onAiEdit);
    root.addEventListener('change', onAiEdit);
    loadAiMemories(memoryBox);
    return root;
  }

  // Notes par membre (liste et modification directes, sans passer par la sauvegarde du module).
  async function loadAiMemories(box) {
    try {
      const { rows, maxNotes } = await api('GET', gp('/ai/memories'));
      if (!rows.length) {
        box.replaceChildren(h('p', { class: 'muted', text: 'Aucun membre n’a de note pour le moment.' }));
        return;
      }
      box.replaceChildren(
        ...rows.map((r) => {
          const area = h('textarea', { rows: Math.min(8, Math.max(2, r.notes.length + 1)), maxlength: 200 * maxNotes, 'aria-label': `Notes de ${r.userName}` });
          area.value = r.notes.join('\n');
          return h(
            'div',
            { class: 'item', style: 'display:block' },
            h('div', null, h('strong', { text: r.userName }), h('span', { class: 'hint', text: ` · ${r.notes.length} note(s) sur ${maxNotes} · mise à jour ${fmtDate(r.updatedAt)}` })),
            area,
            h(
              'div',
              { class: 'actions' },
              button(
                'Enregistrer ces notes',
                async () => {
                  const notes = area.value.split('\n').map((x) => x.trim()).filter(Boolean);
                  await api('PUT', gp(`/ai/memories/${r.userId}`), { notes });
                  toast('Notes enregistrées.');
                  await loadAiMemories(box);
                },
                { cls: 'primary small' },
              ),
              button(
                'Tout effacer',
                async () => {
                  await api('DELETE', gp(`/ai/memories/${r.userId}`));
                  toast('Notes effacées.');
                  await loadAiMemories(box);
                },
                { cls: 'danger small' },
              ),
            ),
          );
        }),
      );
    } catch (err) {
      box.replaceChildren(h('p', { class: 'error', text: err.message }));
    }
  }

  function viewLinks() {
    const cfg = clone(S.data.modules.links);
    return h(
      'section',
      null,
      pageHead('🔗 Liens', 'Les messages contenant un lien sont supprimés, sauf pour les rôles et salons autorisés.'),
      h(
        'div',
        { class: 'card' },
        fieldSwitch('Blocage des liens activé', null, cfg.enabled, (v) => (cfg.enabled = v)),
        fieldChecks(
          'Rôles autorisés à poster des liens',
          roleItems(),
          cfg.allowedRoleIds,
          (v) => (cfg.allowedRoleIds = v),
          'Ces membres peuvent poster des liens partout.',
        ),
        fieldChecks(
          'Salons et forums où tout le monde peut poster des liens',
          channelsOf(FORUM_KINDS).map((c) => ({ id: c.id, label: channelLabel(c) })),
          cfg.allowedChannelIds,
          (v) => (cfg.allowedChannelIds = v),
          'Pour un forum, tous les posts du forum sont autorisés.',
        ),
        fieldText('Avertissement envoyé au membre', cfg.warning, {
          max: 300,
          multiline: true,
          required: true,
          hint: 'Le bot mentionne automatiquement le membre devant ce texte.',
          onInput: (v) => (cfg.warning = v),
        }),
        saveButton(() =>
          saveModule('links', {
            enabled: cfg.enabled,
            allowedRoleIds: cfg.allowedRoleIds,
            allowedChannelIds: cfg.allowedChannelIds,
            warning: cfg.warning,
          }),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Tickets
  // -------------------------------------------------------------------------

  function uploadBlock(title, url, accept, kind) {
    const fileInput = h('input', {
      type: 'file',
      accept,
      class: 'hidden-input',
      onchange: async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > MAX_UPLOAD) return toast('Fichier trop lourd (8 Mo maximum).', false);
        const res = await api('POST', gp(`/ticket/assets/${kind}`), file);
        S.data.modules.ticket = res.config;
        toast('Fichier importé.');
        rerender();
      },
    });
    return h(
      'div',
      { class: 'field' },
      h('span', { class: 'label', text: title }),
      h(
        'div',
        { class: 'upload' },
        url ? h('img', { src: url, alt: title }) : h('div', { class: 'empty', text: 'Aucun fichier' }),
        h(
          'div',
          { class: 'row' },
          button('Importer', async () => fileInput.click(), { cls: 'primary' }),
          url
            ? button('Retirer', async () => {
                await api('DELETE', gp(`/ticket/assets/${kind}`));
                S.data.modules.ticket.assets = { ...S.data.modules.ticket.assets, [kind]: null };
                toast('Fichier retiré.');
                rerender();
              }, { cls: 'danger' })
            : null,
          fileInput,
        ),
      ),
    );
  }

  function viewTickets() {
    const cfg = clone(S.data.modules.ticket);
    const page = h('section', null, pageHead('🎫 Tickets', 'Panneau public, types de ticket, images et textes.'));

    // 1. Réglages généraux
    page.append(
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Réglages' }),
        fieldSwitch('Module activé', 'Désactivé : les membres ne peuvent plus ouvrir de ticket.', cfg.enabled, (v) => (cfg.enabled = v)),
        fieldSwitch('Image sur le panneau', null, cfg.image, (v) => (cfg.image = v)),
        fieldSwitch('GIF dans le salon du ticket', null, cfg.gif, (v) => (cfg.gif = v)),
        fieldSelect(
          'Affichage des types sur le panneau',
          cfg.panelStyle,
          [
            { value: 'buttons', label: 'Boutons' },
            { value: 'select', label: 'Menu déroulant' },
          ],
          (v) => (cfg.panelStyle = v),
        ),
        fieldSelect(
          'Affichage des textes (aperçu du panneau)',
          cfg.textMode,
          [
            { value: 'buttons', label: 'Sections (boutons)' },
            { value: 'select', label: 'Menu déroulant' },
          ],
          (v) => (cfg.textMode = v),
        ),
        fieldChannel('Catégorie des salons de tickets', cfg.categoryId, [CH.CATEGORY], (v) => (cfg.categoryId = v), null, '— Aucune —'),
        saveButton(() =>
          saveModule('ticket', {
            enabled: cfg.enabled,
            image: cfg.image,
            gif: cfg.gif,
            panelStyle: cfg.panelStyle,
            textMode: cfg.textMode,
            categoryId: cfg.categoryId,
          }),
        ),
      ),
    );

    // 2. Images et GIF
    page.append(
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Images et GIF' }),
        h('p', { class: 'hint', text: 'Image : affichée sur le panneau (si activée). GIF : affiché dans chaque ticket. PNG, JPG, WEBP ou GIF, 8 Mo maximum.' }),
        uploadBlock('Image du panneau', cfg.assets?.image?.url, 'image/*', 'image'),
        uploadBlock('GIF du salon de ticket', cfg.assets?.gif?.url, 'image/gif', 'gif'),
      ),
    );

    // 3. Types de ticket
    page.append(ticketTypesCard(cfg));

    // 4. Textes
    const texts = clone(cfg.texts ?? {});
    page.append(
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Textes' }),
        h('p', { class: 'hint', text: 'Chaque texte est modifiable. Variables selon le champ : {user}, {channel}, {number}, {type}.' }),
        ...S.data.ticketTexts.map((def) =>
          fieldText(def.label, texts[def.key], {
            max: def.max,
            multiline: def.style === 'long',
            required: true,
            onInput: (v) => (texts[def.key] = v),
          }),
        ),
        saveButton(() => saveModule('ticket', { texts }), 'Enregistrer les textes'),
      ),
    );

    // 5. Publication
    page.append(
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Publier le panneau' }),
        h('p', { class: 'hint', text: 'Publie le panneau avec les réglages enregistrés. Enregistre d’abord tes modifications.' }),
        fieldChannel('Salon', S.pubChannel || null, TEXT_KINDS, (v) => (S.pubChannel = v ?? '')),
        h(
          'div',
          { class: 'actions' },
          button('Publier le panneau', async () => {
            if (!S.pubChannel) throw new Error('Choisis un salon.');
            await api('POST', gp('/ticket/publish'), { channelId: S.pubChannel });
            toast('Panneau publié.');
          }, { cls: 'primary' }),
        ),
      ),
    );

    return page;
  }

  function ticketTypesCard(cfg) {
    if (!S.ticketTypes) S.ticketTypes = clone(cfg.types ?? []);
    const types = S.ticketTypes;

    const saveTypes = async (list, message) => {
      S.ticketTypes = null; // le rendu suivant repart de la configuration enregistrée
      await saveModule('ticket', { types: list }, message);
    };

    const move = async (index, delta) => {
      const list = clone(types);
      const target = index + delta;
      [list[index], list[target]] = [list[target], list[index]];
      S.ticketTypes = list;
      await saveTypes(list, 'Ordre enregistré.');
    };

    const remove = async (index) => {
      if (!confirm(`Supprimer le type « ${types[index].label} » ?`)) return;
      await saveTypes(types.filter((_, i) => i !== index), 'Type supprimé.');
    };

    const openEditor = (index) => {
      const source = index === -1 ? { label: '', emoji: '', description: '', roleId: '' } : types[index];
      S.ticketEdit = { index, data: { label: source.label ?? '', emoji: source.emoji ?? '', description: source.description ?? '', roleId: source.roleId ?? '' } };
      rerender();
    };

    const items = types.length
      ? types.map((t, i) => {
          const role = t.roleId ? roleById(t.roleId) : null;
          return h(
            'div',
            { class: 'item' },
            h(
              'div',
              { class: 'grow' },
              h('strong', { text: `${t.emoji ? `${t.emoji} ` : ''}${t.label}` }),
              t.description ? h('div', { class: 'hint', text: t.description }) : null,
              role ? h('div', { class: 'hint', text: `Mentionne le rôle : @${role.name}` }) : null,
            ),
            h(
              'div',
              { class: 'tools' },
              button('↑', () => move(i, -1), { cls: 'small', title: 'Monter' }),
              button('↓', () => move(i, 1), { cls: 'small', title: 'Descendre' }),
              button('Modifier', async () => openEditor(i), { cls: 'small' }),
              button('Supprimer', () => remove(i), { cls: 'danger small' }),
            ),
          );
        })
      : [h('p', { class: 'muted', text: 'Aucun type : le panneau affiche un seul bouton « Ouvrir un ticket ».' })];

    // Éditeur (ajout ou modification)
    let editor = null;
    if (S.ticketEdit) {
      const d = S.ticketEdit.data;
      const isNew = S.ticketEdit.index === -1;
      editor = h(
        'div',
        { class: 'card' },
        h('h3', { text: isNew ? 'Nouveau type de ticket' : 'Modifier le type' }),
        fieldText('Nom', d.label, { max: 80, required: true, onInput: (v) => (d.label = v) }),
        fieldText('Emoji (facultatif)', d.emoji, { max: 64, hint: 'Un seul emoji.', onInput: (v) => (d.emoji = v) }),
        fieldText('Description (facultatif)', d.description, { max: 100, onInput: (v) => (d.description = v) }),
        fieldSelect(
          'Rôle à mentionner dans le ticket (facultatif)',
          d.roleId,
          [{ value: '', label: '— Aucun —' }, ...(S.data.meta.roles || []).map((r) => ({ value: r.id, label: `@${r.name}` }))],
          (v) => (d.roleId = v),
        ),
        h(
          'div',
          { class: 'actions' },
          button('Enregistrer le type', async () => {
            const label = d.label.trim();
            if (!label) throw new Error('Le nom est obligatoire.');
            const entry = { id: isNew ? undefined : types[S.ticketEdit.index].id, label };
            if (d.emoji.trim()) entry.emoji = d.emoji.trim();
            if (d.description.trim()) entry.description = d.description.trim();
            if (d.roleId) entry.roleId = d.roleId;
            const list = clone(types);
            if (isNew) list.push(entry);
            else list[S.ticketEdit.index] = entry;
            S.ticketEdit = null;
            await saveTypes(list, 'Type enregistré.');
          }, { cls: 'primary' }),
          button('Annuler', async () => {
            S.ticketEdit = null;
            rerender();
          }),
        ),
      );
    }

    return h(
      'div',
      { class: 'card' },
      h('h2', { text: `Types de ticket (${types.length}/${MAX_TYPES})` }),
      h('p', { class: 'hint', text: 'Sans type, le panneau affiche un bouton. Avec des types, chaque type ouvre un ticket de cette catégorie.' }),
      ...items,
      editor,
      S.ticketEdit ? null : h('div', { class: 'actions' }, types.length >= MAX_TYPES ? h('span', { class: 'hint', text: 'Maximum atteint.' }) : button('Ajouter un type', async () => openEditor(-1), { cls: 'primary' })),
    );
  }

  // -------------------------------------------------------------------------
  // Créateur d'embed
  // -------------------------------------------------------------------------

  function embedPreview(d) {
    const main = h('div', { class: 'main' });
    if (d.authorName) main.append(h('div', { class: 'author', text: d.authorName }));
    if (d.title) main.append(h('div', { class: 'title' }, d.url ? h('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer', text: d.title }) : d.title));
    if (d.description) main.append(h('div', { class: 'desc', text: d.description }));
    if (d.fields?.length) {
      const wrap = h('div', { class: 'fields' });
      let row = null;
      for (const f of d.fields) {
        const cell = h('div', null, h('div', { class: 'fname', text: f.name }), h('div', { class: 'fvalue', text: f.value }));
        if (f.inline) {
          if (!row || row.children.length >= 3) {
            row = h('div', { class: 'inline-wrap' });
            wrap.append(row);
          }
          row.append(cell);
        } else {
          row = null;
          wrap.append(cell);
        }
      }
      main.append(wrap);
    }
    if (d.image) main.append(h('img', { class: 'bigimg', src: d.image, alt: '', referrerpolicy: 'no-referrer' }));
    if (d.footerText) main.append(h('div', { class: 'foot', text: d.footerText }));
    const isEmpty = !(d.title || d.description || d.authorName || d.footerText || d.image || d.thumbnail || d.fields?.length);
    if (isEmpty) return h('p', { class: 'hint', text: 'Aperçu vide : ajoute un titre ou une description.' });
    return h(
      'div',
      { class: 'embed-preview' },
      main,
      d.thumbnail ? h('img', { class: 'thumb', src: d.thumbnail, alt: '', referrerpolicy: 'no-referrer' }) : null,
    );
  }

  function viewEmbed() {
    const d = S.embedDraft;
    const previewBox = h('div', null, embedPreview(d));
    const refreshPreview = () => previewBox.replaceChildren(embedPreview(d));
    const templates = S.data.modules.embed.templates ?? {};

    const fileInputs = {};
    const makeFileInput = (kind) =>
      h('input', {
        type: 'file',
        accept: 'image/*',
        class: 'hidden-input',
        onchange: async (e) => {
          const file = e.target.files[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > MAX_UPLOAD) return toast('Fichier trop lourd (8 Mo maximum).', false);
          const res = await api('POST', gp(`/embed/image/${kind}`), file);
          S.embedDraft[kind] = res.config.draft[kind];
          S.data.modules.embed = res.config;
          toast('Image importée.');
          rerender();
        },
      });
    fileInputs.image = makeFileInput('image');
    fileInputs.thumbnail = makeFileInput('thumbnail');

    const imageField = (kind, label) =>
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label', text: label }),
        h('input', {
          type: 'text',
          maxlength: 2048,
          value: d[kind] ?? '',
          placeholder: 'https://…',
          oninput: (e) => {
            d[kind] = e.target.value.trim();
            refreshPreview();
          },
        }),
        h(
          'div',
          { class: 'row' },
          button('Importer une image', async () => fileInputs[kind].click(), { cls: 'primary small' }),
          d[kind]
            ? button('Retirer l’image', async () => {
                await api('DELETE', gp(`/embed/image/${kind}`));
                d[kind] = '';
                S.data.modules.embed.draft = { ...S.data.modules.embed.draft, [kind]: '' };
                toast('Image retirée.');
                rerender();
              }, { cls: 'danger small' })
            : null,
          fileInputs[kind],
        ),
        h('div', { class: 'hint', text: kind === 'image' ? 'Grande image en bas de l’embed.' : 'Petite image à droite.' }),
      );

    const fieldRows = d.fields.map((f, i) => {
      const move = (delta) => {
        const j = i + delta;
        [d.fields[i], d.fields[j]] = [d.fields[j], d.fields[i]];
        rerender();
      };
      return h(
        'div',
        { class: 'card' },
        fieldText(`Champ ${i + 1} : nom`, f.name, { max: 256, required: true, onInput: (v) => { f.name = v; refreshPreview(); } }),
        fieldText('Valeur', f.value, { max: 1024, multiline: true, required: true, onInput: (v) => { f.value = v; refreshPreview(); } }),
        fieldSwitch('Afficher à côté des autres champs', 'Jusqu’à 3 champs par ligne.', f.inline, (v) => {
          f.inline = v;
          refreshPreview();
        }),
        h(
          'div',
          { class: 'actions' },
          button('↑', () => move(-1), { cls: 'small', title: 'Monter' }),
          button('↓', () => move(1), { cls: 'small', title: 'Descendre' }),
          button('Supprimer le champ', async () => {
            d.fields.splice(i, 1);
            rerender();
          }, { cls: 'danger small' }),
        ),
      );
    });

    const editor = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Contenu' }),
      fieldText('Titre', d.title, { max: 256, onInput: (v) => { d.title = v; refreshPreview(); } }),
      fieldText('Lien du titre (facultatif)', d.url, { max: 2048, hint: 'Adresse https.', onInput: (v) => { d.url = v.trim(); refreshPreview(); } }),
      fieldText('Description', d.description, { max: 4096, multiline: true, onInput: (v) => { d.description = v; refreshPreview(); } }),
      fieldText('Nom de l’auteur', d.authorName, { max: 256, onInput: (v) => { d.authorName = v; refreshPreview(); } }),
      fieldText('Pied de page', d.footerText, { max: 2048, onInput: (v) => { d.footerText = v; refreshPreview(); } }),
      imageField('image', 'Grande image'),
      imageField('thumbnail', 'Miniature'),
      h('h3', { text: `Champs (${d.fields.length}/${MAX_FIELDS})` }),
      ...fieldRows,
      d.fields.length < MAX_FIELDS
        ? h('div', { class: 'actions' }, button('Ajouter un champ', async () => {
            d.fields.push({ name: 'Titre du champ', value: 'Valeur', inline: false });
            rerender();
          }))
        : null,
      h(
        'div',
        { class: 'actions' },
        button('Enregistrer le brouillon', async () => {
          const res = await api('PUT', gp('/embed/draft'), d);
          S.data.modules.embed = res.config;
          S.embedDraft = normalizeDraft(res.config.draft);
          toast('Brouillon enregistré.');
          rerender();
        }, { cls: 'primary' }),
        button('Vider le brouillon', async () => {
          if (!confirm('Vider le brouillon en cours (non enregistré) ?')) return;
          S.embedDraft = normalizeDraft({});
          rerender();
        }, { cls: 'danger' }),
      ),
    );

    // Modèles
    const nameInput = h('input', { type: 'text', maxlength: 60, placeholder: 'Nom du modèle' });
    const tplList = Object.entries(templates).map(([id, tpl]) =>
      h(
        'div',
        { class: 'item' },
        h('div', { class: 'grow' }, h('strong', { text: tpl.name })),
        h(
          'div',
          { class: 'tools' },
          button('Charger', async () => {
            S.embedDraft = normalizeDraft(tpl.data);
            toast('Modèle chargé. Enregistre le brouillon pour le garder.');
            rerender();
          }, { cls: 'small' }),
          button('Supprimer', async () => {
            if (!confirm(`Supprimer le modèle « ${tpl.name} » ?`)) return;
            const res = await api('DELETE', gp(`/embed/templates/${encodeURIComponent(id)}`));
            S.data.modules.embed = res.config;
            toast('Modèle supprimé.');
            rerender();
          }, { cls: 'danger small' }),
        ),
      ),
    );
    const templatesCard = h(
      'div',
      { class: 'card' },
      h('h2', { text: `Modèles (${Object.keys(templates).length}/10)` }),
      tplList.length ? tplList : h('p', { class: 'muted', text: 'Aucun modèle enregistré.' }),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'field' }, nameInput),
        button('Enregistrer comme modèle', async () => {
          const res = await api('POST', gp('/embed/templates'), { name: nameInput.value, draft: d });
          S.data.modules.embed = res.config;
          toast('Modèle enregistré.');
          rerender();
        }),
      ),
    );

    // Envoi
    let channelId = '';
    const sendCard = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Envoyer' }),
      fieldChannel('Salon', null, TEXT_KINDS, (v) => (channelId = v ?? ''), 'L’embed est enregistré puis envoyé dans ce salon.'),
      h(
        'div',
        { class: 'actions' },
        button('Envoyer l’embed', async () => {
          if (!channelId) throw new Error('Choisis un salon.');
          await api('PUT', gp('/embed/draft'), d);
          await api('POST', gp('/embed/send'), { channelId });
          toast('Embed envoyé.');
        }, { cls: 'primary' }),
      ),
    );

    const previewCard = h('div', { class: 'card card-preview' }, h('h2', { text: 'Aperçu' }), h('p', { class: 'hint', text: 'Rendu simplifié : la mise en forme Markdown de Discord n’est pas reproduite.' }), previewBox);

    return h(
      'section',
      null,
      pageHead('🧩 Créateur d’embed', 'Construis l’embed, enregistre-le en modèle, puis envoie-le dans un salon.'),
      h('div', { class: 'two' }, h('div', null, editor, templatesCard), h('div', null, previewCard, sendCard)),
    );
  }

  // -------------------------------------------------------------------------
  // Logs : réglages par catégorie et journal consultable
  // -------------------------------------------------------------------------

  const LOG_PAGE = 50;
  const CATEGORY_LABEL = (key) => (S.data.logCategories || []).find((c) => c.key === key)?.label ?? key;

  function channelNameOf(id) {
    if (!id) return null;
    const c = (S.data.meta.channels || []).find((x) => x.id === id);
    return c ? `#${c.name}` : 'salon supprimé';
  }

  function viewLogs() {
    const cfg = clone(S.data.modules.logs);
    const cats = S.data.logCategories || [];
    const categoryCards = cats.map((cat) =>
      h(
        'div',
        { class: 'cat-row' },
        h('div', { class: 'cat-title', text: `${cat.emoji} ${cat.label}` }),
        fieldSwitch('Activée', null, cfg.categories[cat.key], (v) => (cfg.categories[cat.key] = v)),
        fieldChannel(
          'Salon dédié',
          cfg.channels[cat.key],
          TEXT_KINDS,
          (v) => (cfg.channels[cat.key] = v),
          null,
          '— Salon par défaut —',
        ),
      ),
    );

    // Journal : filtre, pages successives
    const listBox = h('div', { class: 'log-list' }, h('p', { class: 'muted', text: 'Chargement…' }));
    const moreBox = h('div', { class: 'actions' });
    let category = '';
    let nextBefore = null;
    let loadedRows = 0;

    const renderRows = (rows, append) => {
      if (!append) listBox.replaceChildren();
      if (!rows.length && !append) {
        listBox.append(h('p', { class: 'muted', text: 'Aucun événement pour le moment.' }));
        return;
      }
      for (const r of rows) listBox.append(logRow(r));
    };
    const load = async (append = false) => {
      const params = new URLSearchParams({ limit: String(LOG_PAGE) });
      if (category) params.set('category', category);
      if (append && nextBefore) params.set('before', nextBefore);
      const res = await api('GET', `${gp('/logs')}?${params.toString()}`);
      loadedRows = append ? loadedRows + res.rows.length : res.rows.length;
      nextBefore = res.nextBefore;
      renderRows(res.rows, append);
      moreBox.replaceChildren(
        nextBefore ? button('Charger plus', () => load(true)) : h('span', { class: 'hint', text: loadedRows ? 'Fin du journal affiché.' : '' }),
      );
    };
    const filter = h(
      'select',
      {
        'aria-label': 'Filtrer par catégorie',
        onchange: async (e) => {
          category = e.target.value;
          listBox.replaceChildren(h('p', { class: 'muted', text: 'Chargement…' }));
          try {
            await load(false);
          } catch (err) {
            toast(err.message, false);
          }
        },
      },
      [h('option', { value: '', text: 'Toutes les catégories' }), ...cats.map((c) => h('option', { value: c.key, text: `${c.emoji} ${c.label}` }))],
    );
    setTimeout(() => load(false).catch((err) => listBox.replaceChildren(h('p', { class: 'error', text: err.message }))), 0);

    return h(
      'section',
      null,
      pageHead('📜 Logs', 'Journal détaillé du serveur : messages, membres, vocal, salons, rôles et modération.'),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Réglages' }),
        fieldSwitch('Journal activé', 'Les événements sont enregistrés (30 jours) et envoyés dans les salons choisis.', cfg.enabled, (v) => (cfg.enabled = v)),
        fieldChannel('Salon par défaut', cfg.channelId, TEXT_KINDS, (v) => (cfg.channelId = v), 'Reçoit les catégories qui n’ont pas de salon dédié. Sans salon, les événements restent consultables ici.'),
        h('div', { class: 'cat-grid' }, categoryCards),
        fieldChecks(
          'Salons ignorés',
          channelsOf([CH.TEXT, CH.ANNOUNCE, CH.FORUM]).map((c) => ({ id: c.id, label: channelLabel(c) })),
          cfg.ignoredChannelIds,
          (v) => (cfg.ignoredChannelIds = v),
          'Les messages et événements vocaux de ces salons ne sont pas journalisés.',
        ),
        saveButton(() =>
          saveModule('logs', {
            enabled: cfg.enabled,
            channelId: cfg.channelId,
            categories: cfg.categories,
            channels: cfg.channels,
            ignoredChannelIds: cfg.ignoredChannelIds,
          }),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'page-head' }, h('h2', { text: 'Journal' }), h('div', { class: 'field filter' }, filter)),
        listBox,
        moreBox,
      ),
    );
  }

  function logRow(r) {
    const who = [];
    if (r.actorId) who.push(`Par ${r.actorName ?? r.actorId}`);
    if (r.targetId && r.targetId !== r.actorId) who.push(`Cible ${r.targetName ?? r.targetId}`);
    const channel = r.channelId ? channelNameOf(r.channelId) : null;
    return h(
      'article',
      { class: 'log-row' },
      h(
        'div',
        { class: 'log-head' },
        h('time', { class: 'muted small', datetime: r.createdAt, text: fmtDate(r.createdAt) }),
        h('span', { class: 'pill', text: CATEGORY_LABEL(r.category) }),
        h('strong', { text: r.title }),
      ),
      r.description ? h('div', { class: 'log-desc', text: r.description }) : null,
      h('div', { class: 'small muted', text: [who.join(' · '), channel ? `Salon ${channel}` : null].filter(Boolean).join(' · ') }),
    );
  }

  // -------------------------------------------------------------------------
  // Modération : rôles par commande, MP au membre, avertissements
  // -------------------------------------------------------------------------

  function viewModeration() {
    const cfg = clone(S.data.modules.moderation);
    cfg.roles = cfg.roles || {};
    const commands = S.data.moderationCommands || [];
    const rolesCount = (key) => (cfg.roles[key] || []).length;

    const commandBlocks = commands.map((c) =>
      h(
        'details',
        { class: 'cmd-block' },
        h(
          'summary',
          null,
          h('strong', { text: `/${c.key}` }),
          h('span', { class: 'muted', text: ` · ${c.label}` }),
          h('span', { class: rolesCount(c.key) ? 'pill on' : 'pill', text: rolesCount(c.key) ? `${rolesCount(c.key)} rôle(s)` : 'permission Discord' }),
        ),
        h('p', { class: 'hint', text: `Sans rôle choisi, la commande demande la permission Discord « ${c.permission} ».` }),
        fieldChecks(
          'Rôles autorisés',
          roleItems(),
          cfg.roles[c.key] || [],
          (v) => (cfg.roles[c.key] = v),
          'Les administrateurs et le propriétaire peuvent toujours utiliser la commande.',
        ),
      ),
    );

    // Avertissements
    const warnBox = h('div', { class: 'table-wrap' }, h('p', { class: 'muted', text: 'Chargement…' }));
    let userFilter = '';
    const loadWarnings = async () => {
      const path = userFilter ? `/warnings?user=${encodeURIComponent(userFilter)}` : '/warnings';
      const { rows } = await api('GET', gp(path));
      if (!rows.length) {
        warnBox.replaceChildren(h('p', { class: 'muted', text: 'Aucun avertissement.' }));
        return;
      }
      warnBox.replaceChildren(
        h(
          'div',
          { class: 'warn-list' },
          rows.map((w) =>
            h(
              'div',
              { class: 'item' },
              h(
                'div',
                { class: 'grow' },
                h('div', null, h('strong', { text: `#${w.id} · ${w.userName ?? w.userId}` }), h('span', { class: 'muted small', text: ` · ${fmtDate(w.createdAt)} · par ${w.moderatorName ?? w.moderatorId}` })),
                h('div', { class: 'small', text: w.reason }),
              ),
              h(
                'div',
                { class: 'tools' },
                button(
                  'Retirer',
                  async () => {
                    if (!confirm(`Retirer l’avertissement #${w.id} ?`)) return;
                    await api('DELETE', gp(`/warnings/${w.id}`));
                    toast('Avertissement retiré.');
                    await loadWarnings();
                  },
                  { cls: 'danger small' },
                ),
              ),
            ),
          ),
        ),
      );
    };
    const applyFilter = async () => {
      userFilter = userInput.value.trim();
      await loadWarnings();
    };
    const userInput = h('input', {
      type: 'text',
      placeholder: 'ID du membre (vide = tout le serveur)',
      'aria-label': 'Filtrer par identifiant de membre',
      onkeydown: (e) => {
        if (e.key === 'Enter') applyFilter().catch((err) => toast(err.message, false));
      },
    });
    setTimeout(() => loadWarnings().catch((err) => warnBox.replaceChildren(h('p', { class: 'error', text: err.message }))), 0);

    return h(
      'section',
      null,
      pageHead('🛡️ Modération', 'Commandes de sanction. Chaque commande a ses propres rôles autorisés.'),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Réglages' }),
        fieldSwitch('Commandes de modération activées', null, cfg.enabled, (v) => (cfg.enabled = v)),
        fieldSwitch('Envoyer un MP au membre sanctionné', 'Le texte ci-dessous est envoyé avant la sanction.', cfg.notifyTarget, (v) => (cfg.notifyTarget = v)),
        fieldText('Texte du MP', cfg.texts?.dm ?? '', {
          max: 500,
          multiline: true,
          hint: 'Variables : {action}, {server}, {reason}, {duration}. Laisse vide pour ne rien envoyer.',
          onInput: (v) => {
            cfg.texts = { ...(cfg.texts || {}), dm: v };
          },
        }),
        saveButton(() =>
          saveModule('moderation', {
            enabled: cfg.enabled,
            notifyTarget: cfg.notifyTarget,
            texts: { dm: cfg.texts?.dm ?? '' },
            roles: cfg.roles,
          }),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Rôles par commande' }),
        h('p', { class: 'hint', text: 'Ouvre une commande pour choisir les rôles qui peuvent l’utiliser.' }),
        commandBlocks,
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Avertissements' }),
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'field' }, userInput),
          button('Filtrer', applyFilter),
          button('Tout afficher', async () => {
            userFilter = '';
            userInput.value = '';
            await loadWarnings();
          }),
        ),
        warnBox,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Sécurité : anti-raid, anti-nuke, verrouillage, liste blanche (modifiable)
  // -------------------------------------------------------------------------

  const NUKE_LABEL = {
    channelDelete: 'Salons supprimés',
    roleDelete: 'Rôles supprimés',
    channelCreate: 'Salons créés',
    ban: 'Bannissements',
    kick: 'Expulsions',
  };

  // Nombre entier : la valeur est transmise telle quelle, le serveur vérifie les bornes.
  function fieldNumber(label, value, { min, max, hint, onInput } = {}) {
    const input = h('input', {
      type: 'number',
      min,
      max,
      step: 1,
      value: String(value ?? ''),
      oninput: (e) => onInput(Number(e.target.value)),
    });
    return wrapField(label, input, hint);
  }

  function viewSecurity() {
    // Copie de travail : les champs la modifient, « Enregistrer » l'envoie.
    const d = clone(S.data.modules.security);
    const locked = Boolean(d.lockdown?.active);
    const lockStatus = locked
      ? h('span', { class: 'pill warn', text: `Verrouillé depuis ${fmtDate(d.lockdown.since)}` })
      : h('span', { class: 'pill on', text: 'Serveur ouvert' });

    const lockButton = locked
      ? button(
          'Lever le verrouillage',
          async () => {
            const res = await api('POST', gp('/security/unlock'));
            S.data.modules.security = res.config;
            toast('Verrouillage levé.');
            rerender();
          },
          { cls: 'primary' },
        )
      : button(
          'Verrouiller maintenant',
          async () => {
            if (!confirm('Verrouiller le serveur ? Le niveau de vérification sera relevé jusqu’à la levée manuelle.')) return;
            const res = await api('POST', gp('/security/lock'));
            S.data.modules.security = res.config;
            toast('Serveur verrouillé.');
            rerender();
          },
          { cls: 'danger' },
        );

    const saveAll = () =>
      saveModule(
        'security',
        {
          raid: d.raid,
          nuke: d.nuke,
          alertChannelId: d.alertChannelId,
          whitelistUserIds: d.whitelistUserIds,
          whitelistRoleIds: d.whitelistRoleIds,
        },
        'Sécurité enregistrée.',
      );

    return h(
      'section',
      null,
      pageHead('Sécurité', 'Anti-raid, anti-nuke, verrouillage et liste blanche. Enregistré, le réglage s’applique tout de suite.'),
      h(
        'div',
        { class: 'grid' },
        h(
          'div',
          { class: 'card' },
          h('h2', { text: 'Anti-raid' }),
          h('p', { class: 'hint', text: 'Si trop de comptes arrivent en peu de temps, le niveau de vérification passe à « élevé ». La levée est manuelle.' }),
          fieldSwitch('Activer l’anti-raid', null, d.raid.enabled, (v) => (d.raid.enabled = v)),
          fieldNumber('Arrivées déclenchant le verrouillage (2 à 100)', d.raid.joinThreshold, { min: 2, max: 100, onInput: (v) => (d.raid.joinThreshold = v) }),
          fieldNumber('Fenêtre en secondes (5 à 120)', d.raid.windowSeconds, { min: 5, max: 120, onInput: (v) => (d.raid.windowSeconds = v) }),
        ),
        h(
          'div',
          { class: 'card' },
          h('h2', { text: 'Verrouillage' }),
          h('p', null, lockStatus),
          h('p', { class: 'hint', text: 'Un verrouillage n’est jamais restauré depuis une sauvegarde. Les modifications non enregistrées sont perdues si tu verrouilles ou lèves le verrouillage avant.' }),
          h('div', { class: 'actions' }, lockButton),
        ),
        h(
          'div',
          { class: 'card' },
          h('h2', { text: 'Anti-nuke' }),
          h('p', { class: 'hint', text: 'Au-delà des seuils, l’auteur perd ses rôles à risque, puis il est banni.' }),
          fieldSwitch('Activer l’anti-nuke', null, d.nuke.enabled, (v) => (d.nuke.enabled = v)),
          fieldNumber('Fenêtre en secondes (5 à 120)', d.nuke.windowSeconds, { min: 5, max: 120, onInput: (v) => (d.nuke.windowSeconds = v) }),
          ...Object.keys(NUKE_LABEL).map((k) =>
            fieldNumber(`${NUKE_LABEL[k]} (1 à 50)`, d.nuke.limits[k], { min: 1, max: 50, onInput: (v) => (d.nuke.limits[k] = v) }),
          ),
        ),
        h(
          'div',
          { class: 'card' },
          h('h2', { text: 'Alertes et liste blanche' }),
          fieldChannel(
            'Salon d’alerte',
            d.alertChannelId,
            TEXT_KINDS,
            (v) => (d.alertChannelId = v),
            'Sans salon, les alertes sont envoyées en MP au propriétaire.',
            'Aucun (MP au propriétaire)',
          ),
          fieldText('Membres de confiance (identifiants, un par ligne)', d.whitelistUserIds.join('\n'), {
            multiline: true,
            hint: 'Ignorés par l’anti-nuke. Le propriétaire et le bot le sont toujours.',
            onInput: (v) => (d.whitelistUserIds = v.split(/[\s,;]+/).filter(Boolean)),
          }),
          fieldChecks('Rôles de confiance', roleItems(), d.whitelistRoleIds, (v) => (d.whitelistRoleIds = v), 'Les membres ayant l’un de ces rôles sont ignorés par l’anti-nuke.'),
        ),
      ),
      saveButton(saveAll, 'Enregistrer la sécurité'),
    );
  }

  // -------------------------------------------------------------------------
  // Rôles par réaction : panneaux, rôles emoji → rôle, publication (modifiable)
  // -------------------------------------------------------------------------

  function viewReactionRoles() {
    const panels = S.data.modules.reaction_roles.panels || [];
    const roleOptions = [{ value: '', label: '— Choisir un rôle —' }, ...roleItems().map((r) => ({ value: r.id, label: r.label }))];

    // Chaque action renvoie la configuration à jour et le message Discord est mis à jour côté bot.
    const applyPanels = (res, message) => {
      S.data.modules.reaction_roles = res.config;
      if (res.warning) toast(res.warning, false);
      else if (message) toast(message);
      rerender();
    };

    const created = { title: '', description: '', channelId: null };
    const createCard = h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Nouveau panneau' }),
      h('p', { class: 'hint', text: `Maximum 10 panneaux par serveur (${panels.length} actuellement).` }),
      fieldText('Titre', '', { max: 80, required: true, onInput: (v) => (created.title = v) }),
      fieldText('Texte d’introduction', '', { max: 800, multiline: true, onInput: (v) => (created.description = v) }),
      fieldChannel('Salon de publication', null, TEXT_KINDS, (v) => (created.channelId = v), 'Optionnel : tu peux le choisir plus tard.'),
      h(
        'div',
        { class: 'actions' },
        button(
          'Créer le panneau',
          async () => {
            const res = await api('POST', gp('/reaction-roles/panels'), created);
            applyPanels(res, 'Panneau créé. Ajoute des rôles, puis publie-le.');
          },
          { cls: 'primary' },
        ),
      ),
    );

    const panelCard = (p) => {
      const draft = { title: p.title, description: p.description ?? '', channelId: p.channelId ?? null };
      const pair = { emoji: '', roleId: '' };
      const pairsTable = (p.pairs || []).length
        ? h(
            'table',
            null,
            h('thead', null, h('tr', null, ...['Emoji', 'Rôle', ''].map((t) => h('th', { text: t })))),
            h(
              'tbody',
              null,
              p.pairs.map((x) =>
                h(
                  'tr',
                  null,
                  h('td', { text: x.display }),
                  h('td', { text: roleById(x.roleId)?.name ?? 'rôle supprimé' }),
                  h(
                    'td',
                    null,
                    button(
                      'Retirer',
                      async () => {
                        const res = await api('DELETE', gp(`/reaction-roles/panels/${p.id}/pairs/${encodeURIComponent(x.key)}`));
                        applyPanels(res, 'Rôle retiré. Les membres qui l’ont gardent leur rôle.');
                      },
                      { cls: 'danger small' },
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted', text: 'Aucun rôle dans ce panneau.' });

      return h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'page-head' },
          h('h2', { text: p.title }),
          h('span', { class: p.messageId ? 'pill on' : 'pill', text: p.messageId ? 'Publié' : 'Non publié' }),
        ),
        fieldText('Titre', draft.title, { max: 80, required: true, onInput: (v) => (draft.title = v) }),
        fieldText('Texte d’introduction', draft.description, { max: 800, multiline: true, onInput: (v) => (draft.description = v) }),
        fieldChannel(
          'Salon',
          draft.channelId,
          TEXT_KINDS,
          (v) => (draft.channelId = v),
          'Changer de salon supprime l’ancien message : il faudra publier de nouveau.',
        ),
        h(
          'div',
          { class: 'actions' },
          button(
            'Enregistrer',
            async () => {
              const res = await api('PUT', gp(`/reaction-roles/panels/${p.id}`), draft);
              applyPanels(res, 'Panneau enregistré.');
            },
            { cls: 'primary' },
          ),
          button(p.messageId ? 'Mettre à jour le message' : 'Publier dans le salon', async () => {
            const res = await api('POST', gp(`/reaction-roles/panels/${p.id}/publish`));
            applyPanels(res, 'Message publié.');
          }),
          button(
            'Supprimer le panneau',
            async () => {
              if (!confirm(`Supprimer le panneau « ${p.title} » et son message ? Les membres gardent les rôles déjà attribués.`)) return;
              const res = await api('DELETE', gp(`/reaction-roles/panels/${p.id}`));
              applyPanels(res, 'Panneau supprimé.');
            },
            { cls: 'danger' },
          ),
        ),
        h('h3', { text: 'Rôles du panneau' }),
        pairsTable,
        h(
          'div',
          { class: 'row' },
          fieldText('Emoji', '', { max: 60, placeholder: '🎮 ou emoji du serveur', onInput: (v) => (pair.emoji = v) }),
          fieldSelect('Rôle à donner', '', roleOptions, (v) => (pair.roleId = v)),
        ),
        h(
          'div',
          { class: 'actions' },
          button('Ajouter ce rôle', async () => {
            const res = await api('POST', gp(`/reaction-roles/panels/${p.id}/pairs`), pair);
            applyPanels(res, 'Rôle ajouté.');
          }),
        ),
      );
    };

    return h(
      'section',
      null,
      pageHead('Rôles par réaction', 'Réagir au message d’un panneau donne le rôle ; retirer la réaction le retire.'),
      createCard,
      panels.length ? panels.map(panelCard) : h('div', { class: 'card' }, h('p', { class: 'muted', text: 'Aucun panneau pour le moment.' })),
    );
  }

  // -------------------------------------------------------------------------
  // Sauvegardes : création, restauration (double confirmation), suivi des tâches
  // -------------------------------------------------------------------------

  const KIND_LABEL = { manual: 'Manuelle', daily: 'Quotidienne', pre_restore: 'Avant restauration' };

  function backupSummary(s = {}) {
    return `${s.roles ?? 0} rôle(s) · ${s.channels ?? 0} salon(s) · ${s.messages ?? 0} message(s) · ${s.modules ?? 0} module(s)`;
  }

  // Suivi d'une tâche de fond (sauvegarde ou restauration) jusqu'à sa fin.
  function watchJob(gid, jobId, label) {
    if (S.pollingJob === jobId) return;
    S.pollingJob = jobId;
    S.backupJob = jobId;
    S.backupNote = { ok: true, text: `${label} en cours…`, details: [] };
    const tick = async () => {
      if (S.gid !== gid) {
        S.pollingJob = null;
        return;
      }
      try {
        const { job } = await api('GET', `/api/guilds/${gid}/jobs/${jobId}`);
        if (job.status === 'running') {
          setTimeout(tick, 2000);
          return;
        }
        S.pollingJob = null;
        S.backupJob = null;
        if (job.status === 'done') {
          const r = job.result ?? {};
          const details = [];
          if (r.summary) details.push(`Contenu : ${backupSummary(r.summary)}.`);
          if (r.rolesCreated !== undefined) details.push(`Créés : ${r.rolesCreated} rôle(s), ${r.channelsCreated} salon(s). Messages republiés : ${r.messagesRestored}. Configurations : ${r.configsRestored}.`);
          if (r.safetyBackupId) details.push('Une sauvegarde de sécurité a été faite juste avant la restauration.');
          const errors = [...(r.errors ?? []), ...(r.skipped ?? [])];
          if (errors.length) details.push(`${errors.length} point(s) non restauré(s) ou ignoré(s) :`, ...errors.slice(0, 20));
          S.backupNote = { ok: true, text: `${label} terminée.`, details };
          toast(`${label} terminée.`);
          await loadGuild();
        } else {
          S.backupNote = { ok: false, text: job.error || `${label} échouée.`, details: [] };
          toast(job.error || `${label} échouée.`, false);
        }
      } catch (err) {
        S.pollingJob = null;
        S.backupJob = null;
        S.backupNote = { ok: false, text: err.message, details: [] };
      }
      if (currentPageId() === 'sauvegardes') rerender();
    };
    setTimeout(tick, 1500);
  }

  async function restoreBackupRow(row) {
    const ok = confirm(
      `Restaurer la sauvegarde du ${fmtDate(row.createdAt)} ?\n\n` +
        'Rien ne sera supprimé : les rôles et salons absents seront recréés, les messages du bot republiés et les configurations remises. ' +
        'Une sauvegarde de sécurité est faite avant.',
    );
    if (!ok) return;
    const typed = prompt(`Deuxième confirmation : tape exactement le nom du serveur, « ${S.data.guild.name} ».`);
    if (typed === null) return;
    const { job } = await api('POST', gp(`/backups/${row.id}/restore`), { confirmName: typed });
    watchJob(S.gid, job.id, 'Restauration');
    rerender();
  }

  function viewBackups() {
    const cfg = S.data.modules.backups;
    const box = h('div', { class: 'table-wrap' }, h('p', { class: 'muted', text: 'Chargement…' }));
    loadBackupList(box);

    const note = S.backupNote
      ? h(
          'div',
          { class: S.backupNote.ok ? 'card' : 'card warn-card' },
          h('p', { class: S.backupNote.ok ? 'ok' : 'error', text: S.backupNote.text }),
          S.backupNote.details?.length ? h('ul', { class: 'small' }, S.backupNote.details.map((d) => h('li', { text: d }))) : null,
        )
      : null;

    return h(
      'section',
      null,
      pageHead('Sauvegardes', 'Création et restauration uniquement depuis ce tableau de bord. Les 7 sauvegardes les plus récentes sont conservées.'),
      note,
      h(
        'div',
        { class: 'card' },
        fieldSwitch(
          'Sauvegarde quotidienne',
          'Une sauvegarde par jour et par serveur. Contenu : rôles, salons et permissions, configurations des modules, messages du bot (30 au plus par salon).',
          cfg.enabled,
          (v) => saveModule('backups', { enabled: v }, 'Réglage enregistré.'),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Créer une sauvegarde' }),
        h('p', { class: 'hint', text: 'Peut prendre quelques dizaines de secondes sur un gros serveur.' }),
        h(
          'div',
          { class: 'actions' },
          button(
            'Créer une sauvegarde maintenant',
            async () => {
              if (S.backupJob) throw new Error('Une tâche est déjà en cours.');
              const { job } = await api('POST', gp('/backups'));
              watchJob(S.gid, job.id, 'Sauvegarde');
              rerender();
            },
            { cls: 'primary' },
          ),
        ),
      ),
      h('div', { class: 'card' }, h('h2', { text: 'Sauvegardes existantes' }), box),
    );
  }

  async function loadBackupList(box) {
    try {
      const { rows, running } = await api('GET', gp('/backups'));
      if (running && S.pollingJob !== running.id) watchJob(S.gid, running.id, running.type === 'restore' ? 'Restauration' : 'Sauvegarde');
      if (!rows.length) {
        box.replaceChildren(h('p', { class: 'muted', text: 'Aucune sauvegarde pour le moment.' }));
        return;
      }
      const busy = Boolean(S.backupJob);
      box.replaceChildren(
        h(
          'table',
          null,
          h('thead', null, h('tr', null, ...['Date', 'Type', 'Contenu', ''].map((t) => h('th', { text: t })))),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                null,
                h('td', { text: fmtDate(r.createdAt) }),
                h('td', { text: KIND_LABEL[r.kind] ?? r.kind }),
                h('td', { text: backupSummary(r.summary) }),
                h(
                  'td',
                  null,
                  button('Restaurer', () => restoreBackupRow(r), { cls: 'danger', title: 'Restaure rôles, salons, configurations et messages (rien n’est supprimé)' }),
                ),
              ),
            ),
          ),
        ),
        h('p', { class: 'hint', text: busy ? 'Une tâche est en cours, patiente avant de lancer une autre action.' : `${rows.length} sauvegarde(s) affichée(s) · 7 conservées au maximum.` }),
      );
    } catch (err) {
      box.replaceChildren(h('p', { class: 'error', text: err.message }));
    }
  }
  // -------------------------------------------------------------------------
  // Démarrage
  // -------------------------------------------------------------------------

  boot().catch((err) => showMessage('Erreur', err.message, true));
})();
