/**
 * Couche d'accès aux données de Edge.
 * - mode `pg`     : Supabase Postgres via `pg.Pool` (migrations dans ./migrations)
 * - mode `memory` : aucune URL de BDD => tout tient en RAM (dry-run, tests, dev).
 *
 * Les modules ne voient que cette interface : ils fonctionnent identiquement dans
 * les deux modes, ce qui permet de tester la logique métier sans Discord ni BDD.
 */
import pg from 'pg';
import { RestBackend } from './rest.js';

export type Where = Record<string, string | number | boolean | null | string[] | number[]>;
export interface FindOpts { where?: Where; orderBy?: string; desc?: boolean; limit?: number }
export type Row = Record<string, unknown> & { id?: string | number };

const IDENT = /^[a-z_][a-z0-9_]*$/;
const id = (s: string): string => {
  if (!IDENT.test(s)) throw new Error(`identifiant SQL invalide: ${s}`);
  return s;
};

export interface Backend {
  readonly mode: 'pg' | 'rest' | 'memory';
  insert(table: string, row: Row): Promise<Row>;
  all(table: string, opts: FindOpts): Promise<Row[]>;
  update(table: string, where: Where, patch: Row): Promise<Row | null>;
  remove(table: string, where: Where): Promise<number>;
  /** Compte sans transporter les lignes (le mode API a un en-tete Content-Range pour ca). */
  count?(table: string, where?: Where): Promise<number>;
  /** Fonction SQL (see supabase/schema.sql) : le seul moyen de faire une agregation en mode API. */
  rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T[]>;
  raw<T>(text: string, params?: unknown[]): Promise<T[]>;
  ping?(): Promise<boolean>;
}

/* ------------------------------------------------------------------ pg backend */

class PgBackend implements Backend {
  readonly mode = 'pg' as const;
  constructor(private pool: pg.Pool) {
    // Le *Transaction pooler* de Supabase (port 6543, pgbouncer) casse sur les
    // requêtes préparées : on les désactive, et on le détecte depuis l'URL.
    void pool.query('SELECT 1').catch(() => void 0);
  }

  private async q(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    const r = await this.pool.query(text, params as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount ?? r.rows.length };
  }

  async insert(table: string, row: Row): Promise<Row> {
    const keys = Object.keys(row);
    const cols = keys.map(id).join(', ');
    const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
    const params = keys.map((k) => enc(row[k]));
    const { rows } = await this.q(`INSERT INTO ${id(table)} (${cols}) VALUES (${vals}) RETURNING *`, params);
    return rows[0]!;
  }

  async all(table: string, opts: FindOpts): Promise<Row[]> {
    const { text, params } = whereSql(opts.where);
    let sql = `SELECT * FROM ${id(table)}${text ? ` WHERE ${text}` : ''}`;
    if (opts.orderBy) sql += ` ORDER BY ${id(opts.orderBy)} ${opts.desc ? 'DESC' : 'ASC'}`;
    if (opts.limit) sql += ` LIMIT ${Number(opts.limit)}`;
    const { rows } = await this.q(sql, params);
    return rows;
  }

