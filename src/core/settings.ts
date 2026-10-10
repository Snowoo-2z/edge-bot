/**
 * Les réglages d'Edge : la couche « personnalise-moi tout », à la Draft Bot mais dans Discord.
 *
 * Le principe, en trois phrases :
 *  - chaque module DECLARE ses réglages (`reglages: SettingDef[]`) avec un type, un défaut, une
 *    aide, des bornes ; c'est la seule source de vérité, et le reste en découle ;
 *  - la valeur vit en base (`module_settings`, ou l'emplacement historique du réglage — `kv_store`
 *    ou `flags` — pour ne jamais dupliquer un état existant) ;
 *  - `/edge config` liste, valide, pose, retire, exporte et importe ; le tableau de bord
 *    (`/edge config tableau`) permet de tout faire à la souris, et `/edge module X couper`
 *    retire le module ET ses commandes slash.
 *
 * Rien ici ne connaît Discord en profondeur : la validation est pure et testable sans token, et
 * les types « salon » / « rôle » ne vérifient que la forme (`<#123>`), l'existence étant
 * contrôlée plus tard par l'appelant qui a le `Guild`.
 */
import { COLORS, type ChannelKey } from '../manifest.js';
import { parseDuration } from './ui.js';
import type { Db } from '../db/db.js';

export type TypeReglage =
  | 'texte' | 'chaine' | 'nombre' | 'pourcentage' | 'couleur' | 'booleen'
  | 'salon' | 'role' | 'duree' | 'liste' | 'choix' | 'emoticone';

export interface SettingDef {
  /** snake_case, unique par module. */
  cle: string;
  module: string;
  type: TypeReglage;
  /** Libellé court, tel qu'affiché dans /edge config voir. */
  label: string;
  /** Une phrase : ce que ça change, et où. */
  aide?: string;
  defaut: unknown;
  min?: number;
  max?: number;
  /** `texte` / `chaine` : longueur maximale acceptée. */
  maxLen?: number;
  /** `choix` : les valeurs admises. */
  choix?: readonly { nom: string; valeur: string }[];
  /**
   * Où la valeur vit vraiment. Par défaut `module_settings` ; `kv` et `flags` existent pour les
   * réglages que Edge savait déjà faire (ils gardent leur emplacement, donc ce que tu as réglé
   * avant reste réglé).
   */
  base?: 'config' | 'kv' | 'flags';
  /** Clé dans kv_store / flags si différente de `cle` (supporte `{module}`). */
  cleBase?: string;
  /** Un réglage « caché » n'apparaît que dans `/edge config voir <module> --tout`. */
  avance?: boolean;
}

const TYPES: readonly TypeReglage[] = ['texte', 'chaine', 'nombre', 'pourcentage', 'couleur', 'booleen', 'salon', 'role', 'duree', 'liste', 'choix', 'emoticone'];
const NOMS_COULEURS: Record<string, string> = {
  rouge: '#ED4245', orange: '#E67E22', jaune: '#FEE75C', vert: '#2ECC71', bleu: '#3498DB',
  turquoise: '#1ABC9C', violet: '#9B59B6', rose: '#F47FFF', gris: '#95A5A6', blanc: '#FFFFFF',
  noir: '#000000', blurple: '#5865F2', or: '#FFD700',
};

export type ResultatValidation = { ok: true; valeur: unknown } | { ok: false; raison: string };

const NOMBRE = /^-?\d+(?:[.,]\d+)?$/;

