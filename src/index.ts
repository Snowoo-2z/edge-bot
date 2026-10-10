/** Entree d'Edge. */
import { env } from './env.js';
import { boot } from './core/client.js';
import { Logger } from './core/logger.js';
import { MODULES } from './modules/index.js';
import { runDry } from './dryrun/harness.js';

const log = new Logger('main');

if (env.dryRun) {
  await runDry();
  process.exit(0);
}
if (!env.hasToken) {
  log.error('DISCORD_TOKEN manquant dans .env. Pour simuler sans token : `npm run dry`.');
  process.exit(1);
}

try {
  const b = await boot(MODULES);
  const stop = async (sig: string): Promise<void> => {
    log.info(`${sig} : arrêt propre (ordnanceur coupé, commandes laissées en place).`);
    b.sched.stop();
    await b.client.destroy().catch(() => void 0);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', String(e)));
} catch (e) {
  log.error('Edge n’a pas pu démarrer', (e as Error).message);
  process.exit(1);
}
