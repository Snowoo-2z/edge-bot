/** Contrat commun des modules d'Edge : un module = commandes + composants + evenements + jobs. */
import type {
  ButtonInteraction, ChatInputCommandInteraction, Client, ContextMenuCommandBuilder, Guild,
  ModalSubmitInteraction, SlashCommandBuilder, StringSelectMenuInteraction,
} from 'discord.js';
import type { Row, Db } from '../db/db.js';
import type { Resolved } from './structure.js';
import type { Scheduler } from './scheduler.js';
import type { CategoryKey, ChannelKey, PermName, RoleKey } from '../manifest.js';
import type { Logger } from './logger.js';

export interface Ctx {
  client: Client<true>;
  guild: Guild;
  db: Db;
  sched: Scheduler;
  s: Resolved;
  log: Logger;
  /** Intent MessageContent obtenu (sinon automod/XP se coupent). */
  content: boolean;
  /** Un module est on si son flag l'est et si ses dependances sont reunies. */
  on(key: string): Promise<boolean>;
  disabled: Map<string, string>;
}

export interface Guard {
  /** Role minimum (hierarchie logique du manifeste). */
  min?: RoleKey;
  /** Helper et au-dessus. */
  staff?: boolean;
  /** Permission Discord requise en plus. */
  perms?: PermName[];
  /** Owner du serveur ou Fondateur uniquement. */
  ownerOnly?: boolean;
}

export interface CommandDef {
  data: SlashCommandBuilder | ContextMenuCommandBuilder;
  guard?: Guard;
  cooldownMs?: number;
  run: (ctx: Ctx, i: AnyCommandInteraction) => Promise<unknown>;
}

export type AnyComponentInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
/**
 * Les handlers de commande reçoivent une slash command. Un menu contextuel (clic droit)
 * est declare comme une commande normale et cadre `i` lui-meme : `i` porte alors `targetId`
 * / `target`, et `i.options` est vide.
 */
export type AnyCommandInteraction = ChatInputCommandInteraction & { targetId?: string; target?: unknown };
/**
 * Les handlers sont ecrits avec le type precis de l'interaction (ButtonInteraction, …).
 * `i: any` ici evite la variance stricte qui refuserait un handler plus specifique.
 * Le routeur ne passe que les 3 types ci-dessus.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentHandler = (ctx: Ctx, i: any, args: string[]) => unknown;

export interface ListenerDef {
  /** Un evenement du client discord.js (Events.GuildMemberAdd, …). */
  event: string;
  once?: boolean;
  // args non typables generiquement sur un registre dynamique -> on cadre a l'interieur du module
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (ctx: Ctx, ...args: any[]) => unknown;
}

export interface JobDef {
  kind: string;
  /** Relance automatique toutes les N millisecondes. */
  everyMs?: number;
  run: (ctx: Ctx, payload: Row) => Promise<void>;
}

export interface Needs {
  roles?: RoleKey[];
  channels?: ChannelKey[];
  categories?: CategoryKey[];
  perms?: PermName[];
  /** Necesite MessageContent (sinon coupe proprement). */
  content?: boolean;
  /** Necesite une base persistante (Supabase) : un memory-store ne suffit pas. */
  db?: boolean;
}

export interface EdgeModule {
  key: string;
  label: string;
  needs?: Needs;
  commands?: (ctx: Ctx) => CommandDef[];
  components?: (ctx: Ctx) => Record<string, ComponentHandler>;
  listeners?: (ctx: Ctx) => ListenerDef[];
  jobs?: (ctx: Ctx) => JobDef[];
  /** Publie/re synchronise les messages persistants (panneaux). */
  panels?: (ctx: Ctx) => Promise<void>;
  /** Rattrapage apres un redemarrage (giveaways en cours, tickets orphelins...). */
  sync?: (ctx: Ctx) => Promise<void>;
}

export const customId = (mod: string, action: string, ...args: (string | number)[]): string =>
  ['edge', mod, action, ...args].join(':');
