/**
 * Le filet anti `Invalid Form Body`.
 *
 * Discord refuse une réponse dont `content` dépasse 2000 caractères — et la commande échoue en
 * entier, avec un message technique pour l'utilisateur. Ça arrive dès qu'une liste s'allonge
 * (les 23 modules de `/aide`, une purge de logs, un classement d'invitations). Plutôt que de
 * demander à chaque module de penser à `.slice()`, on bride à la source, au point d'entrée des
 * réponses : ce qui ne rentre pas part dans un message suivant, rien n'est perdu, rien ne casse.
 *
 * Les embeds ne sont pas touchés : `embed()` tronque déjà son titre, sa description et ses
 * champs, et un embed coupé proprement reste lisible.
 */

export const LIMITE_CONTENU = 2000;
/** Une marge : Discord compte les emojis et les marques plus vite qu'on ne le croit. */
export const MARGE = 10;

/**
 * Découpe en pages qui passent toutes : on casse d'abord sur les fins de ligne, et une ligne
 * plus longue que le plafond est tranchée de force (sinon elle ne rentrera jamais nulle part).
 * Aucune page ne commence par un saut de ligne et aucune ligne n'est perdue.
 */
export function decouper(texte: string, taille = LIMITE_CONTENU - MARGE): string[] {
  const max = Math.max(200, Math.floor(taille));
  if (texte.length <= max) return [texte];
  const lignes: string[] = [];
  for (const ligne of texte.split('\n')) {
    if (ligne.length <= max) lignes.push(ligne);
    else for (const m of ligne.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) ?? [ligne.slice(0, max)]) lignes.push(m);
  }
  const pages: string[] = [];
  let courant = '';
  for (const l of lignes) {
    if (courant && courant.length + 1 + l.length > max) { pages.push(courant); courant = ''; }
    courant = courant ? `${courant}\n${l}` : l;
  }
  if (courant) pages.push(courant);
  return pages.length ? pages : ['…'];
}

type Objet = { content?: unknown; embeds?: unknown[]; components?: unknown[]; flags?: unknown; allowedMentions?: unknown };

/**
 * Renvoie le payload à envoyer en premier, et les suivants. Un payload sans `content` trop long
 * traverse tel quel : on ne touche pas à ce qui est déjà conforme.
 */
export function separer(p: unknown, taille = LIMITE_CONTENU - MARGE): { premier: unknown; suivants: string[] } {
  if (typeof p === 'string') return p.length <= taille ? { premier: p, suivants: [] } : (() => { const [a, ...b] = decouper(p, taille); return { premier: a ?? '…', suivants: b }; })();
  if (!p || typeof p !== 'object') return { premier: p, suivants: [] };
  const o = p as Objet;
  if (typeof o.content !== 'string' || o.content.length <= taille) return { premier: p, suivants: [] };
  const [a, ...b] = decouper(o.content, taille);
  const copie: Objet = { ...o, content: a ?? '…' };
  return { premier: copie, suivants: b };
}

interface Repondant {
  editReply?: (p: unknown) => Promise<unknown>;
  followUp?: (p: unknown) => Promise<unknown>;
  update?: (p: unknown) => Promise<unknown>;
}

/**
 * Emprisonne les trois voies de réponse d'une interaction. À appeler une seule fois, par le
 * routeur : les modules n'ont rien à savoir.
 */
export function briderReponses(i: unknown, signaler?: (n: number) => void): void {
  const r = i as Repondant & Record<string, unknown>;
  const gorille = (nom: 'editReply' | 'update') => {
    const original = r[nom];
    if (typeof original !== 'function') return;
    r[nom] = async (p: unknown) => {
      const { premier, suivants } = separer(p);
      const msg = await (original as (x: unknown) => Promise<unknown>).call(r, premier);
      for (const suite of suivants) {
        if (typeof r.followUp !== 'function') break;
        await Promise.resolve(r.followUp(typeof p === 'object' && p && (p as Objet).embeds ? { content: suite } : suite)).catch(() => void 0);
      }
      if (suivants.length) signaler?.(suivants.length);
      return msg;
    };
  };
  gorille('editReply');
  gorille('update');
  const reply = r.reply;
  if (typeof reply === 'function') {
    r.reply = async (p: unknown) => {
      const { premier } = separer(p);
      return (reply as (x: unknown) => Promise<unknown>).call(r, premier);
    };
  }
}
