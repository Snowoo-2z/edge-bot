/**
 * Messages persistants (panneau reglement, selfroles, ouverture de ticket,
 * presentation) : publies une fois, re-synchronises a chaque boot, jamais dupliques.
 * On stocke l'ID du message dans kv_store -> aucune dependance a un canal de config.
 */
import type { TextChannel } from 'discord.js';
import type { Ctx } from './module.js';

export interface PanelSpec {
  key: string;
  channel: TextChannel;
  build: () => { content?: string; components?: unknown[]; embeds?: unknown[] };
  /** true = edit meme si le contenu n'a pas change (pour garder le bouton actif). */
  alwaysEdit?: boolean;
}

export async function ensurePanel(ctx: Ctx, spec: PanelSpec): Promise<'created' | 'updated' | 'missing' | 'stale'> {
  const kvKey = `panel:${spec.key}`;
  const body = spec.build();
  const stored = await ctx.db.kv.get<{ id: string; channel: string; hash: string }>(kvKey);
  const hash = JSON.stringify(body).slice(0, 2000);

  if (stored?.id && stored.channel === spec.channel.id) {
    try {
      const msg = await spec.channel.messages.fetch(stored.id);
      if (hash !== stored.hash || spec.alwaysEdit) await msg.edit(body as never);
      await ctx.db.kv.set(kvKey, { ...stored, hash });
      return 'updated';
    } catch {
      /* message supprime : on repart en creation */
    }
  }
  const sent = await spec.channel.send(body as never);
  await ctx.db.kv.set(kvKey, { id: sent.id, channel: spec.channel.id, hash });
  return 'created';
}

/** Retire la memoire d'un panneau (pour /edge panel reset). */
export async function forgetPanel(ctx: Ctx, key: string): Promise<void> { await ctx.db.kv.del(`panel:${key}`); }
