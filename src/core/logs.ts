import { env } from '../env.js';

export type LogKind = 'moderation' | 'ticket' | 'staff' | 'ops';
export type Sink = (kind: LogKind, line: string) => void;

const C = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', off: '\x1b[0m' };
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[env.logLevel] ?? 20;

let lineNo = 0;
const started = Date.now();

export const log = {
  debug: (m: string, x?: unknown) => at(10, `${C.dim}debug${C.off} ${m}${x ? ' ' + JSON.stringify(x) : ''}`),
  info: (m: string, x?: unknown) => at(20, `${C.cyan}info ${C.off} ${m}${x ? ' ' + JSON.stringify(x) : ''}`),
  warn: (m: string, x?: unknown) => at(30, `${C.yellow}warn ${C.off} ${m}${x ? ' ' + JSON.stringify(x) : ''}`),
  error: (m: string, e?: unknown) => at(40, `${C.red}error${C.off} ${m} ${e instanceof Error ? e.message : e ? JSON.stringify(e) : ''}`),
  ok: (m: string) => at(20, `${C.green}ok   ${C.off} ${m}`),
};

function at(level: number, msg: string): void {
  if (level < min) return;
  const t = Math.round((Date.now() - started) / 100) / 10;
  process.stdout.write(`${C.dim}${String(++lineNo).padStart(3, '0')} ${t.toFixed(1)}s${C.off} ${msg}\n`);
}

/** Miroir dans les salons de log du serveur (sink branché côté discord). */
const sinks = new Map<LogKind, Set<Sink>>();
export function onLog(kind: LogKind, sink: Sink): () => void {
  (sinks.get(kind) ?? sinks.set(kind, new Set()).get(kind)!).add(sink);
  return () => sinks.get(kind)!.delete(sink);
}
export function emit(kind: LogKind, line: string): void {
  for (const s of sinks.get(kind) ?? []) {
    void Promise.resolve(s(kind, line)).catch(() => void 0);
  }
}
