/** Routage des interactions : slash, boutons, menus deroulants, modales, menus contextuels. */
import {
  ApplicationCommandType, MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction,
  type CommandInteraction, type GuildMember, type Interaction, type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction, type StringSelectMenuInteraction, type UserContextMenuCommandInteraction,
} from 'discord.js';

type AnyCommand = ChatInputCommandInteraction | MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction;
type AnyComponent = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
import type { Ctx, CommandDef, ComponentHandler, EdgeModule } from './module.js';
import type { Guard } from './module.js';
import { fr } from './copy.js';
import { atLeast, bits, isOwner } from './perms.js';
import { roleDef } from '../manifest.js';
import { briderReponses } from './safe-reply.js';

export interface Dispatch {
  commands: Map<string, { mod: string; def: CommandDef }>;
  components: Map<string, { mod: string; h: ComponentHandler }>;
  modules: EdgeModule[];
}

const PREFIX = 'edge';

export function buildDispatch(ctx: Ctx, modules: EdgeModule[]): Dispatch {
  const d: Dispatch = { commands: new Map(), components: new Map(), modules };
  for (const m of modules) {
    for (const def of m.commands?.(ctx) ?? []) d.commands.set(def.data.name, { mod: m.key, def });
    for (const [action, h] of Object.entries(m.components?.(ctx) ?? {})) d.components.set(`${m.key}:${action}`, { mod: m.key, h });
  }
  return d;
}

/** Envoi la liste des commandes sur la guilde (sync instantanee, pas de delay global). */
export async function syncCommands(ctx: Ctx, d: Dispatch): Promise<{ n: number; skipped: boolean }> {
  const payload = [...d.commands.values()].map((c) => c.def.data.toJSON());
  const shape = (payload as { name?: string; options?: unknown[] }[]).map((p) => `${p.name}:${(p.options ?? []).length}`).join('|');
  const hash = `${JSON.stringify(payload).length}:${shape}`;
  const seen = await ctx.db.kv.get<string>('cmdhash');
  if (seen === hash) return { n: payload.length, skipped: true };
  await ctx.guild.commands.set(payload as never);
  await ctx.db.kv.set('cmdhash', hash);
  return { n: payload.length, skipped: false };
}

async function checkGuard(ctx: Ctx, guard: Guard | undefined, i: CommandInteraction): Promise<string | null> {
  if (!i.inGuild() || i.guildId !== ctx.guild.id) return fr.noGuild;
  const member = i.member as GuildMember | null;
  if (!member) return 'Impossible de te situer sur ce serveur.';
  if (guard?.ownerOnly && !isOwner(member) && !atLeast(member, 'fondateur', ctx.s.idx)) return fr.noPerm(roleDef('fondateur').name);
  if (guard?.min && !atLeast(member, guard.min, ctx.s.idx)) return fr.noPerm(roleDef(guard.min).name);
  if (guard?.staff && !atLeast(member, 'helper', ctx.s.idx)) return fr.noPerm(roleDef('helper').name);
  if (guard?.perms?.length) {
    const need = bits(guard.perms);
    if (!member.permissions.has(need)) return `Permission requise en plus : ${guard.perms.join(' + ')}.`;
  }
  return null;
}

const cooldowns = new Map<string, number>();
function checkCooldown(key: string, ms: number): number | null {
  const until = cooldowns.get(key) ?? 0;
  const now = Date.now();
  if (until > now) return Math.ceil((until - now) / 1000);
  cooldowns.set(key, now + ms);
  return null;
}

/** Point d'entree unique de toutes les interactions. */
export async function handleInteraction(ctx: Ctx, d: Dispatch, i: Interaction): Promise<void> {
  try {
    if (i.isChatInputCommand() || i.isUserContextMenuCommand() || i.isMessageContextMenuCommand()) return await runCommand(ctx, d, i);
    if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) return await runComponent(ctx, d, i as AnyComponent);
    if (i.isAutocomplete()) return;
  } catch (e) {
    ctx.log.error(`interaction ${i.isRepliable() ? 'en erreur' : 'perdue'}`, (e as Error)?.message ?? String(e));
    await safeFail(ctx, i, e as Error);
  }
}

