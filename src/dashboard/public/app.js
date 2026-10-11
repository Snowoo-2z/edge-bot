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
    { id: 'ia', label: 'IA (Mistral)', icon: '🤖', module: 'ai', desc: 'Réponses du bot : prompt, abréviations, nœuds par mots-clés.' },
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
  // IA (Mistral) : prompt système, abréviations, nœuds déclenchés par mots-clés
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
  const AI_MAX_NODES = 50;

  // Brouillon gardé dans S : ajouter ou supprimer une ligne ne fait pas perdre les autres saisies.
  function aiDraft() {
    if (!S.aiDraft || S.aiDraft.gid !== S.gid) {
      const cfg = clone(S.data.modules.ai) ?? {};
      cfg.abbreviations = cfg.abbreviations ?? [];
      cfg.nodes = cfg.nodes ?? [];
      cfg.channelIds = cfg.channelIds ?? [];
      S.aiDraft = { gid: S.gid, cfg };
    }
    return S.aiDraft.cfg;
  }

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

  function viewAi() {
    const d = aiDraft();
    const test = S.aiTest ?? null;

    const save = async () => {
      const payload = {
        enabled: d.enabled,
        model: d.model,
        systemPrompt: d.systemPrompt,
        temperature: d.temperature,
        maxReplyTokens: d.maxReplyTokens,
        channelIds: d.channelIds,
        cooldownSeconds: d.cooldownSeconds,
        abbreviations: d.abbreviations,
        nodes: d.nodes,
      };
      const res = await api('PUT', gp('/modules/ai'), payload);
      S.data.modules.ai = res.config;
      S.aiDraft = null;
      toast('Module IA enregistré.');
      rerender();
    };

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
      toast(`${added} abréviation(s) ajoutée(s). Pense à enregistrer.`);
      rerender();
    };

    const nodeCards = d.nodes.map((n, i) =>
      h(
        'div',
        null,
        h(
          'div',
          { class: 'node' },
          h(
            'div',
            { class: 'page-head' },
            h('strong', { text: `Nœud ${i + 1} · ${n.label || (n.keywords ?? [])[0] || 'sans nom'}` }),
            h(
              'div',
              { class: 'actions' },
              button(
                '↑',
                async () => {
                  if (i === 0) return;
                  [d.nodes[i - 1], d.nodes[i]] = [d.nodes[i], d.nodes[i - 1]];
                  rerender();
                },
                { cls: 'small', title: 'Monter' },
              ),
              button(
                '↓',
                async () => {
                  if (i >= d.nodes.length - 1) return;
                  [d.nodes[i + 1], d.nodes[i]] = [d.nodes[i], d.nodes[i + 1]];
                  rerender();
                },
                { cls: 'small', title: 'Descendre' },
              ),
              button(
                'Supprimer',
                async () => {
                  d.nodes.splice(i, 1);
                  rerender();
                },
                { cls: 'danger small' },
              ),
            ),
          ),
          fieldSwitch('Nœud actif', null, n.enabled !== false, (v) => (n.enabled = v)),
          fieldText('Nom du nœud (facultatif)', n.label ?? '', { max: 60, onInput: (v) => (n.label = v) }),
          fieldText('Déclencheur : mots-clés (séparés par des virgules)', (n.keywords ?? []).join(', '), {
            max: 1000,
            hint: 'Mot entier : « bug » ne déclenche pas « bugs ». Accents et majuscules sont ignorés.',
            onInput: (v) => (n.keywords = v.split(',').map((s) => s.trim()).filter(Boolean)),
          }),
          fieldText('Action : consigne ajoutée au prompt', n.instruction ?? '', {
            max: 500,
            multiline: true,
            required: true,
            hint: 'Ajoutée au prompt système uniquement pour les messages qui déclenchent ce nœud.',
            onInput: (v) => (n.instruction = v),
          }),
        ),
        i < d.nodes.length - 1 ? h('div', { class: 'node-arrow', text: '↓' }) : null,
      ),
    );

    let resultBlock = null;
    if (test?.kind === 'preview') {
      resultBlock = h(
        'div',
        { class: 'card' },
        h('h3', { text: 'Prompt système final (version enregistrée)' }),
        h('p', {
          class: 'hint',
          text: test.matched.length
            ? `Nœuds déclenchés : ${test.matched.map((m) => m.label).join(', ')}`
            : 'Aucun nœud déclenché par ce message.',
        }),
        h('pre', { class: 'ai-pre', text: test.system }),
      );
    } else if (test?.kind === 'reply') {
      resultBlock = h(
        'div',
        { class: 'card' },
        h('h3', { text: 'Réponse de Mistral' }),
        h('p', { class: 'ai-pre', text: test.text }),
      );
    }

    return h(
      'section',
      null,
      pageHead(
        '🤖 IA (Mistral)',
        'Le bot répond avec Ministral 14B. Prompt, abréviations et nœuds se règlent ici ; enregistre avant de tester.',
      ),
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
          channelsOf(TEXT_KINDS).map((c) => ({ id: c.id, label: channelLabel(c) })),
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
              rerender();
            },
            { cls: 'primary' },
          ),
        ),
        h('h3', { text: 'Ajout en lot' }),
        fieldText('Une par ligne : abréviation = signification', S.aiBulk ?? '', {
          max: 5000,
          multiline: true,
          onInput: (v) => (S.aiBulk = v),
        }),
        h('div', { class: 'actions' }, button('Ajouter ces lignes', addBulk)),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: `Nœuds (${d.nodes.length} / ${AI_MAX_NODES})` }),
        h('p', {
          class: 'hint',
          text: 'Un nœud = un déclencheur (mots-clés) → une action (consigne ajoutée au prompt). Ils s’appliquent dans l’ordre.',
        }),
        d.nodes.length ? h('div', null, nodeCards) : h('p', { class: 'muted', text: 'Aucun nœud pour le moment.' }),
        h(
          'div',
          { class: 'actions' },
          button(
            'Ajouter un nœud',
            async () => {
              if (d.nodes.length >= AI_MAX_NODES) throw new Error(`${AI_MAX_NODES} nœuds maximum.`);
              d.nodes.push({ enabled: true, label: '', keywords: [], instruction: '' });
              rerender();
            },
            { cls: 'primary' },
          ),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { text: 'Tester' }),
        fieldText('Message d’exemple', S.aiTestInput ?? '', {
          max: 500,
          onInput: (v) => (S.aiTestInput = v),
        }),
        h(
          'div',
          { class: 'actions' },
          button('Voir le prompt final', async () => {
            const res = await api('POST', gp('/ai/preview'), { message: S.aiTestInput ?? '' });
            S.aiTest = { kind: 'preview', ...res };
            rerender();
          }),
          button('Tester avec Mistral (consomme des tokens)', async () => {
            const res = await api('POST', gp('/ai/test'), { message: S.aiTestInput ?? '' });
            S.aiTest = { kind: 'reply', text: res.reply };
            rerender();
          }),
        ),
        resultBlock,
      ),
      saveButton(save, 'Enregistrer le module IA'),
    );
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
