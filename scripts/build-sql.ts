/**
 * Genere `supabase/schema.sql` : LE fichier a coller dans l'editeur SQL de Supabase.
 *
 * Source de verite = `migrations/*.sql` (le schema ET les fonctions API). Le fichier genere est
 * commit pour que tu puisses le lire et le coller sans outillage ; un test (`npm test`) verifie
 * qu'il n'a pas derive par rapport aux migrations.
 *
 *   npm run db:sql
 *
 * Ce script n'invente jamais de SQL : il concatene, il verifie la cohérence, il ajoute les
 * garde-fous (search_path, marquage des migrations deja appliquees, rechargement du cache
 * PostgREST). Les tables que les fonctions de compteurs parcourent doivent etre exactement celles
 * du schema — verifie ici, parce qu'une table oubliee donnerait un `/edge stats` faux sans erreur.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const racine = join(here, '..');
const MIG = join(racine, 'migrations');
const SORTIE = join(racine, 'supabase', 'schema.sql');

const fichiers = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
if (!fichiers.length) throw new Error('aucun .sql dans migrations/');
const morceaux = fichiers.map((f) => ({ nom: f, sql: readFileSync(join(MIG, f), 'utf8').trim() }));
const corps = morceaux.map((m) => `-- ---- ${m.nom} ----\n${m.sql}`).join('\n\n');

const tables = [...new Set([...corps.matchAll(/CREATE TABLE IF NOT EXISTS (?:public\.)?([a-z_][a-z0-9_]*)/g)].map((m) => m[1]!))].sort();
if (tables.length < 20) throw new Error(`liste de tables suspecte (${tables.length}) : le parseur de migrations a cassé`);

const tout = morceaux.map((m) => m.sql).join('\n');
if (!/CREATE OR REPLACE FUNCTION edge_schema_check/.test(tout)) throw new Error('edge_schema_check() a disparu des migrations : /edge santé et le contrôle de schéma ne marcheraient plus');
const fonctions = (tout.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length;
const sqlFonctions = morceaux.find((m) => m.sql.includes('edge_schema_check'))?.sql ?? '';
for (const t of tables) {
  if (!sqlFonctions.includes(`'${t}'`)) throw new Error(`table « ${t} » absente des tableaux de migrations/0002_edge_functions.sql : les compteurs edge_counts()/edge_schema_check() la rendraient invisibles`);
}
// uniquement les elements de liste sur leur propre ligne : «    'members', »
const tablesDansFonctions = new Set([...sqlFonctions.matchAll(/^ {4}'([a-z_]+)',$/gm)].map((m) => m[1]!));
const enTrop = [...tablesDansFonctions].filter((t) => !tables.includes(t));
if (enTrop.length) throw new Error(`les fonctions comptent des tables qui n'existent plus : ${enTrop.join(', ')} (elles feront échouer edge_counts())`);

const sortie = `-- ============================================================================
-- EDGE · schéma complet, à coller dans Supabase :
--   Project → SQL Editor → New query → coller → Run
--
-- · Idempotent : tu peux le relancer après chaque mise à jour, il ne détruit RIEN
--   (CREATE ... IF NOT EXISTS partout, aucune DROP, aucun TRUNCATE).
-- · Il crée ${tables.length} tables, les index et ${fonctions} fonctions que Edge appelle par
--   l'API : edge_schema_check, edge_prune_events, edge_counts.
-- · Après ce fichier, Edge n'a besoin que de SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY : il
--   passe par l'API HTTP de Supabase, donc JAMAIS le mot de passe de la base ni un pooler.
-- · Généré par « npm run db:sql » à partir de migrations/*.sql — ne pas éditer à la main.
-- ============================================================================

SET search_path = public;

${corps}

-- ============================================================================
-- Empêche « npm run db:migrate » (mode connexion directe) de rejouer ce fichier :
-- les migrations sont marquées comme appliquées.
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
${fichiers.map((f) => `INSERT INTO schema_migrations (name) VALUES ('${f}') ON CONFLICT (name) DO NOTHING;`).join('\n')}

-- PostgREST doit recharger son cache de schéma pour voir les tables et fonctions neuves.
NOTIFY pgrst, 'reload schema';
`;

mkdirSync(dirname(SORTIE), { recursive: true });
const precedent = (() => { try { return readFileSync(SORTIE, 'utf8'); } catch { return null; } })();
writeFileSync(SORTIE, sortie);
console.log(`supabase/schema.sql : ${tables.length} tables, ${fonctions} fonctions, ${sortie.split('\n').length} lignes${precedent === sortie ? ' (inchangé)' : ''}`);
