const fs = require('node:fs');
const path = require('node:path');

// DATA_DIR permet de pointer vers un disque persistant (ex. Render Disk).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

let data = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { guilds: {} };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

/**
 * Retourne la config d'un module pour un serveur.
 * Ajoute automatiquement les clés manquantes (nouvelles options / nouveaux textes).
 */
function getModuleConfig(guildId, moduleId, defaults) {
  data.guilds[guildId] ??= {};
  const guild = data.guilds[guildId];
  const current = guild[moduleId] ?? {};
  const merged = { ...structuredClone(defaults), ...current };
  merged.texts = { ...structuredClone(defaults.texts ?? {}), ...(current.texts ?? {}) };
  merged.assets = { ...structuredClone(defaults.assets ?? {}), ...(current.assets ?? {}) };
  merged.open = current.open ?? {};
  guild[moduleId] = merged;
  return merged;
}

function updateModuleConfig(guildId, moduleId, cfg) {
  data.guilds[guildId] ??= {};
  data.guilds[guildId][moduleId] = cfg;
  save();
  return cfg;
}

function getGuildModule(guildId, moduleId) {
  return data.guilds[guildId]?.[moduleId] ?? null;
}

module.exports = { DATA_DIR, getModuleConfig, updateModuleConfig, getGuildModule, save };
