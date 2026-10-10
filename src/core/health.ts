/**
 * Sante HTTP pour les hebergeurs. Koyeb, Render, Fly et Railway veulent tous un port
 * qui repond : sans lui, soit le deploiement est tenu pour casse, soit le service part
 * en veille — et un bot Discord en veille ne repond plus a personne.
 *
 * GET /health → 200 tout le temps, meme pendant le demarrage. Une sonde de vivacite ne
 *               doit JAMAIS faire redemarrer Edge en boucle : c'est le piege classique.
 * GET /ready  → 200 seulement quand Discord et la base sont operationnels.
 * GET /       → une ligne lisible, pour toi dans un navigateur.
 *
 * Rien ici ne fuit un secret : pas de token, pas d'URL de base, pas de variable d'env.
 */
import { createServer, get as httpGet, type Server } from 'node:http';
import type { Boot } from './client.js';

export interface Status {
  vivant: true;
  pret: boolean;
  raison?: string;
  tag?: string;
  serveur?: string;
  membres?: number;
  latenceWsMs?: number;
  base: 'ok' | 'absente' | 'ko';
  modulesActifs: number;
  modulesCoupes: [string, string][];
  jobs: number;
  ordonnanceur: boolean;
  uptimeS: number;
  /** Octets residentiels — sur un plan gratuit a 512 Mo, c'est la premiere chose a regarder. */
  ramMb: number;
  version: string;
}

export interface HealthHandle {
  port: number;
  close: () => Promise<void>;
}

export interface HealthOpts {
  port: number;
  /** Peut etre async : un ping base peut trainer, on ne bloque pas la sonde pour autant. */
  status: () => Status | Promise<Status>;
  log?: (msg: string) => void;
  /** Koyeb/Railway exposent la variable PORT ; on écoute sur 0.0.0.0 obligatoirement. */
  host?: string;
}

const TIMEOUT_MS = 1_500;

/** Le corps de /health, construit a partir de l'etat reel du bot. */
export function statusOf(b: Boot | null, whyNotReady?: string): Status {
  const base: Status = {
    vivant: true,
    pret: false,
    base: 'absente',
    modulesActifs: 0,
    modulesCoupes: [],
    jobs: 0,
    ordonnanceur: false,
    uptimeS: Math.round(process.uptime()),
    ramMb: Math.round(process.memoryUsage().rss / 1_048_576),
    version: process.env.npm_package_version ?? '0.1.0',
  };
  if (!b) return { ...base, raison: whyNotReady ?? 'démarrage' };
  const ping = b.client.ws.ping;
  return {
    ...base,
    pret: true,
    tag: b.client.user.tag,
    serveur: b.ctx.guild.name,
    membres: b.ctx.guild.memberCount,
    latenceWsMs: ping > 0 ? Math.round(ping) : undefined,
    base: b.db.isPersisted ? 'ok' : 'absente',
    modulesActifs: 0,
    modulesCoupes: [...b.disabled.entries()],
    jobs: b.sched.jobCount,
    ordonnanceur: b.sched.running,
  };
}

/**
 * Coupe le serveur quand `port` est defini (les hebergeurs le fournissent) ou quand
 * `EDGE_HEALTH=true` force l'ouverture locale. Renvoie null sinon : en dev, Edge
 * n'ouvre aucun port et ne peut donc rien ecraser.
 */
export function startHealth(opts: HealthOpts): HealthHandle | null {
  if (!Number.isFinite(opts.port) || opts.port <= 0) return null;
  const srv: Server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    let st: Status;
    try {
      st = await withTimeout(Promise.resolve(opts.status()), TIMEOUT_MS);
    } catch (e) {
      st = { vivant: true, pret: false, raison: `état indisponible: ${(e as Error).message}`, base: 'ko', modulesActifs: 0, modulesCoupes: [], jobs: 0, ordonnanceur: false, uptimeS: Math.round(process.uptime()), ramMb: 0, version: '0.0.0' };
    }
    const json = (code: number, body: unknown): void => {
      const data = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
      res.end(data);
    };
    if (url === '/health') return json(200, st);
    if (url === '/ready') return json(st.pret ? 200 : 503, st);
    if (url === '/' || url === '/edge') {
      const ligne = st.pret
        ? `Edge · ${st.tag} · ${st.serveur} · ${st.membres} membres · ${st.modulesCoupes.length ? `${st.modulesCoupes.length} module(s) coupé(s)` : 'tous les modules actifs'} · base ${st.base} · ${st.ramMb} Mo · uptime ${Math.floor(st.uptimeS / 3600)}h${String(Math.floor((st.uptimeS % 3600) / 60)).padStart(2, '0')}m`
        : `Edge démarre… (${st.raison ?? 'connexion'})`;
      res.writeHead(st.pret ? 200 : 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(`${ligne}\n`);
    }
    return json(404, { erreur: 'inconnu', routes: ['/health', '/ready', '/'] });
  });
  srv.on('error', (e: NodeJS.ErrnoException) => {
    // Un port deja pris ne doit pas tuer le bot : la partie Discord est independante.
    (opts.log ?? ((m: string) => void 0))(`sonde HTTP indisponible (${e.code ?? e.message}) — le bot tourne quand même`);
    srv.close();
  });
  srv.listen(opts.port, opts.host ?? '0.0.0.0', () => opts.log?.(`sonde de santé sur http://0.0.0.0:${opts.port}/health`));
  srv.unref?.();
  return { port: opts.port, close: () => new Promise<void>((resolve) => (srv.listening ? srv.close(() => resolve()) : resolve())) };
}

/** Certains plans gratuits endorment un service qui ne recoit aucun appel entrant. */
export function startKeepalive(url: string, everyMs = 4 * 60_000, log?: (msg: string) => void): () => void {
  let dejaAverti = false;
  const ping = (): void => {
    const req = httpGet(url, (res) => {
      res.resume();
      if (!dejaAverti && res.statusCode && res.statusCode >= 400) {
        dejaAverti = true;
        log?.(`keep-alive répond ${res.statusCode} — vérifie KEEPALIVE_URL`);
      }
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', () => {
      if (dejaAverti) return;
      dejaAverti = true;
      log?.(`keep-alive injoignable (${url}) — je réessaie en silence`);
    });
  };
  const timer = setInterval(ping, Math.max(60_000, everyMs));
  timer.unref?.();
  ping();
  return () => clearInterval(timer);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let to: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { to = setTimeout(() => rej(new Error(`sonde trop lente (${ms}ms)`)), ms); to.unref?.(); })]);
  } finally {
    if (to) clearTimeout(to);
  }
}
