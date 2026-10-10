import { env } from '../env.js';
import { emit, type LogKind } from './logs.js';

const C = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', off: '\x1b[0m' };
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Petits moyens, grosses consequences : TOUTES les methodes sont des fleches fixees sur
 * l'instance. Un logger se passe partout — `forEach(log.warn)`, `[log.error]`, la ternaire
 * `cond ? log.warn : log.info` du rapport d'ecarts — et des qu'une methode quitte son objet,
 * `this` vaut undefined : la methode privee `at` devient « Cannot read properties of undefined
 * (reading 'at') » et, comme elle etait appelee dans le demarrage, Edge bouclait sans jamais
 * dire d'ou ca venait. Render, 2026-10-10. Une fleche par methode, et le piege disparait
 * pour tous les callers, presents et futurs.
 */
export class Logger {
  constructor(private scope: string, private min = LEVELS[env.logLevel] ?? 20) {}
  child = (scope: string): Logger => new Logger(`${this.scope}:${scope}`, this.min);
  debug = (m: string, x?: unknown): void => { this.at(10, `${C.dim}debug${C.off}`, m, x); };
  info = (m: string, x?: unknown): void => { this.at(20, `${C.cyan}info ${C.off}`, m, x); };
  ok = (m: string): void => { this.at(20, `${C.green}ok   ${C.off}`, m); };
  warn = (m: string, x?: unknown): void => { this.at(30, `${C.yellow}warn ${C.off}`, m, x); };
  error = (m: string, x?: unknown): void => { this.at(40, `${C.red}error${C.off}`, m, x); };
  /** Copie lisible dans un salon de log du serveur. */
  line = (kind: LogKind, text: string): void => { emit(kind, `[${this.scope}] ${text}`); };
  private at(level: number, tag: string, m: string, x?: unknown): void {
    if (level < this.min) return;
    const extra = x === undefined ? '' : ` ${typeof x === 'string' ? x : JSON.stringify(x)}`;
    process.stdout.write(`${tag} ${C.dim}${this.scope}${C.off} ${m}${extra}\n`);
  }
}
