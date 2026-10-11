// Stockage persistant dans Supabase.
//  - Réglages : table "edge_module_configs" (une ligne par serveur et par module, colonne jsonb).
//  - Images / GIF : bucket "edge-assets" (Supabase Storage, lecture publique).
//
// Le client utilise la clé "service role" (variable SUPABASE_SERVICE_ROLE_KEY) : elle contourne
// la RLS, donc elle ne doit JAMAIS être exposée côté client ni committée dans Git.
//
// Les réglages sont chargés en mémoire au démarrage (init) ; les lectures sont donc synchrones,
// et chaque écriture est répercutée dans Supabase en arrière-plan (file d'attente par clé).

const { createClient } = require('@supabase/supabase-js');

const TABLE = 'edge_module_configs';
const BUCKET = 'edge-assets';

let supabase = null;
const cache = new Map(); // "guildId:module" -> config
const writeQueues = new Map(); // "guildId:module" -> Promise (écritures sérialisées)

function requireEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définis (variables d’environnement).');
  }
  return { url, key };
}

// À appeler une fois au démarrage, avant de se connecter à Discord.
async function init() {
  const { url, key } = requireEnv();
  supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await supabase.from(TABLE).select('guild_id, module, config');
  if (error) throw new Error(`Lecture Supabase impossible (table ${TABLE}) : ${error.message}`);
  for (const row of data) cache.set(`${row.guild_id}:${row.module}`, row.config ?? {});
  console.log(`[store] ${data.length} configuration(s) chargée(s) depuis Supabase.`);
}

function getModuleConfig(guildId, moduleId, defaults) {
  const key = `${guildId}:${moduleId}`;
  const current = cache.get(key) ?? {};
  const merged = { ...structuredClone(defaults), ...current };
  merged.texts = { ...structuredClone(defaults.texts ?? {}), ...(current.texts ?? {}) };
  merged.assets = { ...structuredClone(defaults.assets ?? {}), ...(current.assets ?? {}) };
  merged.open = current.open ?? {};
  cache.set(key, merged);
  return merged;
}

function getGuildModule(guildId, moduleId) {
  return cache.get(`${guildId}:${moduleId}`) ?? null;
}

function updateModuleConfig(guildId, moduleId, cfg) {
  const key = `${guildId}:${moduleId}`;
  cache.set(key, cfg);
  enqueueWrite(key, guildId, moduleId, structuredClone(cfg));
  return cfg;
}

function enqueueWrite(key, guildId, moduleId, snapshot) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    const { error } = await supabase.from(TABLE).upsert(
      { guild_id: guildId, module: moduleId, config: snapshot, updated_at: new Date().toISOString() },
      { onConflict: 'guild_id,module' },
    );
    if (error) console.error(`[store] écriture Supabase échouée (${key}) :`, error.message);
  });
  writeQueues.set(key, next);
}

// ---------------------------------------------------------------------------
// Fichiers (images / GIF)
// ---------------------------------------------------------------------------

// Envoie le fichier dans le bucket et retourne son URL publique.
async function uploadAsset(path, buffer, contentType) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Upload Supabase échoué : ${error.message}`);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function deleteAsset(path) {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) console.error('[store] suppression fichier échouée :', error.message);
}

// ---------------------------------------------------------------------------
// Niveaux (XP et temps vocal) : table "edge_levels", une ligne par membre et par serveur.
// ---------------------------------------------------------------------------

const LEVELS_TABLE = 'edge_levels';
const PAGE_SIZE = 1000; // limite par défaut de PostgREST (Supabase)

// Charge toutes les lignes, page par page.
async function loadLevelRows() {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(LEVELS_TABLE)
      .select('guild_id, user_id, xp, voice_seconds')
      .order('guild_id', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Lecture Supabase impossible (table ${LEVELS_TABLE}) : ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

// Enregistre des lignes (insertion ou mise à jour), par lots de 500.
async function saveLevelRows(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from(LEVELS_TABLE).upsert(chunk, { onConflict: 'guild_id,user_id' });
    if (error) throw new Error(`Écriture Supabase échouée (${LEVELS_TABLE}) : ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Suggestions : table "edge_suggestions", une ligne par suggestion.
// ---------------------------------------------------------------------------

const SUGGESTIONS_TABLE = 'edge_suggestions';

// Suggestions encore ouvertes (vote non terminé).
async function loadOpenSuggestions() {
  const { data, error } = await supabase.from(SUGGESTIONS_TABLE).select('*').eq('closed', false);
  if (error) throw new Error(`Lecture Supabase impossible (table ${SUGGESTIONS_TABLE}) : ${error.message}`);
  return data ?? [];
}

// Enregistre (ou met à jour) une suggestion.
async function saveSuggestion(row) {
  const { error } = await supabase.from(SUGGESTIONS_TABLE).upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`Écriture Supabase échouée (${SUGGESTIONS_TABLE}) : ${error.message}`);
}

// ---------------------------------------------------------------------------
// Giveaways : table "edge_giveaways", une ligne par tirage au sort.
// ---------------------------------------------------------------------------

const GIVEAWAYS_TABLE = 'edge_giveaways';

// Giveaways encore en cours (non terminés).
async function loadOpenGiveaways() {
  const { data, error } = await supabase.from(GIVEAWAYS_TABLE).select('*').eq('ended', false);
  if (error) throw new Error(`Lecture Supabase impossible (table ${GIVEAWAYS_TABLE}) : ${error.message}`);
  return data ?? [];
}

