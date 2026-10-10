import 'dotenv/config';
import { z } from 'zod';

/** Une variable presentee mais vide vaut « absente » : `DISCORD_TOKEN=` ne doit pas faire echouer le demarrage. */
const vide = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const chaineOpt = (min: number) => z.preprocess(vide, z.string().optional().refine((s) => s === undefined || s.length >= min, `au moins ${min} caracteres (ou vide)`));
const booleen = (d: 'true' | 'false') => z.preprocess(vide, z.enum(['true', 'false', '1', '0', 'on', 'off', 'yes', 'no']).default(d).transform((v) => ['true', '1', 'on', 'yes'].includes(v)));

const Schema = z.object({
  DISCORD_TOKEN: chaineOpt(20),
  GUILD_ID: z.preprocess(vide, z.string().min(5).default('1558076024778919946')),
  DATABASE_URL: chaineOpt(10),
  // Voie recommandee vers Supabase : son API HTTP. Pas de mot de passe de base, pas de pooler,
  // pas d'IP a autoriser. Voir supabase/schema.sql (a coller dans l'editeur SQL).
  SUPABASE_URL: chaineOpt(4),
  SUPABASE_SERVICE_ROLE_KEY: chaineOpt(20),
  SUPABASE_SCHEMA: chaineOpt(2),
  EDGE_DRY_RUN: booleen('false'),
  EDGE_LOG_LEVEL: z.preprocess(vide, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
  // Les trois variables ci-dessous ne servent QU'AU DEPLOIEMENT (voir README § 7).
  // Un hebergeur (Northflank, Render, Fly, Railway) fournit PORT : sans port qui repond,
  // il juge le service casse ou l'endort, et le bot disparait du serveur.
  PORT: z.preprocess(vide, z.string().optional().refine((s) => s === undefined || /^\d{2,5}$/.test(s), 'PORT doit etre un numero de port (ou vide)')),
  EDGE_HEALTH: booleen('false'),
  KEEPALIVE_URL: chaineOpt(12),
  EDGE_KEEPALIVE_MINUTES: z.preprocess(vide, z.string().optional().refine((s) => s === undefined || /^\d{1,4}$/.test(s), 'EDGE_KEEPALIVE_MINUTES doit etre un nombre de minutes')),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`.env invalide:\n${parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
}

/**
 * Port d ecoute de la sonde. Regles par plateforme, dans l ordre :
 *   1. PORT fourni par l hebergeur (Render, Railway, Fly, Northflank si tu le figes) ;
 *   2. Render sans PORT => 10000, son port de routage par defaut (docs/render/environment-variables) ;
 *   3. EDGE_HEALTH=true => 8080, pour tester la sonde en local ;
 *   4. sinon 0 = aucun port ouvert (mode local, ne peut rien ecraser).
 * Exporte pur pour etre teste sans toucher a process.env.
 */
export function resolvePort(raw: { PORT?: string; EDGE_HEALTH?: boolean; RENDER?: string }): number {
  const brut = Number(raw.PORT ?? 0);
  if (Number.isFinite(brut) && brut > 0) return brut;
  if (String(raw.RENDER ?? '').toLowerCase() === 'true') return 10_000;
  if (raw.EDGE_HEALTH) return 8_080;
  return 0;
}

/**
 * L autoping. Un plan qui dort sur inactivite (Render free) se reveille a la premiere
 * requete ENTRANTE : donc tant qu'Edge est eveille, il se frappe lui-meme sa propre URL
 * publique et ne laisse jamais l'horloge d'inactivite arriver au bout.
 *   1. KEEPALIVE_URL explicite (n importe quelle plateforme) ;
 *   2. RENDER_EXTERNAL_URL, que Render injecte tout seul => zero reglage a faire ;
 *   3. sinon rien : le workflow GitHub (deploy/autoping-github.yml -> .github/workflows/) prend le relais.
 * Note : un process DEJA endormi a son minuteur gele avec lui ; lui seul ne peut pas
 * se reveiller. C'est pour ca qu il y a un second filet, externe, dans GitHub Actions.
 */
export function resolveKeepalive(raw: { KEEPALIVE_URL?: string; RENDER_EXTERNAL_URL?: string }): string | undefined {
  if (raw.KEEPALIVE_URL) return raw.KEEPALIVE_URL;
  const ext = raw.RENDER_EXTERNAL_URL?.trim().replace(/\/+$/, '');
  if (ext && /^https?:\/\//i.test(ext)) return `${ext}/health`;
  return undefined;
}

/**
 * Configures le acces a Supabase par son API (PostgREST). Pur et exporte pour etre teste.
 *
 * Tolérant sur la forme de `SUPABASE_URL`, parce que le tableau de bord Supabase n'affiche pas
 * la meme chaine selon l'endroit ou on la copie :
 *   `https://abc.def.supabase.co`, `abc.supabase.co/`, `https://abc.supabase.co/rest/v1`,
 *   ou meme la reference nue `abc.def` (20 caractères, comme dans l'URL du dashboard).
 * La cle peut etre donnee par `SUPABASE_SERVICE_ROLE_KEY` ou l'alias `SUPABASE_KEY`.
 * Renvoie null si les deux pieces ne sont pas la (alors on regarde DATABASE_URL, puis memoire).
 */
export function resolveSupabase(raw: {
  SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; SUPABASE_KEY?: string; SUPABASE_SCHEMA?: string;
}): { url: string; key: string; schema: string } | null {
  const key = (raw.SUPABASE_SERVICE_ROLE_KEY ?? raw.SUPABASE_KEY ?? '').trim();
  let u = (raw.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  if (!u) return null;
  if (!/:\/\//.test(u)) {
    const ref = u.includes('.') ? u.split('.')[0]! : u;
    if (!/^[a-z0-9]{8,24}$/.test(ref)) return null;
    u = `https://${ref}.supabase.co`;
  }
  if (!/^https:\/\//i.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(u)) return null;
  if (!key) return null;
  return { url: u, key, schema: (raw.SUPABASE_SCHEMA ?? 'public').trim() || 'public' };
}

/**
 * Le role encode DANS le JWT, pour distinguer `anon` de `service_role` sans appeler personne :
 * les deux se ressemblent comme deux gouttes d'eau et seule la seconde a le droit d'ecrire.
 */
export function jwtRole(cle: string | undefined | null): string | null {
  if (!cle) return null;
  const payload = cle.trim().split('.')[1];
  if (!payload) return null;
  try {
    const j = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof j?.role === 'string' ? j.role : null;
  } catch { return null; }
}

/** Ce qui cloche dans la config Supabase, ou null si tout est cohérent. */
export function supabaseProblem(raw: { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; SUPABASE_KEY?: string }): string | null {
  const u = (raw.SUPABASE_URL ?? '').trim();
  const k = (raw.SUPABASE_SERVICE_ROLE_KEY ?? raw.SUPABASE_KEY ?? '').trim();
  if (!u && !k) return null;
  if (u && !k) return 'SUPABASE_URL est défini mais aucune clé : ajoute SUPABASE_SERVICE_ROLE_KEY (Project Settings → API → « service_role secret »).';
  if (!u && k) return 'une clé Supabase est définie mais pas SUPABASE_URL : ajoute https://<reference>.supabase.co.';
  if (u && !resolveSupabase(raw)) return `SUPABASE_URL « ${u.slice(0, 48)} » n'est pas compréhensible : attendu https://<reference>.supabase.co.`;
  const role = jwtRole(k);
  if (role && role !== 'service_role') return `la clé fournie est de rôle « ${role} » : PostgREST a besoin de la **service_role**, sinon Edge ne peut rien écrire.`;
  return null;
}

const supabase = resolveSupabase({ ...parsed.data, SUPABASE_KEY: process.env.SUPABASE_KEY });

export const env = {
  ...parsed.data,
  /** Port de la sonde HTTP (0 = pas de sonde). */
  // Les variables que la plateforme injecte ne sont pas dans le schema (elles ne sont pas
  // a saisir dans .env) : on les relit a la source.
  port: resolvePort({ PORT: process.env.PORT, EDGE_HEALTH: parsed.data.EDGE_HEALTH, RENDER: process.env.RENDER }),
  keepaliveUrl: resolveKeepalive({ KEEPALIVE_URL: parsed.data.KEEPALIVE_URL, RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL }),
  keepaliveMs: parsed.data.EDGE_KEEPALIVE_MINUTES ? Number(parsed.data.EDGE_KEEPALIVE_MINUTES) * 60_000 : 4 * 60_000,
  /** true => Edge ne touche pas Discord, il simule et rapporte. */
  dryRun: parsed.data.EDGE_DRY_RUN,
  /** L'intent MessageContent est privilegie : on ne le demande que si decide explicitement. */
  contentIntent: (process.env.EDGE_REQUIRE_MESSAGE_CONTENT ?? 'true').toLowerCase() !== 'false',
  logLevel: parsed.data.EDGE_LOG_LEVEL,
  /** null = pas d'API Supabase configurée (on retombe sur DATABASE_URL, puis sur la mémoire). */
  supabase,
  hasDb: Boolean(supabase ?? parsed.data.DATABASE_URL),
  hasToken: Boolean(parsed.data.DISCORD_TOKEN),
  /** Plateforme detectee, pour des logs parlants. */
  platform: process.env.RENDER === 'true' ? 'render' : process.env.FLY_APP_NAME ? 'fly' : process.env.RAILWAY_ENVIRONMENT_NAME ? 'railway' : process.env.NORTHFLANK_APP_NAME ? 'northflank' : 'local',
};

/** La valeur par défaut de EDGE_REQUIRE_MESSAGE_CONTENT est un booléen zod transformé ; on relit la brute. */
export const rawRequireContent = process.env.EDGE_REQUIRE_MESSAGE_CONTENT;

/**
 * Un mauvais `DATABASE_URL` est la panne n°1 d'un deploiement, et pg repond alors une ligne
 * illegible (« invalid connection » ou « parse errors in connection string »). On regarde la
 * FORME de la valeur, on ne se prononce jamais sur le mot de passe.
 * Renvoie null si rien n'est suspect.
 */
export function dbUrlProblem(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const points = (s.match(/\./g) ?? []).length;
  if (/^eyJ/i.test(s) && points >= 2) {
    return "on dirait une clé d'API Supabase, pas une URL Postgres. C'est normal de l'avoir sous la main, mais pg ne parle pas HTTP : soit tu la déplaces dans SUPABASE_SERVICE_ROLE_KEY (recommandé, avec SUPABASE_URL — voir README § 1), soit tu mets une vraie URL postgres:// avec le mot de passe de la base.";
  }
  if (!/^postgres(ql)?:\/\//i.test(s)) return 'should start with `postgres://` (Render appelle ça « Connection string »).';
  if (!s.includes('@')) return 'il manque `@hote:port/nom` — format attendu : postgres://postgres:<mot_de_passe>@<hote>:5432/postgres.';
  if (/@(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]/i.test(s)) return 'le serveur est local : depuis Render cette base est injoignable. Utilise la Connection string Supabase (hote publique).';
  const port = s.match(/:(\d{1,5})\//)?.[1];
  if (port && port !== '5432' && port !== '6543') return `port ${port} : Supabase sert 5432 (direct + session pooler) ou 6543 (transaction pooler).`;
  return null;
}

export function assertRunnable(): void {
  if (!env.dryRun && !env.hasToken) {
    throw new Error('DISCORD_TOKEN manquant. Mets-le dans .env, ou lance `npm run dry` pour simuler sans token.');
  }
}
