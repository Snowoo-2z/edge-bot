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
  hasDb: Boolean(parsed.data.DATABASE_URL),
  hasToken: Boolean(parsed.data.DISCORD_TOKEN),
  /** Plateforme detectee, pour des logs parlants. */
  platform: process.env.RENDER === 'true' ? 'render' : process.env.FLY_APP_NAME ? 'fly' : process.env.RAILWAY_ENVIRONMENT_NAME ? 'railway' : process.env.NORTHFLANK_APP_NAME ? 'northflank' : 'local',
};

/** La valeur par défaut de EDGE_REQUIRE_MESSAGE_CONTENT est un booléen zod transformé ; on relit la brute. */
export const rawRequireContent = process.env.EDGE_REQUIRE_MESSAGE_CONTENT;

export function assertRunnable(): void {
  if (!env.dryRun && !env.hasToken) {
    throw new Error('DISCORD_TOKEN manquant. Mets-le dans .env, ou lance `npm run dry` pour simuler sans token.');
  }
}
