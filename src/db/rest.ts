/**
 * Pilote de persistance qui parle a **PostgREST**, l'API HTTP de Supabase.
 *
 * Pourquoi ce fichier : avec lui Edge n'a jamais besoin du mot de passe de la base, ni d'un
 * pooler, ni d'une IP autorisee. Il lui faut deux valeurs copiables-collables :
 *   SUPABASE_URL               = https://<reference>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  = la cle qui commence par eyJ… (celle que tu avais deja)
 * Tables = `supabase/schema.sql` colle dans l'editeur SQL. Les requetes partent en HTTP/443.
 *
 * Le contrat est le meme que le backend `pg` (voir src/core/db.ts) : les modules ne voient que
 * `insert / all / update / remove / count / raw / rpc / ping`, et un `Where` reste un objet
 * d'egalites (`{ statut: 'open', id: ['a','b'] }`) — ce qui se traduit mot pour mot en filtres
 * PostgREST (`statut=eq.open`, `id=in.("a","b")`).
 *
 * Choix assume : `upsert` et `bump` restent « lire puis ecrire » (comme c'etait deja le cas cote
 * pg dans la facade) — un bot sur un seul serveur n'a pas de concurrence reale sur ces lignes,
 * et ça evite de devoir creer une fonction SQL par table.
 */
import type { Backend, FindOpts, Row, Where } from './db.js';

export interface RestOpts {
  /** `https://<ref>.supabase.co` — le suffixe `/rest/v1` est ajoute tout seul. */
  url: string;
  /** Cle `service_role` (JWT `eyJ…`). */
  key: string;
  /** Defaut : `public`. */
  schema?: string;
  timeoutMs?: number;
  /** Injecté dans les tests. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const nom = (s: string): string => {
  if (!IDENT.test(s)) throw new Error(`nom de table ou de colonne invalide côté API : ${s}`);
  return s;
};

/** Valeur -> JSON envoye. Les objets/tablentent deja en jsonb, on ne les stringifie pas. */
const enc = (v: unknown): unknown => (v === undefined ? null : v instanceof Date ? v.toISOString() : v);

const encodeCorps = (r: Row): Row => {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[nom(k)] = enc(v);
  return out;
};

/** Une element d'une liste `in.(…)`, cite s'il s'agit d'une chaine. */
const inEl = (v: unknown): string => {
  const brut = typeof v === 'string' ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : String(v ?? 'null');
  return encodeURIComponent(brut);
};

/**
 * `Where` -> filtres PostgREST. `null` renvoye = la liste etait vide, donc AUCUNE ligne ne peut
 * matcher : on raccourcit cote client au lieu d'inventer un filtre tautologique.
 */
export function filtres(w: Where | undefined): string[] | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(w ?? {})) {
    const col = nom(k);
    if (Array.isArray(v)) {
      if (!v.length) return null;
      parts.push(`${col}=in.(${v.map(inEl).join(',')})`);
    } else if (v === null || v === undefined) {
      parts.push(`${col}=is.null`);
    } else {
      parts.push(`${col}=eq.${encodeURIComponent(String(enc(v)))}`);
    }
  }
  return parts;
}

export class RestBackend implements Backend {
  readonly mode = 'rest' as const;
  private readonly base: string;
  private readonly timeout: number;
  private readonly f: typeof fetch;
  private avertiSchema = false;

  constructor(private o: RestOpts & { url: string; key: string; schema: string; timeoutMs: number }) {
    this.base = `${this.o.url.replace(/\/+$/, '').replace(/\/rest\/v1$/, '')}/rest/v1`;
    this.timeout = this.o.timeoutMs;
    this.f = this.o.fetchImpl ?? fetch;
  }

