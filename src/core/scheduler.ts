/**
 * Ordonnanceur persistant : les fins de giveaway, les relances de partenariat,
 * les annonces programmees et les beats de maintenance survivent a un redemarrage,
 * parce qu'ils vivent dans `scheduler_jobs` et pas dans un setTimeout.
 */
import type { Ctx, JobDef } from './module.js';
import type { Row } from '../db/db.js';

export class Scheduler {
  private defs = new Map<string, JobDef>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly who = `${process.pid}-${Date.now().toString(36)}`;

  constructor(private ctxFor: () => Ctx) {}

  register(def: JobDef): void {
    if (this.defs.has(def.kind)) throw new Error(`job déjà enregistré: ${def.kind}`);
    this.defs.set(def.kind, def);
  }

  /** Programme (ou remplace) l'execution de `kind` pour `refKey`. */
  async at(kind: string, refKey: string, when: Date, payload: Row = {}): Promise<void> {
    await this.ctxFor().db.upsert(
      'scheduler_jobs',
      ['kind', 'ref_key'],
      { kind, ref_key: refKey, run_at: when, status: 'pending', payload, attempts: 0 },
      { kind, ref_key: refKey, run_at: when, status: 'pending', payload, attempts: 0, locked_by: null, done_at: null, last_error: null },
    );
  }

  async cancel(kind: string, refKey: string): Promise<void> {
    await this.ctxFor().db.delete('scheduler_jobs', { kind, ref_key: refKey, status: 'pending' });
  }

  async has(kind: string, refKey: string): Promise<boolean> {
    return Boolean(await this.ctxFor().db.one('scheduler_jobs', { kind, ref_key: refKey, status: 'pending' }));
  }

  start(tickMs = 20_000): void {
    void this.armIntervals();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** S'assure que chaque job periodique a un prochain run en attente. */
  private async armIntervals(): Promise<void> {
    const ctx = this.ctxFor();
    for (const def of this.defs.values()) {
      if (!def.everyMs) continue;
      if (!(await this.has(def.kind, 'beat'))) await this.at(def.kind, 'beat', new Date(Date.now() + def.everyMs));
    }
  }

  /** Un tour : ramasse les jobs dus, les execute, rearme ou enterre. */
  async tick(now = new Date()): Promise<{ ran: number; failed: number }> {
    if (this.ticking) return { ran: 0, failed: 0 };
    this.ticking = true;
    const ctx = this.ctxFor();
    let ran = 0, failed = 0;
    try {
      const pending = await ctx.db.all('scheduler_jobs', { where: { status: 'pending' } });
      const due = pending.filter((j) => new Date(j.run_at as string).getTime() <= now.getTime()).sort((a, b) => new Date(a.run_at as string).getTime() - new Date(b.run_at as string).getTime());
      for (const job of due) {
        const kind = String(job.kind);
        const def = this.defs.get(kind);
        if (!def) { await ctx.db.update('scheduler_jobs', { id: String(job.id) }, { status: 'orphan', last_error: 'no handler' }); continue; }
        const claimed = await ctx.db.update('scheduler_jobs', { id: String(job.id), status: 'pending' }, { status: 'running', locked_by: this.who });
        if (!claimed) continue; // un autre tick (ou un autre process) l'a deja pris
        try {
          if (def.everyMs || (await ctx.on(kind))) await def.run(ctx, (job.payload as Row) ?? {});
          if (def.everyMs) await this.at(def.kind, 'beat', new Date(Date.now() + def.everyMs));
          else await ctx.db.delete('scheduler_jobs', { id: String(job.id) });
          ran++;
        } catch (e) {
          failed++;
          const attempts = Number(job.attempts ?? 0) + 1;
          const backoff = Math.min(3_600_000, 60_000 * 2 ** attempts);
          await ctx.db.update('scheduler_jobs', { id: String(job.id) }, {
            status: attempts >= 6 ? 'failed' : 'pending', attempts, locked_by: null,
            run_at: new Date(Date.now() + backoff), last_error: String((e as Error).message).slice(0, 480),
          });
          ctx.log.error(`job ${kind} raté (essai ${attempts})`, (e as Error).message);
        }
      }
    } finally {
      this.ticking = false;
    }
    return { ran, failed };
  }
}