/** Met en forme la valeur saisie par l'humain. Pur : testable sans Discord ni base. */
export function valider(def: SettingDef, brut: string): ResultatValidation {
  const s = String(brut ?? '').trim();
  switch (def.type) {
    case 'chaine': {
      if (!s) return { ok: false, raison: 'vide : un texte ne peut pas être vide (mets « réinitialiser » pour revenir au défaut)' };
      if (/[\n\r]/.test(s)) return { ok: false, raison: 'un seul ligne attendue (pour un texte multi-lignes, le réglage est de type « texte »)' };
      const lim = def.maxLen ?? 180;
      if (s.length > lim) return { ok: false, raison: `trop long : ${s.length} caractères, maximum ${lim}` };
      return { ok: true, valeur: s };
    }
    case 'texte': {
      if (!s) return { ok: false, raison: 'vide : utilise « réinitialiser » pour revenir au message par défaut' };
      const lim = def.maxLen ?? 1800;
      if (s.length > lim) return { ok: false, raison: `trop long : ${s.length} caractères, maximum ${lim} (Discord coupe les messages à 2000)` };
      return { ok: true, valeur: s };
    }
    case 'emoticone': {
      if (!s) return { ok: false, raison: 'vide' };
      if ([...s].length > 8) return { ok: false, raison: 'huit emojis maximum' };
      return { ok: true, valeur: s };
    }
    case 'nombre': {
      if (!NOMBRE.test(s)) return { ok: false, raison: `nombre attendu, reçu « ${s.slice(0, 20)} »` };
      const n = Number(s.replace(',', '.'));
      if (!Number.isFinite(n)) return { ok: false, raison: 'nombre invalide' };
      if (def.min !== undefined && n < def.min) return { ok: false, raison: `minimum ${def.min}` };
      if (def.max !== undefined && n > def.max) return { ok: false, raison: `maximum ${def.max}` };
      return { ok: true, valeur: Number.isInteger(n) ? n : Math.round(n * 100) / 100 };
    }
    case 'pourcentage': {
      if (!NOMBRE.test(s)) return { ok: false, raison: 'pourcentage attendu (ex. 40 ou 40 %)' };
      const n = Math.round(Number(s.replace(',', '.').replace('%', '').trim()));
      if (n < 0 || n > 100) return { ok: false, raison: 'entre 0 et 100' };
      return { ok: true, valeur: n };
    }
    case 'couleur': {
      const bas = s.toLowerCase();
      const hex = NOMS_COULEURS[bas] ?? (/^#?[0-9a-f]{6}$/i.test(bas) ? (bas.startsWith('#') ? bas : `#${bas}`) : null);
      if (!hex) return { ok: false, raison: `couleur non comprise : « ${s.slice(0, 24)} ». Les deux formes marchent : #RRGGBB ou un nom (${Object.keys(NOMS_COULEURS).join(', ')})` };
      return { ok: true, valeur: hex.toUpperCase() };
    }
    case 'booleen': {
      const bas = s.toLowerCase();
      if (/^(oui|o|vrai|true|1|on|activer|active|allume|yes)$/.test(bas)) return { ok: true, valeur: true };
      if (/^(non|n|faux|false|0|off|couper|coupe|eteins|no)$/.test(bas)) return { ok: true, valeur: false };
      return { ok: false, raison: 'réponds par oui ou non' };
    }
    case 'salon': case 'role': {
      const id = /<#(\d{15,21})>/.exec(s)?.[1] ?? /<@&(\d{15,21})>/.exec(s)?.[1] ?? (/^\d{15,21}$/.test(s) ? s : null);
      if (!id) return { ok: false, raison: def.type === 'salon' ? 'mentionne le salon (clic droit → Copier l’identifiant, ou #nom-du-salon) — j’accepte aussi l’ID brut' : 'mentionne le rôle (<@&id>) ou donne son ID' };
      return { ok: true, valeur: id };
    }
    case 'duree': {
      const ms = parseDuration(s);
      if (ms === null) return { ok: false, raison: 'durée non comprise (exemples : 30s, 5m, 2h, 1j, 1h30)' };
      return { ok: true, valeur: ms };
    }
    case 'liste': {
      const mots = s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
      const lim = def.max ?? 25;
      if (mots.length > lim) return { ok: false, raison: `${mots.length} entrées, maximum ${lim}` };
      return { ok: true, valeur: mots };
    }
    case 'choix': {
      const admis = def.choix ?? [];
      const parNom = admis.find((x) => x.nom.toLowerCase() === s.toLowerCase() || x.valeur.toLowerCase() === s.toLowerCase());
      if (!parNom) return { ok: false, raison: `choix attendu parmi : ${admis.map((x) => x.nom).join(' / ')}` };
      return { ok: true, valeur: parNom.valeur };
    }
  }
}

/** Valeur stockée -> valeur lisible par le code (le stockage JSONB peut avoir dérivé). */
export function normaliser(def: SettingDef, valeur: unknown): unknown {
  if (valeur === undefined || valeur === null) return def.defaut;
  switch (def.type) {
    case 'nombre': case 'pourcentage': {
      const n = Number(valeur);
      if (!Number.isFinite(n)) return def.defaut;
      if (def.min !== undefined && n < def.min) return def.min;
      if (def.max !== undefined && n > def.max) return def.max;
      return n;
    }
    case 'booleen': return typeof valeur === 'boolean' ? valeur : Boolean(valeur);
    case 'liste': return Array.isArray(valeur) ? valeur.map(String) : String(valeur).split(',').map((x) => x.trim()).filter(Boolean);
    case 'duree': return Number(valeur) || (def.defaut as number);
    case 'couleur': return /^#[0-9A-Fa-f]{6}$/.test(String(valeur)) ? String(valeur).toUpperCase() : (def.defaut as string);
    case 'texte': case 'chaine': return String(valeur);
    default: return valeur;
  }
}

/** Ce que voit l'humain dans `/edge config voir`. */
export function formater(def: SettingDef, valeur: unknown): string {
  const v = normaliser(def, valeur);
  switch (def.type) {
    case 'booleen': return v ? '✅ oui' : '🚫 non';
    case 'duree': return `${Math.round(Number(v) / 1000)} s`;
    case 'pourcentage': return `${v} %`;
    case 'liste': return (v as string[]).length ? (v as string[]).join(', ') : '—';
    case 'couleur': return `🟪 \`${v}\``;
    case 'texte': {
      const t = String(v).replace(/\n/g, ' ⏎ ');
      return t.length > 120 ? `${t.slice(0, 117)}…` : t;
    }
    case 'nombre': return String(v);
    default: return String(v ?? '—');
  }
}

/** La vue typée que les modules manipulent (une par module, cachee). */
export interface VueReglages {
  texte(cle: string): Promise<string>;
  str(cle: string): Promise<string>;
  num(cle: string): Promise<number>;
  bool(cle: string): Promise<boolean>;
  couleur(cle: string): Promise<number>;
  liste(cle: string): Promise<string[]>;
  duree(cle: string): Promise<number>;
  choix(cle: string): Promise<string>;
  salon(cle: string): Promise<string>;
}

/**
 * Les réglages du noyau, appliqués au cœur (send.ts et les routages de log) : une seule
 * déclaration, et les 23 modules suivent sans qu'on les touche.
 */
export const REGLAGES_GENERAL: SettingDef[] = [
  { cle: 'couleur', module: 'general', type: 'couleur', label: 'Couleur des embeds', aide: 'Le liseré des messages d’Edge. Un module qui impose sa couleur (giveaway, ticket) la garde.', defaut: '#5865F2' },
  { cle: 'pied_de_page', module: 'general', type: 'chaine', label: 'Pied de page', aide: 'Le petit texte en bas de chaque embed. Laisse vide pour n’afficher que le nom du serveur.', defaut: '', maxLen: 90 },
  { cle: 'pings_roles', module: 'general', type: 'booleen', label: 'Autoriser les pings de rôles', aide: 'Non = Edge ne mentionne jamais un rôle (@Everyone, staff…), même pour une annonce. Utile les soirs où le serveur doit rester calme.', defaut: true },
  { cle: 'salon_moderation', module: 'general', type: 'salon', label: 'Salon des logs de modération', aide: 'Warns, timeouts, bans, automod, anti-raid.', defaut: 'modLogs' },
  { cle: 'salon_tickets', module: 'general', type: 'salon', label: 'Salon des logs de tickets', aide: 'Ouvertures, revendications, fermetures, transcripts.', defaut: 'ticketLogs' },
  { cle: 'salon_audit', module: 'general', type: 'salon', label: 'Salon du journal staff', aide: 'Ce que font les modérateurs (validations, panneaux, sanctions levées).', defaut: 'auditStaff' },
  { cle: 'salon_journal', module: 'general', type: 'salon', label: 'Salon du journal du bot', aide: 'La vie technique d’Edge : démarrages, jobs ratés, salons orphelins.', defaut: 'staffChat' },
  { cle: 'journal_moderation', module: 'general', type: 'booleen', label: 'Écrire le journal de modération', aide: 'Warns, timeouts, bans, automod, anti-raid.', defaut: true, base: 'flags', cleBase: 'log:moderation' },
  { cle: 'journal_tickets', module: 'general', type: 'booleen', label: 'Écrire le journal des tickets', aide: 'Ouvertures, revendications, fermetures, transcripts.', defaut: true, base: 'flags', cleBase: 'log:ticket' },
  { cle: 'journal_staff', module: 'general', type: 'booleen', label: 'Écrire le journal du staff', aide: 'Ce que font les modérateurs : validations, panneaux, sanctions levées.', defaut: true, base: 'flags', cleBase: 'log:staff' },
  { cle: 'journal_bot', module: 'general', type: 'booleen', label: 'Écrire le journal du bot', aide: 'La vie technique d’Edge : démarrages, jobs ratés, salons orphelins.', defaut: true, base: 'flags', cleBase: 'log:ops' },
];

export const cleDeBase = (def: SettingDef): string => (def.cleBase ?? def.cle).replace(/\{module\}/g, def.module);

/* ------------------------------------------------------------------ registre */

export type Registre = Map<string, Map<string, SettingDef>>;

export function construireRegistre(modules: { key: string; label: string; reglages?: SettingDef[] }[]): Registre {
  const r: Registre = new Map();
  for (const m of modules) {
    const defs = new Map<string, SettingDef>();
    for (const def of m.reglages ?? []) defs.set(def.cle, { ...def, module: def.module || m.key });
    r.set(m.key, defs);
  }
  return r;
}

export function reglagesDe(registre: Registre, module: string): SettingDef[] {
  return [...(registre.get(module)?.values() ?? [])];
}

/** Ce qui cloche dans le registre — asserti par les tests, pour qu'aucun réglage ne soit décoratif. */
export function invariantsRegistre(registre: Registre, sourceParModule?: (module: string) => string): string[] {
  const pb: string[] = [];
  for (const [module, defs] of registre) {
    if (!defs.size) continue;
    for (const def of defs.values()) {
      if (!TYPES.includes(def.type)) pb.push(`${module}.${def.cle} : type « ${def.type} » inconnu`);
      if (!def.label?.trim()) pb.push(`${module}.${def.cle} : libellé vide`);
      if (!/^[a-z][a-z0-9_]*$/.test(def.cle)) pb.push(`${module}.${def.cle} : la clé doit être en minuscules soulignées (a-z0-9_)`);
      if (def.type === 'choix' && !def.choix?.length) pb.push(`${module}.${def.cle} : un choix sans options est un piège`);
      if (def.min !== undefined && def.max !== undefined && def.min > def.max) pb.push(`${module}.${def.cle} : min > max`);
      // Un defaut de type salon/role est une cle du manifeste (« modLogs »), pas une saisie
      // humaine : ce n'est pas au validateur de commande de l'approuver.
      const formeDefaut = def.defaut === '' || def.defaut === null || def.defaut === undefined
        || ((def.type === 'salon' || def.type === 'role') && !/^\d{15,21}$/.test(String(def.defaut)));
      const valide = formeDefaut ? ({ ok: true } as ResultatValidation) : valider(def, formaterValide(def));
      if (!valide.ok) pb.push(`${module}.${def.cle} : le défaut ne passe pas sa propre validation (${valide.raison})`);
      const src = sourceParModule?.(module);
      if (src && !src.includes(`'${def.cle}'`) && !src.includes(`"${def.cle}"`) && !(def.cleBase && src.includes(def.cleBase))) {
        pb.push(`${module}.${def.cle} : déclaré mais jamais lu par le module (un réglage décoratif est pire que pas de réglage)`);
      }
    }
  }
  return pb;
}

/** Le défaut, remis en forme de saisie, pour valider qu'il est bien dans les clous. */
function formaterValide(def: SettingDef): string {
  const v = def.defaut;
  if (def.type === 'liste') return Array.isArray(v) ? v.join(', ') : String(v ?? '');
  if (def.type === 'booleen') return v ? 'oui' : 'non';
  if (def.type === 'duree') return String(Number(v) / 1000) + 's';
  return String(v ?? '');
}

/* ------------------------------------------------------------------ lecture / ecriture */

export interface CfgStore {
  /** `module_settings` + les emplacements historiques (kv_store, flags). */
  lire(db: Db, def: SettingDef): Promise<unknown>;
  ecrire(db: Db, def: SettingDef, valeur: unknown, par?: string): Promise<void>;
  effacer(db: Db, def: SettingDef): Promise<void>;
}

export const store: CfgStore = {
  async lire(db, def) {
    if (def.base === 'flags') return (await db.one('flags', { key: cleDeBase(def) }))?.enabled ?? null;
    if (def.base === 'kv') return (await db.one('kv_store', { key: cleDeBase(def) }))?.value ?? null;
    return (await db.one('module_settings', { module_key: def.module, cle: def.cle }))?.valeur ?? null;
  },
  async ecrire(db, def, valeur, par) {
    if (def.base === 'flags') return void (await db.flags.set(cleDeBase(def), Boolean(valeur)));
    if (def.base === 'kv') return void (await db.kv.set(cleDeBase(def), valeur));
    return void (await db.upsert('module_settings', ['module_key', 'cle'], {
      module_key: def.module, cle: def.cle, valeur, ...(par ? { updated_by: par } : {}), updated_at: new Date(),
    }, { valeur, ...(par ? { updated_by: par } : {}), updated_at: new Date() }));
  },
  async effacer(db, def) {
    // Un reglage historique vit dans une table lue ailleurs avec son propre defaut : effacer la
    // ligne ferait revenir LE defaut du lecteur, pas celui qui est declare ici. On reecrit donc
    // le defaut declare — c'est ce que promet « oublier » dans l'interface.
    if (def.base === 'kv') return void (await db.kv.set(cleDeBase(def), def.defaut));
    if (def.base === 'flags') return void (await db.flags.set(cleDeBase(def), Boolean(def.defaut)));
    return void (await db.delete('module_settings', { module_key: def.module, cle: def.cle }));
  },
};

/**
 * La vue dont disposent les modules : `const r = c.cfg('welcome')` puis `await r.str('message')`.
 * Les valeurs sont cachees 20 s (un message d'accueil se lit des dizaines de fois par minute, la
 * base n'a rien à voir là-dedans) ; `/edge config regler` invalide le cache du module touche.
 */
export class Config {
  private cache = new Map<string, { v: unknown; t: number }>();
  private static TTL = 20_000;

  constructor(private db: Db, private registre: Registre, private onChange: (module: string) => void = () => void 0) {}

  defs(module: string): SettingDef[] { return reglagesDe(this.registre, module); }
  def(module: string, cle: string): SettingDef | undefined { return this.registre.get(module)?.get(cle); }
  invalider(module?: string): void {
    if (!module) this.cache.clear();
    else for (const k of [...this.cache.keys()]) if (k.startsWith(`${module}:`)) this.cache.delete(k);
  }

  async valeur(module: string, cle: string): Promise<unknown> {
    const def = this.def(module, cle);
    if (!def) return null;
    const k = `${module}:${cle}`;
    const hit = this.cache.get(k);
    if (hit && hit.t > Date.now()) return hit.v;
    const brut = await store.lire(this.db, def);
    const v = brut === null || brut === undefined ? def.defaut : normaliser(def, brut);
    this.cache.set(k, { v, t: Date.now() + Config.TTL });
    return v;
  }

  async tout(module: string): Promise<Record<string, { valeur: unknown; parDefaut: boolean; def: SettingDef }>> {
    const out: Record<string, { valeur: unknown; parDefaut: boolean; def: SettingDef }> = {};
    for (const def of this.defs(module)) {
      const brut = await store.lire(this.db, def);
      const valeur = brut === null || brut === undefined ? def.defaut : normaliser(def, brut);
      out[def.cle] = { valeur, parDefaut: JSON.stringify(valeur) === JSON.stringify(def.defaut), def };
    }
    return out;
  }

  /** La porte d'entrée de `/edge config regler` : valide, écrit, prévient les caches. */
  async regler(module: string, cle: string, brut: string): Promise<{ ok: true; def: SettingDef; valeur: unknown } | { ok: false; raison: string }> {
    const def = this.def(module, cle);
    if (!def) return { ok: false, raison: `le module « ${module} » n'a pas de réglage « ${cle} » — vois la liste avec /edge config voir ${module}` };
    const v = valider(def, brut);
    if (!v.ok) return { ok: false, raison: v.raison };
    await store.ecrire(this.db, def, v.valeur);
    this.invalider(module);
    this.onChange(module);
    return { ok: true, def, valeur: v.valeur };
  }

  async oublier(module: string, cle: string): Promise<boolean> {
    const def = this.def(module, cle);
    if (!def) return false;
    await store.effacer(this.db, def);
    this.invalider(module);
    this.onChange(module);
    return true;
  }

  async reinitialiser(module: string): Promise<number> {
    const defs = this.defs(module);
    for (const def of defs) await store.effacer(this.db, def);
    this.invalider(module);
    this.onChange(module);
    return defs.length;
  }

  async exporter(module: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const def of this.defs(module)) {
      const brut = await store.lire(this.db, def);
      if (brut !== null && brut !== undefined) out[def.cle] = brut;
    }
    return out;
  }

  /** Import tolérant : ce qui n'est pas déclaré ou pas valide est rapporte, le reste est pose. */
  async importer(module: string, objet: Record<string, unknown>): Promise<{ poses: string[]; refuses: [string, string][] }> {
    const poses: string[] = []; const refuses: [string, string][] = [];
    for (const [cle, valeur] of Object.entries(objet ?? {})) {
      const def = this.def(module, cle);
      if (!def) { refuses.push([cle, 'réglage inconnu pour ce module']); continue; }
      const brut = typeof valeur === 'string' ? valeur : JSON.stringify(valeur);
      const v = def.base === 'config' || def.base === undefined ? valider(def, brut) : { ok: true as const, valeur: normaliser(def, valeur) };
      if (!v.ok) { refuses.push([cle, v.raison]); continue; }
      await store.ecrire(this.db, def, v.valeur);
      poses.push(cle);
    }
    this.invalider(module);
    this.onChange(module);
    return { poses, refuses };
  }

  /** Les getters que les modules utilisent. */
  pour(module: string): VueReglages {
    const lire = <T>(cle: string): Promise<T> => this.valeur(module, cle) as Promise<T>;
    return {
      texte: (cle: string) => lire<string>(cle),
      str: (cle: string) => lire<string>(cle),
      num: (cle: string) => lire<number>(cle),
      bool: (cle: string) => lire<boolean>(cle),
      couleur: async (cle: string): Promise<number> => {
        const hex = await lire<string>(cle);
        return typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex.slice(1), 16) : COLORS.edge;
      },
      liste: (cle: string) => lire<string[]>(cle),
      duree: (cle: string) => lire<number>(cle),
      choix: (cle: string) => lire<string>(cle),
      salon: (cle: string) => lire<ChannelKey | string>(cle),
    };
  }
}
