/**
 * Audit statique du schéma SQL contre le code — sans ouvrir de base de données.
 *
 * Pourquoi ce fichier existe : `npm run dry` et `npm test` tournaient sur `Db.memory()`, qui
 * crée les tables à la volée et accepte n'importe quelle colonne. Résultat : le module annonces
 * écrivait dans une table `announcements` que personne n'avait jamais créée, et quatre colonnes
 * (dont `tickets.closed_by`) n'existaient pas dans `migrations/0001_init.sql`. Sur Postgres ou
 * l'API Supabase, ces écritures-là échouent au premier coup. Un vrai `42703 column does not
 * exist` a coûté une soirée de déploiement — ce test est là pour qu'il ne se répète plus.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type Colonnes = Map<string, string[]>;

/** Enlève les commentaires SQL : sinon un `-- note (#id)` en fin de ligne mangue la colonne suivante. */
const sansCommentaires = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/** `CREATE TABLE IF NOT EXISTS x ( … )` -> { table: [colonnes] }. Les contraintes de table sont ignorées. */
export function lireTables(sql: string): Colonnes {
  const brut = sansCommentaires(sql);
  const tables: Colonnes = new Map();
  for (const m of brut.matchAll(/CREATE TABLE IF NOT EXISTS (?:public\.)?([a-z_][a-z0-9_]*)\s*\(/g)) {
    const debut = (m.index ?? 0) + m[0].length - 1;
    let i = debut;
    let p = 0;
    while (i < brut.length) {
      const ch = brut[i];
      if (ch === '(') p++;
      else if (ch === ')') { p--; if (p === 0) break; }
      i++;
    }
    const morceaux = decoupe(brut.slice(debut + 1, i), '(', ')', ',');
    const cols: string[] = [];
    for (const morc of morceaux) {
      const propre = morc.replace(/\s+/g, ' ').trim();
      if (!propre || /^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(propre)) continue;
      const def = /^([a-z_]+)\s/.exec(propre);
      if (def) cols.push(def[1]!);
    }
    tables.set(m[1]!, cols);
  }
  return tables;
}

/** Découpe au niveau 0 de parenthèses/crochets/accolades. */
function decoupe(txt: string, ouv: string, fer: string, sep: string): string[] {
  const out: string[] = [];
  let prof = 0; let cur = '';
  for (const ch of txt) {
    if (ch === ouv || ch === '[' || ch === '{') prof++;
    if (ch === fer || ch === ']' || ch === '}') prof--;
    if (ch === sep && prof === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Le corps du premier `{ … }` équilibré à partir de `depuis`, ou null. */
function objet(txt: string, depuis = 0): { corps: string; fin: number } | null {
  const j = txt.indexOf('{', depuis);
  if (j < 0) return null;
  let prof = 0;
  for (let i = j; i < txt.length; i++) {
    if (txt[i] === '{') prof++;
    else if (txt[i] === '}') { prof--; if (prof === 0) return { corps: txt.slice(j + 1, i), fin: i + 1 }; }
  }
  return null;
}

/** Les clés littérales d'un objet JS (`{ a: 1, 'b': 2 }`) ; les clés calculées sont ignorées. */
function cles(corps: string): string[] {
  const out: string[] = [];
  for (const p of decoupe(corps, '(', ')', ',')) {
    const m = /^\s*'?([a-z_]+)'?\s*:/.exec(p.replace(/\s+/g, ' '));
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Les arguments d'un appel, à partir de sa parenthèse ouvrante. */
function argumentsAppel(txt: string, ouvrante: number): string[] | null {
  let prof = 0; let i = ouvrante; const morc: string[] = []; let cur = '';
  for (; i < txt.length; i++) {
    const ch = txt[i];
    if (ch === '(' || ch === '[' || ch === '{') prof++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      prof--;
      if (prof === 0) { morc.push(cur); return morc; }
    }
    if (ch === ',' && prof === 1) { morc.push(cur); cur = ''; continue; }
    cur += ch;
  }
  return null; // appel jamais fermé dans la fenetre lue
}

const METHODES: Record<string, number> = {
  insert: 1,      // (table, row)
  update: 2,      // (table, where, patch)
  upsert: 2,      // (table, [cles], row)
};

export type Rapport = { problemes: string[]; tablesVue: number; colonnesVerifiees: number; fichiersVus: number };

function fichiersTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) fichiersTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** L'etat du schema tel que les migrations le decrivent (pas le fichier genere : meme source, test independant). */
export function schemaDesMigrations(dir = 'migrations'): { tables: Colonnes; sql: string } {
  const fichiers = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const sql = fichiers.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  return { tables: lireTables(sql), sql };
}

export function auditerSchema(racine = '.', dirSrc = 'src', dirMig = 'migrations'): Rapport {
  const { tables, sql } = schemaDesMigrations(dirMig);
  const problemes: string[] = [];
  let colonnesVerifiees = 0;

  // 1) index et FK du schema, entre eux
  const brut = sansCommentaires(sql);
  for (const m of brut.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_0-9]+) ON (?:public\.)?([a-z_]+)(?: ONLY)?\s*\(([^)]*)\)/g)) {
    const [, index, table, colonnes] = m;
    const cols = tables.get(table!);
    if (!cols) { problemes.push(`index ${index} : table inconnue ${table}`); continue; }
    for (const c of colonnes!.match(/[a-z_]+/g) ?? []) {
      if (['lower', 'now', 'coalesce', 'asc', 'desc', 'nulls', 'first', 'last'].includes(c)) continue;
      if (!cols.includes(c)) problemes.push(`index ${index} : colonne ${table}.${c} absente de la table`);
    }
  }
  for (const m of brut.matchAll(/REFERENCES (?:public\.)?([a-z_]+)\s*\(([a-z_]+)\)/g)) {
    const cols = tables.get(m[1]!);
    if (cols && !cols.includes(m[2]!)) problemes.push(`clé étrangère vers ${m[1]}.${m[2]} : colonne absente`);
  }

  // 2) ce que le code touche, contre le schema
  const fichiers = fichiersTs(join(racine, dirSrc));
  for (const f of fichiers) {
    const txt = readFileSync(f, 'utf8');
    const rel = f.slice(racine.length + 1);
    for (const m of txt.matchAll(/db\.(insert|update|upsert|bump|one|all|count|remove|delete)\(\s*'([a-z_]+)'/g)) {
      const meth = m[1]!; const table = m[2]!;
      const ouvrante = (m.index ?? 0) + m[0].lastIndexOf('(');
      const args = argumentsAppel(txt, ouvrante);
      if (!args) continue;
      const cols = tables.get(table);
      if (!cols) {
        problemes.push(`${rel}:${txt.slice(0, m.index).split('\n').length} : db.${meth}('${table}') — aucune CREATE TABLE '${table}' dans ${dirMig}/*.sql`);
        continue;
      }
      const verifier = (corps: string | undefined, d: string): void => {
        if (!corps) return;
        for (const c of [...new Set(cles(corps))]) {
          colonnesVerifiees++;
          if (!cols.includes(c)) problemes.push(`${rel} : db.${meth}('${table}') ${d} « ${c} » — colonne absente de la table ${table}`);
        }
      };
      if (meth in METHODES) {
        const objetCorps = objet(args[METHODES[meth]!] ?? '');
        verifier(objetCorps?.corps, 'écrit');
        if (meth === 'upsert') {
          for (const k of args[1]?.match(/'[a-z_]+'/g) ?? []) {
            colonnesVerifiees++;
            const cle = k.replace(/'/g, '');
            if (!cols.includes(cle)) problemes.push(`${rel} : db.upsert('${table}') clé de conflit « ${cle} » absente (sinon Postgres ne fusionne jamais et duplique)`);
          }
        }
      } else if (meth === 'bump') {
        const col = /'([a-z_]+)'/.exec(args[2] ?? '');
        if (col) {
          colonnesVerifiees++;
          if (!cols.includes(col[1]!)) problemes.push(`${rel} : db.bump('${table}') incrémente « ${col[1]} », colonne absente`);
        }
        verifier(objet(args[4] ?? '', 0)?.corps, 'sert');
      } else {
        // lecture : seuls `where: { … }` et `orderBy:` nomment des colonnes
        const opts = args[1] ?? '';
        const w = /where\s*:\s*/.exec(opts);
        if (w) verifier(objet(opts, w.index + w[0].length - 1)?.corps, 'filtre');
        for (const o of opts.matchAll(/orderBy\s*:\s*'([a-z_]+)'/g)) {
          colonnesVerifiees++;
          if (!cols.includes(o[1]!)) problemes.push(`${rel} : db.${meth}('${table}') trie sur « ${o[1]} », colonne absente`);
        }
      }
    }
  }

  // 3) le harnais de compteurs de l'API doit connaitre toutes les tables
  const blocFonctions = brut.slice(brut.indexOf('edge_schema_check'));
  for (const t of tables.keys()) {
    if (!blocFonctions.includes(`'${t}'`)) problemes.push(`edge_schema_check()/edge_counts() ne listent pas « ${t} » : elle serait invisible dans /edge stats`);
  }

  return { problemes, tablesVue: tables.size, colonnesVerifiees, fichiersVus: fichiers.length };
}