  async update(table: string, where: Where, patch: Row): Promise<Row | null> {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${id(k)} = $${i + 1}`).join(', ');
    const { text, params } = whereSql(where, keys.length);
    const { rows } = await this.q(`UPDATE ${id(table)} SET ${sets}${text ? ` WHERE ${text}` : ''} RETURNING *`, [...keys.map((k) => enc(patch[k])), ...params]);
    return rows[0] ?? null;
  }

  async remove(table: string, where: Where): Promise<number> {
    const { text, params } = whereSql(where);
    const { rowCount } = await this.q(`DELETE FROM ${id(table)}${text ? ` WHERE ${text}` : ''}`, params);
    return rowCount;
  }

  async raw<T>(text: string, params?: unknown[]): Promise<T[]> {
    const { rows } = await this.q(text, params as unknown[]);
    return rows as T[];
  }

  async count(table: string, where?: Where): Promise<number> {
    const { text, params } = whereSql(where);
    const { rows } = await this.q(`SELECT count(*)::int AS n FROM ${id(table)}${text ? ` WHERE ${text}` : ''}`, params);
    return Number(rows[0]?.n ?? 0);
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
    const cles = Object.keys(args);
    const text = `SELECT ${id(fn)}(${cles.map((k, i) => `${id(k)} => $${i + 1}`).join(', ')}) AS res`;
    const { rows } = await this.q(text, cles.map((k) => enc(args[k])));
    return rows.map((r) => r.res as T);
  }

  async ping(): Promise<boolean> { await this.q('SELECT 1'); return true; }
}

function enc(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

function whereSql(where: Where | undefined, offset = 0): { text: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let n = offset;
  for (const [k, v] of Object.entries(where ?? {})) {
    const col = id(k);
    if (Array.isArray(v)) {
      if (v.length === 0) { parts.push('false'); continue; }
      parts.push(`${col} IN (${v.map(() => `$${++n}`).join(', ')})`);
      params.push(...v.map(enc));
    } else if (v === null) {
      parts.push(`${col} IS NULL`);
    } else {
      parts.push(`${col} = $${++n}`);
      params.push(enc(v));
    }
  }
  return { text: parts.join(' AND '), params };
}

/* -------------------------------------------------------------- memory backend */

class MemoryBackend implements Backend {
  readonly mode = 'memory' as const;
  private tables = new Map<string, Row[]>();
  private seq = new Map<string, number>();

  private t(table: string): Row[] {
    let r = this.tables.get(table);
    if (!r) this.tables.set(table, (r = []));
    return r;
  }

  async insert(table: string, row: Row): Promise<Row> {
    const next = (this.seq.get(table) ?? 0) + 1;
    this.seq.set(table, next);
    const rec: Row = { created_at: new Date(), ...structuredClone(row) };
    if (rec.id === undefined) rec.id = String(next);
    this.t(table).push(rec);
    return rec;
  }

  async all(table: string, opts: FindOpts): Promise<Row[]> {
    let rows = this.t(table).filter((r) => matches(r, opts.where));
    if (opts.orderBy) {
      const k = opts.orderBy;
      rows = [...rows].sort((a, b) => {
        const x = a[k] as number | string | Date | null | undefined;
        const y = b[k] as number | string | Date | null | undefined;
        const c = x instanceof Date && y instanceof Date ? x.getTime() - y.getTime() : Number(x ?? 0) - Number(y ?? 0) || String(x ?? '').localeCompare(String(y ?? ''));
        return opts.desc ? -c : c;
      });
    }
    return (opts.limit ? rows.slice(0, opts.limit) : rows).map((r) => ({ ...r }));
  }

  async update(table: string, where: Where, patch: Row): Promise<Row | null> {
    const hit = this.t(table).find((r) => matches(r, where));
    if (!hit) return null;
    Object.assign(hit, structuredClone(patch), { updated_at: new Date() });
    return { ...hit };
  }

  async remove(table: string, where: Where): Promise<number> {
    const before = this.t(table);
    const keep = before.filter((r) => !matches(r, where));
    this.tables.set(table, keep);
    return before.length - keep.length;
  }

  async rpc<T>(): Promise<T[]> { return []; }

  async raw<T>(): Promise<T[]> {
    throw new Error('SQL brut indisponible en mode mémoire (pas de DATABASE_URL).');
  }
}

const same = (a: unknown, b: unknown): boolean => (a === b || String(a) === String(b));
function matches(row: Row, where: Where | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (Array.isArray(v)) { if (!v.some((x) => same(row[k], x))) return false; }
    else if (v === null) { if (row[k] !== null && row[k] !== undefined) return false; }
    else if (!same(row[k], v)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ facade API */

export class Db {
  private constructor(private b: Backend, readonly persisted: boolean) {}

  static pool(databaseUrl: string): Db {
    const txPooler = /6543|pooler/.test(databaseUrl);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      // pgbouncer en mode transaction => pas de requêtes préparées
      ...(txPooler ? { statement_timeout: 15_000 } : {}),
      ssl: /supabase\.co|sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    if (txPooler) pool.on('error', () => void 0);
    return new Db(new PgBackend(pool), true);
  }

  /**
   * Supabase par son API HTTP (PostgREST) : `https://<ref>.supabase.co` + cle service_role.
   * C'est le chemin sans mot de passe de la base, sans pooler, sans IP a autoriser (README § 1).
   */
  static rest(opts: { url: string; key: string; schema?: string; timeoutMs?: number; log?: (m: string) => void }): Db {
    return new Db(new RestBackend({ ...opts, url: opts.url, key: opts.key, schema: opts.schema ?? 'public', timeoutMs: opts.timeoutMs ?? 20_000 }), true);
  }

  static memory(): Db { return new Db(new MemoryBackend(), false); }

  get isPersisted(): boolean { return this.persisted; }
  get mode(): 'pg' | 'rest' | 'memory' { return this.b.mode; }
  /** Ce que les logs et `/edge sante` doivent annoncer. */
  get libelle(): string { return this.mode === 'rest' ? 'API Supabase' : this.mode === 'pg' ? 'Postgres direct' : 'mémoire'; }

  /** Fonction SQL declaree dans supabase/schema.sql (agregations, menage, diagnostics). */
  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> { return this.b.rpc<T>(fn, args); }
  async rpc1<T>(fn: string, args: Record<string, unknown> = {}): Promise<T | null> { return (await this.b.rpc<T>(fn, args))[0] ?? null; }

  async insert(table: string, row: Row): Promise<Row> { return this.b.insert(table, row); }
  async upsert(table: string, key: string[], row: Row, patch?: Row): Promise<Row> {
    const where: Where = {};
    for (const k of key) where[k] = row[k] as string | number | boolean;
    const found = await this.one(table, where);
    if (!found) return this.insert(table, row);
    return (await this.b.update(table, where, patch ?? row))!;
  }
  async all(table: string, opts: FindOpts = {}): Promise<Row[]> { return this.b.all(table, opts); }
  async one(table: string, where: Where, orderBy?: string): Promise<Row | null> {
    const rows = await this.b.all(table, { where, orderBy, limit: 1 });
    return rows[0] ?? null;
  }
  async count(table: string, where?: Where): Promise<number> {
    if (this.b.count) return this.b.count(table, where);
    return (await this.b.all(table, { where })).length;
  }
  async update(table: string, where: Where, patch: Row): Promise<Row | null> { return this.b.update(table, where, patch); }
  async remove(table: string, where: Where): Promise<number> { return this.b.remove(table, where); }
  async delete(table: string, where: Where): Promise<number> { return this.b.remove(table, where); }

  /** Incrémente (et crée la ligne si absente) une colonne entière. */
  async bump(table: string, where: Where, col: string, by = 1, seed: Row = {}): Promise<Row> {
    const row = await this.one(table, where);
    const cur = Number(row?.[col] ?? 0);
    const next = cur + by;
    if (!row) return this.insert(table, { ...seed, ...where, [col]: next });
    return (await this.b.update(table, where, { [col]: next }))!;
  }

  /** Clé de KV typée (panneaux, compteurs, etats divers). */
  readonly kv = {
    get: async <T>(key: string): Promise<T | null> => {
      const r = await this.one('kv_store', { key });
      return r ? (r.value as T) : null;
    },
    set: async (key: string, value: unknown): Promise<void> => {
      await this.upsert('kv_store', ['key'], { key, value });
    },
    del: async (key: string): Promise<void> => { await this.delete('kv_store', { key }); },
  };

  /** Feature flags par module, en base (donc partagees / modifiables a chaud). */
  readonly flags = {
    isOn: async (key: string, fallback = true): Promise<boolean> => {
      const r = await this.one('flags', { key });
      return r ? Boolean(r.enabled) : fallback;
    },
    set: async (key: string, enabled: boolean): Promise<void> => { await this.upsert('flags', ['key'], { key, enabled }); },
    all: async (): Promise<Row[]> => this.all('flags'),
  };

  /** SQL brut (pg uniquement : migrations, diagnostics, gros rapports). */
  async raw<T = Row>(text: string, params?: unknown[]): Promise<T[]> { return this.b.raw<T>(text, params); }

  async ping(): Promise<boolean> {
    try {
      if (this.b.ping) return await this.b.ping();
      await this.b.raw('SELECT 1'); return true;
    } catch { return !this.persisted; }
  }

  async track(kind: string, payload: Row = {}): Promise<void> {
    await this.insert('bot_events', { kind, payload }).catch(() => void 0);
  }
}
