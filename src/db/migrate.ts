import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from './db.js';
import { log } from '../core/logs.js';

/** Applique les migrations SQL manquantes (table `schema_migrations`). */
export async function migrate(db: Db, dir = 'migrations'): Promise<{ applied: string[] }> {
  if (!db.isPersisted) return { applied: [] };
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  await db.raw('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.raw<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    log.info(`migration ${f}…`);
    await db.raw(readFileSync(join(dir, f), 'utf8'));
    await db.raw('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    applied.push(f);
  }
  if (applied.length) log.ok(`migrations appliquées : ${applied.join(', ')}`);
  return { applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL manquante (le mode mémoire n’a pas besoin de migration).'); process.exit(1); }
  const db = Db.pool(url);
  migrate(db).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
