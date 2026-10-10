/** Tirage au sort pondere, deterministe si on injecte un rng (tests) — sinon crypto. */
import { randomBytes } from 'node:crypto';

export interface Weighted { userId: string; weight: number }
type Rand = () => number;

const cryptoRand: Rand = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

/**
 * Selectionne `k` gagnants sans remise, ponderes.
 * Algorithme : cumul des poids + tirage uniforme. `Math.random` n'est jamais utilise.
 */
export function weightedDraw<T extends Weighted>(entries: T[], k: number, rand: Rand = cryptoRand): T[] {
  const pool = entries.filter((e) => e.weight > 0);
  const out: T[] = [];
  const taken = new Set<string>();
  const picks = Math.min(Math.max(0, k), pool.length);
  for (let i = 0; i < picks; i++) {
    const avail = pool.filter((e) => !taken.has(e.userId));
    if (!avail.length) break;
    const total = avail.reduce((s, e) => s + e.weight, 0);
    let target = rand() * total;
    let chosen = avail[avail.length - 1]!;
    for (const e of avail) { target -= e.weight; if (target <= 0) { chosen = e; break; } }
    out.push(chosen);
    taken.add(chosen.userId);
  }
  return out;
}

/** rng mulberry32 : uniquement pour les tests (reproductibilite). */
export function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Carte de chaleur : verification que la ponderation est bien respectee (utilisée en test). */
export function distribution(entries: Weighted[], draws: number, rand: Rand = cryptoRand): Map<string, number> {
  const c = new Map<string, number>();
  for (let i = 0; i < draws; i++) {
    const w = weightedDraw(entries, 1, rand)[0];
    if (w) c.set(w.userId, (c.get(w.userId) ?? 0) + 1);
  }
  return c;
}
