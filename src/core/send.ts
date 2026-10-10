/** Aides d'envoi : le ton d'Edge est texte simple + embeds seulement quand ca sert. */
import {
  EmbedBuilder, type AttachmentBuilder, type GuildMember, type Message, type TextChannel, ChannelType,
} from 'discord.js';
import { CHANNEL_DEFS, COLORS, type ChannelKey, type RoleKey } from '../manifest.js';
import type { Ctx } from './module.js';
import { emit, type LogKind } from './logs.js';
import { roleIds } from './perms.js';
import { truncate } from './ui.js';

/** Le canal texte attendu, ou null (module non monte => on ne casse pas le handler). */
export function text(ctx: Ctx, k: ChannelKey): TextChannel | null {
  const c = ctx.s.channel(k);
  return c && c.type === ChannelType.GuildText ? c : null;
}
export function mustText(ctx: Ctx, k: ChannelKey): TextChannel {
  const c = text(ctx, k);
  if (!c) throw new Error(`salon texte indisponible : ${k}`);
  return c;
}

/**
 * Un reglage de type « salon » peut donner soit une cle du manifeste (`modLogs`), soit un
 * identifiant Discord (`1234…` ou `<#1234…>`). On resout les deux, et on retombe sur le salon
 * prevu par le manifeste si le choix pointe dans le vide — un reglage casse ne doit jamais
 * couper une fonctionnalite.
 */
export async function canalSelon(ctx: Ctx, brut: unknown, defaut: ChannelKey): Promise<TextChannel> {
  const cle = typeof brut === 'string' ? brut.trim().replace(/^<#|>$/g, '') : '';
  if (/^\d{15,21}$/.test(cle)) {
    const direct = ctx.guild.channels.cache.get(cle) ?? await ctx.guild.channels.fetch(cle).catch(() => null);
    if (direct && direct.type === ChannelType.GuildText) return direct;
    ctx.log.warn(`salon ${cle} regle mais introuvable : je reviens a ${defaut}`);
  } else if (cle && CHANNEL_DEFS.some((d) => d.key === cle)) {
    const trouve = text(ctx, cle as ChannelKey);
    if (trouve) return trouve;
  }
  return mustText(ctx, defaut);
}

export const roleMention = (ctx: Ctx, k: RoleKey): string => `<@&${roleIds(ctx.s.idx, k)}>`;
export const userMention = (id: string): string => `<@${id}>`;

/** Envoi simple, ping optionnel des roles de notification. */
export async function say(
  ctx: Ctx,
  k: ChannelKey,
  content: string,
  opts: { roles?: RoleKey[]; embeds?: EmbedBuilder[]; components?: unknown[]; files?: AttachmentBuilder[]; replyTo?: string } = {},
): Promise<Message | null> {
  const ch = text(ctx, k);
  if (!ch) return null;
  return ch
    .send({
      content: content.slice(0, 2000),
      embeds: opts.embeds?.length ? opts.embeds : undefined,
      components: opts.components as never,
      files: opts.files,
      reply: opts.replyTo ? { messageReference: opts.replyTo } : undefined,
      allowedMentions: { parse: opts.roles?.length && style.pingsRoles ? ['users', 'roles'] : ['users'], repliedUser: false },
    })
    .catch((e: Error) => { ctx.log.warn(`envoi raté dans ${k} : ${e.message}`); return null; });
}

/**
 * Le style global, pose par /edge config (general.couleur, general.pied_de_page,
 * general.pings_roles). Un module qui passe une couleur explicite la garde : ici on ne
 * definit que le defaut, jamais on n'ecrase un choix local.
 */
let style: { couleur?: number; pied?: string; pingsRoles: boolean } = { pingsRoles: true };
export const definirStyle = (s: Partial<typeof style>): void => { style = { ...style, ...s }; };
export const lireStyle = (): Readonly<typeof style> => style;

export interface EmbedOpts { title?: string; desc?: string; color?: number; fields?: { name: string; value: string; inline?: boolean }[]; footer?: string; footerIcon?: string; image?: string; thumbnail?: string; author?: string; url?: string }
export const embed = (o: EmbedOpts): EmbedBuilder => {
  const e = new EmbedBuilder().setColor(o.color ?? style.couleur ?? COLORS.edge);
  if (o.title) e.setTitle(truncate(o.title, 250));
  if (o.desc) e.setDescription(truncate(o.desc, 4000));
  if (o.url) e.setURL(o.url);
  if (o.fields?.length) e.addFields(o.fields.slice(0, 25).map((f) => ({ name: truncate(f.name, 250), value: truncate(f.value, 1000), inline: !!f.inline })));
  const pied = o.footer ?? style.pied;
  if (pied) e.setFooter({ text: truncate(pied, 200), ...(o.footerIcon ? { iconURL: o.footerIcon } : {}) });
  if (o.author) e.setAuthor({ name: truncate(o.author, 250) });
  if (o.image) e.setImage(o.image);
  if (o.thumbnail) e.setThumbnail(o.thumbnail);
  return e;
};

/** Ligne lisible copiée dans un salon de log du staff. */
export const logLine = (kind: LogKind, line: string): void => emit(kind, line);

/** Un membre peut-il pinguer ce rôle dans ce salon ? (verif Discord reelle, pas le modele) */
export function canPingReal(ctx: Ctx, member: GuildMember | null, target: RoleKey, ch: TextChannel): boolean {
  if (!member) return false;
  const role = ctx.guild.roles.cache.get(roleIds(ctx.s.idx, target));
  if (!role) return false;
  const perms = ch.permissionsFor(member);
  if (!perms?.has('SendMessages')) return false;
  return role.mentionable || perms.has('MentionEveryone');
}

export async function member(ctx: Ctx, id: string): Promise<GuildMember | null> {
  return ctx.guild.members.fetch(id).catch(() => null);
}

export const fmtMember = (m: GuildMember | null, fallbackId: string): string => (m ? `${m.user.username} (${fallbackId})` : `\`${fallbackId}\` (hors serveur)`);
/** Lien cliquable vers un message (les 3 IDs sont obligatoires, d'ou le passage par ctx). */
export const jump = (ctx: Ctx, chId: string | null | undefined, msgId: string | null | undefined): string =>
  chId && msgId ? `https://discord.com/channels/${ctx.guild.id}/${chId}/${msgId}` : '';
