import 'dotenv/config';
import { z } from 'zod';

const boolish = z
  .enum(['true', 'false', '1', '0', 'on', 'off', 'yes', 'no'])
  .default('false')
  .transform((v) => ['true', '1', 'on', 'yes'].includes(v));

const Schema = z.object({
  DISCORD_TOKEN: z.string().min(20).optional(),
  GUILD_ID: z.string().min(5).default('1558076024778919946'),
  DATABASE_URL: z.string().min(10).optional(),
  EDGE_DRY_RUN: boolish,
  EDGE_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`.env invalide:\n${parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
}

export const env = {
  ...parsed.data,
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
