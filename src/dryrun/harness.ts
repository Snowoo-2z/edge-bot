/**
 * `npm run dry` : Edge ne se connecte pas, il simule 5 etats possibles du serveur
 * et dit ce qu'il verrait (modules coupes, derives bloquantes, invariants de ping).
 * Utile avant d'ajouter le bot, et pour verifier qu'un renommage ne casse pas tout.
 */
import { resolveStructure, driftReport } from '../core/structure.js';
import { INVARIANTS } from '../core/permmodel.js';
import { MODULES } from '../modules/index.js';
import { fakeGuild, type FakeOpts } from './fake.js';
import { log } from '../core/logs.js';
import { reason } from '../core/client.js';

interface Scenario { name: string; opts: FakeOpts; auMoins: number; contient: string[]; modulesCoupes?: number }

/** Chaque scenario decrit un serveur volontairement abime : Edge doit le voir. */
export const SCENARIOS: Scenario[] = [
  { name: 'serveur conforme a ton message', opts: {}, auMoins: 0, contient: [] },
  { name: 'un salon renomme a la main', opts: { renameChannel: ['discussion', '💬│・Chat'] }, auMoins: 1, contient: ['salon manquant'], modulesCoupes: 1 },
  { name: 'un role oublie (Animateur)', opts: { dropRole: 'animateur' }, auMoins: 1, contient: ['rôle manquant'], modulesCoupes: 2 },
  { name: 'un salon supprime (📣│・Annonces)', opts: { dropChannel: 'annonces' }, auMoins: 1, contient: ['salon manquant'], modulesCoupes: 2 },
  { name: '@everyone voit les categories privees', opts: { leakPrivate: true }, auMoins: 1, contient: ['FUITE'] },
  { name: 'role Edge place trop haut', opts: { edgeTooHigh: true }, auMoins: 1, contient: ['trop haut'] },
  { name: 'Edge sans MentionEveryone', opts: { edgeNoMention: true }, auMoins: 1, contient: ['MentionEveryone'] },
  { name: 'un salon en plus hors manifeste', opts: { extraChannel: '💬│・Old' }, auMoins: 0, contient: ['hors manifeste'] },
];

/** Un scenario, sesresultats bruts (reutilises par les tests). */
export function scenario(opts: FakeOpts): { erreurs: ReturnType<typeof driftReport>; coupes: number; texte: string } {
  const guild = fakeGuild(opts);
  const r = resolveStructure(guild);
  const drift = driftReport(r);
  const erreurs = drift.filter((d) => d.level === 'error');
  let coupes = 0;
  for (const m of MODULES) if (reason(m, r as never, { content: true, db: { isPersisted: true } } as never)) coupes++;
  return { erreurs, coupes, texte: drift.map((d) => `${d.area} ${d.what}`).join(' | ') };
}

export async function runDry(): Promise<void> {
  console.log('\n\x1b[1m🧪 Edge — simulation de structure (aucune connexion Discord)\x1b[0m');
  console.log(`manifeste : ${MODULES.length} modules, ${INVARIANTS.length} invariants de ping\n`);

  for (const sc of SCENARIOS) {
    const { erreurs, coupes, texte } = scenario(sc.opts);
    const trouve = sc.contient.every((mot) => texte.includes(mot));
    const ok = erreurs.length >= sc.auMoins && trouve && (sc.modulesCoupes === undefined || coupes === sc.modulesCoupes);
    console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} \x1b[1m${sc.name}\x1b[0m`);
    console.log(`   bloquants=${erreurs.length} (min ${sc.auMoins}) · modules coupés=${coupes}${sc.modulesCoupes !== undefined ? ` (attendu ${sc.modulesCoupes})` : ''}`);
    for (const d of erreurs.slice(0, 3)) console.log(`     · ${d.area} — ${d.what}`);
    if (!ok) process.exitCode = 1;
  }

  console.log('\n\x1b[1m📡 Invariants de ping (le modele, pas le papier)\x1b[0m');
  for (const v of INVARIANTS) {
    const got = v.check();
    console.log(`${got === v.attendu ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${v.id} — ${v.description}`);
  }
  console.log('\n\x1b[1m🧩 Modules\x1b[0m');
  for (const m of MODULES) console.log(`   · ${m.key.padEnd(13)} ${m.label}${m.needs ? ` — requiert ${[...(m.needs.channels ?? []), ...(m.needs.roles ?? []), ...(m.needs.perms ?? [])].length} dépendance(s)` : ''}`);
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) await runDry();
