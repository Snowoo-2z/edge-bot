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
  // Un hebergeur (Koyeb, Render, Fly, Railway) fournit PORT : sans port qui repond,
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

export const env = {
  ...parsed.data,
  /** Port de la sonde HTTP (0 = pas de sonde). */
  port: parsed.data.PORT ? Number(parsed.data.PORT) : parsed.data.EDGE_HEALTH ? 8080 : 0,
  keepaliveUrl: parsed.data.KEEPALIVE_URL,
  keepaliveMs: parsed.data.EDGE_KEEPALIVE_MINUTES ? Number(parsed.data.EDGE_KEEPALIVE_MINUTES) * 60_000 : 4 * 60_000,
  /** true => Edge ne touche pas Discord, il simule et rapporte. */
  dryRun: parsed.data.EDGE_DRY_RUN,
  /** L'intent MessageContent est privilegie : on ne le demande que si decide explicitement. */
  contentIntent: (process.env.EDGE_REQUIRE_MESSAGE_CONTENT ?? 'true').toLowerCase() !== 'false',
  logLevel: parsed.data.EDGE_LOG_LEVEL,
  hasDb: Boolean(parsed.data.DATABASE_URL),
  hasToken: Boolean(parsed.data.DISCORD_TOKEN),
};

/** La valeur par défaut de EDGE_REQUIRE_MESSAGE_CONTENT est un booléen zod transformé ; on relit la brute. */
export const rawRequireContent = process.env.EDGE_REQUIRE_MESSAGE_CONTENT;

export function assertRunnable(): void {
  if (!env.dryRun && !env.hasToken) {
    throw new Error('DISCORD_TOKEN manquant. Mets-le dans .env, ou lance `npm run dry` pour simuler sans token.');
  }
}
