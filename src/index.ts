/**
 * Entree d'Edge.
 *
 * Deux modes : `EDGE_DRY_RUN=true` => simulation de structure sans connexion ;
 * sinon demarrage reel, avec une sonde HTTP sur $PORT pour les hebergeurs.
 *
 * Un bot n'est pas un site web : une panne reseau de Discord ou un serveur pas encore
 * invite n'est pas fatal. On garde le processus VIVANT (la sonde repond, l'hebergeur
 * ne le tue pas) et on reessaie avec un retard qui grandit.
 */
import { env } from './env.js';
import { boot, type Boot } from './core/client.js';
import { Logger } from './core/logger.js';
import { MODULES } from './modules/index.js';
import { runDry } from './dryrun/harness.js';
import { startHealth, startKeepalive, statusOf, type Status } from './core/health.js';

const log = new Logger('main');

if (env.dryRun) {
  await runDry();
  process.exit(0);
}
if (!env.hasToken) {
  log.error('DISCORD_TOKEN manquant dans .env. Pour simuler sans token : `npm run dry`.');
  process.exit(1);
}

let etat: Boot | null = null;
let raison = 'connexion à Discord…';

/** Ce que lit /health : la verite d'aujourd'hui, pas l'etat d'il y a une heure. */
async function snapshot(): Promise<Status> {
  const st = statusOf(etat, raison);
  if (etat) {
    st.modulesActifs = MODULES.length - etat.disabled.size;
    if (st.base === 'ok') {
      try { st.base = (await etat.db.ping()) ? 'ok' : 'ko'; } catch { st.base = 'ko'; }
      if (st.base !== 'ok') { st.pret = false; st.raison = 'base de données injoignable (les modules stockés sont coupés)'; }
    }
    if (!etat.ctx.guild.available) { st.pret = false; st.raison = 'serveur pas encore visible (synchronisation Discord)'; }
  }
  return st;
}

// Sur un hebergeur, PORT est fourni par la plateforme : la sonde s'ouvre et prouve
// qu'Edge vit meme pendant une coupure Discord. En local, aucun port n'est ouvert.
const sonde = startHealth({ port: env.port, status: snapshot, log: (m) => log.info(m) });
if (env.port === 0) log.debug('pas de PORT => sonde HTTP fermée (normal en local, exigée par Northflank/Render/Fly)');

let reveil: (() => void) | null = null;
if (env.keepaliveUrl) {
  reveil = startKeepalive(env.keepaliveUrl, env.keepaliveMs, (m) => log.info(m));
  log.info(`keep-alive toutes les ${Math.round(env.keepaliveMs / 60_000)} min vers ${env.keepaliveUrl}`);
}

const arreter = async (sig: string): Promise<void> => {
  log.info(`${sig} : arrêt propre (sonde fermée, ordonnanceur coupé, commandes laissées en place).`);
  reveil?.();
  await sonde?.close().catch(() => void 0);
  etat?.sched.stop();
  await etat?.client.destroy().catch(() => void 0);
  process.exit(0);
};
process.on('SIGINT', () => void arreter('SIGINT'));
process.on('SIGTERM', () => void arreter('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', String(e)));

const RETARDS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const MAX_LOCAL = 3;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let essai = 0;
for (;;) {
  try {
    const b = await boot(MODULES, (w) => { raison = w; });
    etat = b;
    raison = '';
    essai = 0;
    const coupes = [...b.disabled.entries()];
    log.info(`${MODULES.length - coupes.length}/${MODULES.length} modules actifs${coupes.length ? ` · coupés : ${coupes.map(([k, why]) => `${k} (${why})`).join(', ')}` : ''}`);
    if (b.drift.some((d) => d.level === 'error')) log.warn(`${b.drift.filter((d) => d.level === 'error').length} écart(s) bloquant(s) de structure → /audit structure`);
    break;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    raison = msg;
    essai++;
    // Sans port de sonde (donc hors hebergeur), on n'endort pas un terminal pendant
    // dix minutes pour un token errone : on sort, avec le message.
    if (env.port === 0 && essai >= MAX_LOCAL) {
      log.error(`Edge n’a pas pu démarrer (${msg}) — trois essais, j’arrête là.`);
      await sonde?.close().catch(() => void 0);
      process.exit(1);
    }
    const attente = RETARDS[Math.min(essai - 1, RETARDS.length - 1)]!;
    log.warn(`démarrage raté (${msg}) — nouvelle tentative dans ${Math.round(attente / 1000)} s.`);
    await sleep(attente);
  }
}
