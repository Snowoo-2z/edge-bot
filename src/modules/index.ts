/**
 * Registree des modules d'Edge, dans l'ordre de demarrage.
 * Retirer une ligne ici suffit a desactiver un module (commandes, listeners, jobs, panneaux).
 */
import type { EdgeModule } from '../core/module.js';
import { welcome } from './welcome.js';
import { rules } from './rules.js';
import { presentation } from './presentation.js';
import { selfroles } from './selfroles.js';
import { tickets } from './tickets.js';
import { moderation } from './moderation.js';
import { automod } from './automod.js';
import { antiraid } from './antiraid.js';
import { reports } from './reports.js';
import { audit } from './audit.js';
import { giveaway } from './giveaway.js';
import { polls } from './polls.js';
import { levels } from './levels.js';
import { voice } from './voice.js';
import { events } from './events.js';
import { boosts } from './boosts.js';
import { announcements } from './announcements.js';
import { suggestions } from './suggestions.js';
import { invites } from './invites.js';
import { partnership } from './partnership.js';
import { recruitment } from './recruitment.js';
import { botadmin } from './botadmin.js';
import { helpModule } from './help.js';

/** Socle -> jour 1 utile -> animation -> blindage -> sur-mesure -> retention. */
export const MODULES: EdgeModule[] = [
  welcome, rules, presentation, selfroles,
  tickets, moderation, audit,
  giveaway, polls, boosts, announcements, events,
  automod, antiraid, reports,
  partnership, recruitment, suggestions, invites,
  levels, voice,
  botadmin, helpModule,
];

export const moduleKeys = MODULES.map((m) => m.key);