// Enregistre (ou met à jour) un giveaway.
async function saveGiveaway(row) {
  const { error } = await supabase.from(GIVEAWAYS_TABLE).upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`Écriture Supabase échouée (${GIVEAWAYS_TABLE}) : ${error.message}`);
}

// ---------------------------------------------------------------------------
// Journal (module logs) : une ligne par événement, purgée après 30 jours.
// ---------------------------------------------------------------------------
const LOGS_TABLE = 'edge_logs';
const LOG_SELECT = 'id, category, event, title, description, actor_id, target_id, channel_id, created_at';

async function insertLogs(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(LOGS_TABLE).insert(rows.slice(i, i + 500));
    if (error) throw new Error(`Écriture Supabase échouée (${LOGS_TABLE}) : ${error.message}`);
  }
}

// Page de journal, la plus récente d'abord. `before` = created_at ISO de la dernière ligne vue.
async function loadLogs({ guildId, category = null, before = null, limit = 50 }) {
  let query = supabase
    .from(LOGS_TABLE)
    .select(LOG_SELECT)
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (category) query = query.eq('category', category);
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) throw new Error(`Lecture Supabase échouée (${LOGS_TABLE}) : ${error.message}`);
  return data ?? [];
}

async function pruneLogs(olderThanIso) {
  const { error } = await supabase.from(LOGS_TABLE).delete().lt('created_at', olderThanIso);
  if (error) throw new Error(`Purge Supabase échouée (${LOGS_TABLE}) : ${error.message}`);
}

// ---------------------------------------------------------------------------
// Avertissements (commandes /warn, /warnings, /unwarn).
// ---------------------------------------------------------------------------
const WARNINGS_TABLE = 'edge_warnings';
const WARNING_SELECT = 'id, user_id, moderator_id, reason, created_at';

async function addWarning(row) {
  const { data, error } = await supabase.from(WARNINGS_TABLE).insert(row).select(WARNING_SELECT).single();
  if (error) throw new Error(`Écriture Supabase échouée (${WARNINGS_TABLE}) : ${error.message}`);
  return data;
}

// Avertissements d'un membre (userId) ou de tout le serveur (userId omis), les plus récents d'abord.
async function loadWarnings(guildId, userId = null, limit = 200) {
  let query = supabase
    .from(WARNINGS_TABLE)
    .select(WARNING_SELECT)
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw new Error(`Lecture Supabase échouée (${WARNINGS_TABLE}) : ${error.message}`);
  return data ?? [];
}

// Supprime un avertissement du serveur. Retourne la ligne supprimée (user_id, reason…), ou null.
async function deleteWarning(guildId, id) {
  const { data, error } = await supabase
    .from(WARNINGS_TABLE)
    .delete()
    .eq('guild_id', guildId)
    .eq('id', id)
    .select(WARNING_SELECT + ', guild_id');
  if (error) throw new Error(`Suppression Supabase échouée (${WARNINGS_TABLE}) : ${error.message}`);
  return data?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Sauvegardes du serveur (module Sauvegardes) : une ligne par sauvegarde, contenu en jsonb.
// ---------------------------------------------------------------------------
const BACKUPS_TABLE = 'edge_backups';
const BACKUP_LIST_SELECT = 'id, kind, guild_name, created_at, summary';

async function insertBackup(row) {
  const { data, error } = await supabase.from(BACKUPS_TABLE).insert(row).select(BACKUP_LIST_SELECT).single();
  if (error) throw new Error(`Écriture Supabase échouée (${BACKUPS_TABLE}) : ${error.message}`);
  return data;
}

// Liste des sauvegardes d'un serveur (sans le contenu), la plus récente d'abord.
async function loadBackups(guildId) {
  const { data, error } = await supabase
    .from(BACKUPS_TABLE)
    .select(BACKUP_LIST_SELECT)
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Lecture Supabase échouée (${BACKUPS_TABLE}) : ${error.message}`);
  return data ?? [];
}

// Contenu complet d'une sauvegarde (vérifié par serveur).
async function loadBackup(guildId, id) {
  const { data, error } = await supabase
    .from(BACKUPS_TABLE)
    .select(BACKUP_LIST_SELECT + ', data, data_z')
    .eq('guild_id', guildId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Lecture Supabase échouée (${BACKUPS_TABLE}) : ${error.message}`);
  return data ?? null;
}

async function deleteBackups(guildId, ids) {
  if (!ids.length) return;
  const { error } = await supabase.from(BACKUPS_TABLE).delete().eq('guild_id', guildId).in('id', ids);
  if (error) throw new Error(`Suppression Supabase échouée (${BACKUPS_TABLE}) : ${error.message}`);
}

// Toutes les configurations de modules d'un serveur (depuis le cache) : { moduleId: config }.
function listGuildConfigs(guildId) {
  const prefix = `${guildId}:`;
  const out = {};
  for (const [key, value] of cache) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = structuredClone(value);
  }
  return out;
}

module.exports = {
  init,
  insertBackup,
  loadBackups,
  loadBackup,
  deleteBackups,
  listGuildConfigs,
  insertLogs,
  loadLogs,
  pruneLogs,
  addWarning,
  loadWarnings,
  deleteWarning,
  loadOpenSuggestions,
  saveSuggestion,
  loadOpenGiveaways,
  saveGiveaway,
  getModuleConfig,
  getGuildModule,
  updateModuleConfig,
  uploadAsset,
  deleteAsset,
  loadLevelRows,
  saveLevelRows,
};