  private async req(
    method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE',
    chemin: string,
    o: { query?: string[]; body?: unknown; prefer?: string; objet?: boolean } = {},
  ): Promise<{ rows: Row[]; count: number | null }> {
    const q = o.query?.length ? `?${o.query.join('&')}` : '';
    const url = `${this.base}${chemin}${q}`;
    const headers: Record<string, string> = {
      apikey: this.o.key,
      authorization: `Bearer ${this.o.key}`,
      accept: o.objet ? 'application/vnd.pgrst.object+json' : 'application/json',
    };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.prefer) headers.prefer = o.prefer;
    if (this.o.schema !== 'public') {
      headers['content-profile'] = this.o.schema;
      headers['accept-profile'] = this.o.schema;
    }
    let res: Response;
    try {
      res = await this.f(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(this.timeout) });
    } catch (e) {
      const m = (e as Error)?.name === 'TimeoutError' ? `délai dépassé (${Math.round(this.timeout / 1000)} s)` : `réseau : ${(e as Error).message}`;
      throw new Error(`Supabase injoignable (${m}) — Edge garde la main sur Discord, les données attendront.`);
    }
    const texte = method === 'HEAD' ? '' : await res.text();
    if (!res.ok) throw new Error(this.piege(res.status, texte, chemin));
    let range = res.headers.get('content-range');
    let count: number | null = null;
    if (range && range.includes('/')) count = Number(range.split('/')[1]) || null;
    if (method === 'HEAD' || !texte.trim()) return { rows: [], count };
    let data: unknown;
    try { data = JSON.parse(texte); } catch {
      throw new Error(`réponse de Supabase illisible (HTTP ${res.status}) : ${texte.slice(0, 160)}`);
    }
    const rows = Array.isArray(data) ? data as Row[] : [data as Row];
    if (count === null && o.prefer?.includes('count=exact')) count = rows.length;
    return { rows, count };
  }

  /** Un message comprehensible plutot qu'un code PostgREST. */
  private piege(status: number, texte: string, chemin: string): string {
    let j: { code?: string; message?: string; hint?: string; details?: string } = {};
    try { j = JSON.parse(texte); } catch { /* proxy HTML, page de maintenance… */ }
    if (status === 404 || j.code === 'PGRST202' || j.code === '42P01') {
      return `Supabase ne connaît pas ${chemin.replace(/^\//, '')} (HTTP ${status}${j.code ? ` ${j.code}` : ''}).`
        + ' → colle de nouveau supabase/schema.sql dans l’éditeur SQL, puis Project Settings → API → « Restart / reload schema cache ».';
    }
    if (status === 401 || status === 403) {
      return `Supabase a refusé la clé (HTTP ${status}) : SUPABASE_SERVICE_ROLE_KEY doit être la clé **service_role**, pas anon, et l’API doit être activée sur le projet.`;
    }
    if (status >= 500) return `Supabase est en panne (HTTP ${status})${j.message ? ` : ${j.message}` : ''}`;
    const morceaux = [j.message, j.details, j.hint && `indice : ${j.hint}`, j.code && `(${j.code})`].filter(Boolean);
    return `Supabase a répondu HTTP ${status}${morceaux.length ? ` : ${morceaux.join(' · ')}` : ` (${texte.slice(0, 160)})`}`;
  }

  private avertirSchema(): void {
    if (this.avertiSchema) return;
    this.avertiSchema = true;
    this.o.log?.('l’API Supabase répond : pense à coller supabase/schema.sql si les tables manquent.');
  }

  async insert(table: string, row: Row): Promise<Row> {
    const { rows } = await this.req('POST', `/${nom(table)}`, { body: encodeCorps(row), prefer: 'return=representation' });
    return rows[0] ?? row;
  }

  async all(table: string, opts: FindOpts): Promise<Row[]> {
    const f = filtres(opts.where);
    if (f === null) return [];
    const q = ['select=*', ...f];
    if (opts.orderBy) q.push(`order=${nom(opts.orderBy)}.${opts.desc ? 'desc' : 'asc'}`);
    if (opts.limit) q.push(`limit=${Number(opts.limit)}`);
    const { rows } = await this.req('GET', `/${nom(table)}`, { query: q });
    return rows;
  }

  async count(table: string, where?: Where): Promise<number> {
    const f = filtres(where);
    if (f === null) return 0;
    const { count } = await this.req('GET', `/${nom(table)}`, { query: ['select=*', 'limit=0', ...f], prefer: 'count=exact' });
    return count ?? (await this.all(table, { where })).length;
  }

  async update(table: string, where: Where, patch: Row): Promise<Row | null> {
    const f = filtres(where);
    if (f === null) return null;
    const { rows } = await this.req('PATCH', `/${nom(table)}`, { query: f, body: encodeCorps(patch), prefer: 'return=representation' });
    return rows[0] ?? null;
  }

  async remove(table: string, where: Where): Promise<number> {
    const f = filtres(where);
    if (f === null) return 0;
    const { rows } = await this.req('DELETE', `/${nom(table)}`, { query: f, prefer: 'return=representation' });
    return rows.length;
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
    const { rows } = await this.req('POST', `/rpc/${nom(fn)}`, { body: args });
    return rows.map((r) => (Object.keys(r).length === 1 && fn in r ? (r[fn] as T) : (r as unknown as T))) as T[];
  }

  /** Pas de SQL brut par HTTP : c'est justement ce qu'on voulait eviter. */
  async raw<T>(): Promise<T[]> {
    throw new Error('SQL brut indisponible en mode API : colle la requête dans l’éditeur SQL de Supabase (le schéma complet est dans supabase/schema.sql), ou repasse par DATABASE_URL en connexion directe.');
  }

  async ping(): Promise<boolean> {
    try {
      await this.req('GET', '/kv_store', { query: ['select=key', 'limit=1'] });
      return true;
    } catch (e) {
      if (/ne connaît pas/.test((e as Error).message)) this.avertirSchema();
      this.o.log?.(`API Supabase : ${(e as Error).message}`);
      return false;
    }
  }
}
