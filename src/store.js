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

module.exports = {
  init,
  getModuleConfig,
  getGuildModule,
  updateModuleConfig,
  uploadAsset,
  deleteAsset,
  loadLevelRows,
  saveLevelRows,
};