async function runCommand(ctx: Ctx, d: Dispatch, i: AnyCommand): Promise<void> {
  const entry = d.commands.get(i.commandName);
  if (!entry) return;
  if (!(await ctx.on(entry.mod))) return void (await i.reply({ content: fr.moduleOff(entry.mod), flags: MessageFlags.Ephemeral }));
  const why = await checkGuard(ctx, entry.def.guard, i);
  if (why) return void (await i.reply({ content: why, flags: MessageFlags.Ephemeral }));
  if (entry.def.cooldownMs) {
    const left = checkCooldown(`${entry.mod}:${i.user.id}`, entry.def.cooldownMs);
    if (left) return void (await i.reply({ content: fr.tooFast(left), flags: MessageFlags.Ephemeral }));
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  // Le filet : un module qui oublie de tronquer son texte ne doit pas valoir a l'utilisateur un
  // « Invalid Form Body » et a toi un bug introuvable. Ce qui ne rentre passe dans la suite.
  briderReponses(i, (n) => ctx.log.debug(`/ ${i.commandName} : ${n} message(s) de suite (content > 2000)`));
  await entry.def.run(ctx, i as ChatInputCommandInteraction);
  await ctx.db.track('command', { mod: entry.mod, cmd: i.commandName, user: i.user.id, guild: i.guildId });
  if (!i.deferred) await i.editReply({ content: '…rien à signaler.' });
}

async function runComponent(ctx: Ctx, d: Dispatch, i: AnyComponent): Promise<void> {
  const raw = i.customId;
  if (!raw.startsWith(`${PREFIX}:`)) return;
  const parts = raw.split(':');
  const action = parts.slice(2).join(':');
  const mod = parts[1]!;
  const entry = d.components.get(action) ?? d.components.get(`${mod}:${parts[2]}`);
  if (!entry) return void (await i.reply({ content: '⌛ Ce bouton est périmé (module retiré ou panneau à re-publier).', flags: MessageFlags.Ephemeral }).catch(() => void 0));
  if (!(await ctx.on(entry.mod))) return void (await i.reply({ content: fr.moduleOff(entry.mod), flags: MessageFlags.Ephemeral }));
  briderReponses(i, (n) => ctx.log.debug(`// ${raw} : ${n} suite(s) (content > 2000)`));
  await entry.h(ctx, i as never, parts.slice(3));
  await ctx.db.track('component', { mod: entry.mod, id: raw, user: i.user.id });
}

async function safeFail(ctx: Ctx, i: Interaction, e: Error): Promise<void> {
  if (!i.isRepliable()) return;
  const dbIssue = /fetch|ECONN|ETIMEDOUT|relation|does not exist|PG/i.test(e.message);
  const text = dbIssue ? fr.dbDown : `🥴 \`${e.message.slice(0, 300)}\``;
  const anyI = i as unknown as { replied: boolean; deferred: boolean; editReply?: (x: unknown) => Promise<unknown>; followUp?: (x: unknown) => Promise<unknown>; reply: (x: unknown) => Promise<unknown> };
  try {
    if (anyI.replied || anyI.deferred) await (anyI.editReply?.({ content: text }) ?? anyI.followUp?.({ content: text }));
    else await anyI.reply({ content: text, flags: MessageFlags.Ephemeral });
  } catch { /* channel deleted, member gone… on ne rejoue pas */ }
}

export const commandTypeLabel = (t: ApplicationCommandType): string => (t === ApplicationCommandType.ChatInput ? 'slash' : t === ApplicationCommandType.User ? 'menu utilisateur' : 'menu message');
