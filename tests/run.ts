/**
 * `npm test` — petit harnais maison (aucune dependance de test a installer).
 * Tout ce qui est teste ici est pur : pas de connexion Discord, pas de base.
 * Les tests de structure passent par le faux serveur de src/dryrun/fake.ts.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { PermissionFlagsBits } from 'discord.js';
import { afterCheck, automodStep, escalate, isActive, pointsAfter, weightOf, AUTOMOD_LADDER, WARN_LADDER } from '../src/logic/ladders.js';
import { distribution, seeded, weightedDraw } from '../src/logic/draw.js';
import { duplicateScore, floodBurst, norm, scan } from '../src/logic/matchers.js';
import { at, bar, decouperOption, fmtDur, levelFromXp, parseDuration, slug, truncate, valeurOption, xpForLevel } from '../src/core/ui.js';
import { atLeast, canPingEveryone, canPingRole, canSeeChannel, canSelfAssign, canSpeakIn, effectivePerms, INVARIANTS, topLevel } from '../src/core/permmodel.js';
import { ASSIGNABLE_ROLES, BOT_PERMISSIONS, CATEGORY_DEFS, CHANNEL_DEFS, PERM_NAMES, ROLE_DEFS, TICKET_OPTIONS, expectedAcl, roleDef } from '../src/manifest.js';
import { Db } from '../src/db/db.js';
import { auditerSchema, lireTables, schemaDesMigrations } from './schema.js';
import { MODULES } from '../src/modules/index.js';
import { driftReport, resolveStructure } from '../src/core/structure.js';
import { fakeGuild } from '../src/dryrun/fake.js';
import { inviteUrl } from '../src/core/client.js';
import { fr } from '../src/core/copy.js';
import { startHealth, startKeepalive, statusOf } from '../src/core/health.js';
import { dbUrlProblem, env, jwtRole, resolveKeepalive, resolvePort, resolveSupabase, supabaseProblem } from '../src/env.js';
import { Logger } from '../src/core/logger.js';

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => void | Promise<void>): void => { tests.push({ name, fn }); };

const SCAN_OPTS = { inviteAllowed: false, guildId: '1558076024778919946', vanityCode: 'edgemode', maxMentions: 5, allowLinks: false, capsMinLength: 12 };
const hits = (text: string, kind: string, o = SCAN_OPTS): boolean => scan(text, o).some((h) => h.kind === kind);

/* ------------------------------------------------------------------ bareme sanctions */
test('bareme : note=0, 1 warn, 2 = timeout 1 h, 6 = ban a confirmer', () => {
  assert.deepEqual(WARN_LADDER.map((s) => s.action), ['note', 'warn', 'timeout', 'timeout', 'timeout', 'kick', 'ban']);
  assert.equal(escalate(-5).action, 'note', 'aucun point = note uniquement');
  assert.equal(escalate(0).action, 'note', 'une note ne doit jamais punir');
  assert.equal(escalate(1).action, 'warn');
  assert.equal(escalate(2).minutes, 60);
  assert.equal(escalate(4).minutes, 10_080, 'le maximum Discord est 7 jours');
  assert.equal(escalate(5).action, 'kick');
  assert.equal(escalate(99).action, 'ban');
  assert.match(escalate(99).label, /Admin/, 'le ban reste une decision humaine');
  for (const s of WARN_LADDER) assert.ok(s.label.length > 5);
});

test('points : note=0, pardon efface, unban=0', () => {
  assert.equal(pointsAfter(0, 'note'), 0);
  assert.equal(pointsAfter(2, 'timeout'), 3);
  assert.equal(pointsAfter(3, 'pardon'), 0);
  assert.equal(pointsAfter(1, 'unban'), 1);
});

test('un warn de plus de 60 jours ne compte plus', () => {
  const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - 3 * 86_400_000).toISOString();
  assert.equal(isActive({ type: 'warn', active: true, created_at: old }), false);
  assert.equal(isActive({ type: 'warn', active: true, created_at: fresh }), true);
});

/* ------------------------------------------------------------------ bareme automod */
test('automod : 1 hit = suppression, 3 = timeout, jamais de ban automatique', () => {
  assert.equal(automodStep(0).action, 'ignore', 'sans hit, on ne touche a rien');
  assert.equal(automodStep(1).action, 'delete');
  assert.equal(automodStep(3).minutes, 10);
  assert.equal(automodStep(4).minutes, 60);
  assert.equal(automodStep(7).action, 'ban_suggest');
  assert.ok(!AUTOMOD_LADDER.some((s) => (s.action as string) === 'ban'), 'le bot ne bannit jamais seul sur un compteur');
  const RANG: Record<string, number> = { ignore: 0, delete: 1, delete_warn: 2, timeout: 3, kick_suggest: 4, ban_suggest: 5 };
  let vu = 0;
  for (let h = 0; h <= 10; h++) { const s = automodStep(h); assert.ok(RANG[s.action]! >= vu, 'la severite ne redescend jamais'); vu = RANG[s.action]!; }
});

/* ------------------------------------------------------------------ partenariats */
test('partenariat : pause des le 1er raté, expiration au 3e, revive si ca repasse', () => {
  assert.deepEqual(afterCheck('pending', true, 0), { state: 'active', fails: 0 });
  assert.deepEqual(afterCheck('active', false, 0), { state: 'paused', fails: 1 });
  assert.deepEqual(afterCheck('paused', false, 2), { state: 'expired', fails: 3 });
  const relance = afterCheck('expired', true, 3);
  assert.deepEqual(relance, { state: 'expired', fails: 3 }, 'un dossier expire ne se rallume pas tout seul : /partenariat accepter');
});

test('pondérations giveaway : booster > animateur > partenaire > membre, sans cumul', () => {
  assert.ok(weightOf(['booster']) > weightOf(['animateur']));
  assert.ok(weightOf(['animateur']) > weightOf(['partenaire']));
  assert.ok(weightOf(['partenaire']) > weightOf(['membre']));
  assert.equal(weightOf([]), 1, 'sans rôle = poids 1');
  assert.equal(weightOf(['booster', 'animateur']), 2, 'on garde le meilleur poids : pas de cumul a empiler les rôles');
});

/* ------------------------------------------------------------------ tirage pondéré */
test('tirage pondéré : deterministe a graine egale, jamais de doublon', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ userId: `u${i}`, weight: i === 0 ? 5 : 1 }));
  const a = weightedDraw(entries, 3, seeded(42));
  const b = weightedDraw(entries, 3, seeded(42));
  assert.deepEqual(a.map((x) => x.userId), b.map((x) => x.userId));
  assert.equal(new Set(a.map((x) => x.userId)).size, 3);
  assert.equal(weightedDraw(entries, 99).length, 10, 'k > effectif = tout le monde, pas de crash');
  assert.equal(weightedDraw([], 3).length, 0);
});

test('tirage pondéré : le poids 5 sort nettement plus souvent que le poids 1', () => {
  const entries = [{ userId: 'gros', weight: 5 }, ...Array.from({ length: 5 }, (_, i) => ({ userId: `p${i}`, weight: 1 }))];
  const dist = distribution(entries, 600, seeded(7));
  const gros = dist.get('gros') ?? 0;
  const petit = Math.max(...entries.slice(1).map((e) => dist.get(e.userId) ?? 0));
  assert.ok(gros > petit, `attendu gros(${gros}) > petit(${petit})`);
});

/* ------------------------------------------------------------------ detecteurs */
test('detecteurs : invitation, webhook, token, mentions, majuscules, zalgo', () => {
  assert.ok(hits(' rejoins discord.gg/edge ', 'invite'));
  assert.ok(hits('c’est discord.com/invite/serveur', 'invite'));
  assert.ok(!hits('on a parlé du jeu discord aujourd’hui', 'invite'), 'le mot « discord » seul n’est pas une infraction');
  assert.ok(hits(`https://discord.com/api/webhooks/${'9'.repeat(18)}/${'t'.repeat(24)}`, 'webhook'), 'un webhook posté dans le chat doit partir');
  // Token FACTICE, construit par morceaux : un vrai motif « Mxyz...xxxx.xxxxxx.xxxxx... »
  // ferait sonner la protection anti-secrets de GitHub au push, et ce serait merite.
  const fauxJeton = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(30)}`;
  assert.ok(hits(fauxJeton, 'token'), 'un jeton posté dans le chat doit partir');
  assert.ok(hits('@everyone à tous', 'everyone_ping'));
  assert.ok(hits('<@1> <@2> <@3> <@4> <@5> <@6>', 'mass_mention'));
  assert.ok(!hits('<@1> <@2>', 'mass_mention'), 'mentionner deux potes est normal');
  assert.ok(hits('AAAAAAAAAAAAAAAAAAAA', 'caps'));
  assert.ok(!hits('ok', 'caps'), 'un « OK » tout court n’est pas du spam');
  assert.ok(hits('va voir https://exemple.com/article', 'link'));
  assert.ok(hits('á̵̫̊͝ͅb̸̜̈́̚ç', 'zalgo'));
});

test('detecteurs : nos propres liens ne sont pas sanctionnés', () => {
  const ici = { ...SCAN_OPTS, vanityCode: 'edge' };
  assert.ok(!hits('notre serveur : discord.gg/edge', 'invite', ici), 'le vanity du serveur doit rester libre');
  assert.ok(hits('notre serveur : discord.gg/pilleurs', 'invite', ici), 'un autre lien que le notre reste bloqué');
  assert.ok(!hits('lien mort discord.gg/introuvable', 'invite', { ...SCAN_OPTS, inviteAllowed: true }), '💌│・Invitations = pub autorisée');
});

test('flood et doublons : la repetition se voit, la ponctuation et les accents aussi', () => {
  assert.equal(floodBurst([{ text: 'pareil', at: 1_000 }, { text: 'pareil', at: 2_000 }, { text: 'pareil', at: 3_000 }], 3_000), true);
  assert.equal(floodBurst([{ text: 'a', at: 0 }, { text: 'b', at: 60_000 }], 61_000), false);
  assert.equal(duplicateScore(['salut ça va les gars'], 'Salut CA VA les gars !!!'), 1, 'accents et ponctuation ignorés');
  assert.equal(duplicateScore(['salut ça va'], 'non merci je passe'), 0);
  assert.equal(norm('Salut, ça va ?!'), norm('salut ca va'), 'norme commune = comparaison fiable');
});

/* ------------------------------------------------------------------ permissions */
test('les 10 invariants de ping du manifeste', () => {
  for (const v of INVARIANTS) assert.equal(v.check(), v.attendu, `invariant ${v.id} : ${v.description}`);
});

test('modele de permissions : cas limites', () => {
  assert.equal(atLeast(['membre'], 'mod'), false);
  assert.equal(atLeast(['mod'], 'mod'), true);
  assert.equal(atLeast(['admin'], 'mod'), true);
  assert.ok(topLevel(['mod']) < topLevel(['admin']), 'Modérateur doit être sous Administrateur');
  assert.ok(topLevel(['membre']) < topLevel(['helper']));
  assert.equal(topLevel([]), -1, 'sans rôle = au ras du sol');
  assert.equal(canPingRole(['membre'], 'notifGiveaway'), false);
  assert.equal(canPingRole(['animateur'], 'notifGiveaway', 'giveaway'), true);
  assert.equal(canPingEveryone(['membre'], 'discussion'), false);
  assert.equal(canSeeChannel(['membre'], 'staffChat'), false);
  assert.equal(canSeeChannel(['helper'], 'staffChat'), true);
  assert.equal(canSpeakIn(['helper'], 'modLogs'), false, 'Helper lit le journal, il n’y écrit pas');
  assert.equal(canSpeakIn(['mod'], 'modLogs'), true);
  assert.ok(effectivePerms(['admin'], 'discussion').has('Administrator'), 'Admin = Administrator, done');
});

test('selfroles : seules les roles annoncees sont proposables', () => {
  for (const k of ASSIGNABLE_ROLES) assert.ok(ASSIGNABLE_ROLES.includes(k));
  assert.equal(canSelfAssign('notifGiveaway'), true);
  assert.equal(canSelfAssign('notifPartenaire'), true);
  assert.equal(canSelfAssign('booster'), false, '✨│ Booster se donne par Palworld/le palier de boost, pas par le panneau');
  assert.equal(canSelfAssign('partenaire'), false, 'le rôle Partenaire est une décision de Manager');
  for (const k of ['mod', 'admin', 'fondateur', 'helper', 'manager'] as const) assert.equal(canSelfAssign(k), false, `${k} n’est jamais auto-attribuable`);
});

/* ------------------------------------------------------------------ manifeste */
test('manifeste : coherence des noms, categories et roles', () => {
  const names = new Set<string>();
  for (const r of ROLE_DEFS) {
    assert.ok(!names.has(r.name), `rôle en double : ${r.name}`);
    names.add(r.name);
    assert.match(r.name, /^[^\s]+│ \S/, `${r.name} : format « emoji │ Nom » comme sur ton serveur`);
    for (const p of r.perms) assert.ok(PERM_NAMES.includes(p), `permission inconnue « ${p} » sur ${r.name}`);
  }
  const cn = new Set<string>();
  for (const c of CHANNEL_DEFS) {
    assert.ok(!cn.has(c.name), `salon en double : ${c.name}`);
    cn.add(c.name);
    assert.ok(CATEGORY_DEFS.some((x) => x.key === c.cat), `catégorie inconnue pour ${c.name}`);
    assert.ok(c.name.length <= 100, `${c.name} dépasse les 100 caractères Discord`);
  }
  assert.equal(CHANNEL_DEFS.length, 30, '30 salons, comme dans ton message');
  assert.equal(CATEGORY_DEFS.length, 7, '7 catégories');
  assert.ok(ROLE_DEFS.length >= 11);
});

test('manifeste : un salon 🔒 reste muet pour @everyone mais pas pour Edge', () => {
  const locked = CHANNEL_DEFS.filter((d) => d.locked);
  assert.ok(locked.length >= 4, 'les salons 🔒 sont bien marqués');
  for (const def of locked) {
    const acl = expectedAcl(def);
    assert.ok(acl.everyone.deny.includes('SendMessages'), `${def.name} : SendMessages doit être refusé à @everyone`);
    assert.ok(!acl.everyone.allow.includes('SendMessages'), `${def.name} : @everyone ne doit pas avoir SendMessages`);
    assert.ok(acl.bot?.allow.includes('SendMessages'), `Edge doit pouvoir poster dans ${def.name} (@everyone muet ne veut pas dire bot muet)`);
  }
});

test('manifeste : tickets — 6 motifs, customIds < 100, rôles de ping mentionnables', () => {
  assert.equal(TICKET_OPTIONS.length, 6);
  for (const o of TICKET_OPTIONS) {
    assert.ok(`edge:ticket:type:${o.key}`.length <= 100, `customId trop long pour ${o.key}`);
    assert.ok(ROLE_DEFS.some((r) => r.key === o.ping), `rôle de ping inconnu : ${String(o.ping)}`);
    // Soit le role est publicablement mentionnable, soit c'est Edge qui le ping (il a MentionEveryone + ManageRoles).
    assert.ok(roleDef(o.ping).mentionable || (BOT_PERMISSIONS.includes('MentionEveryone') && BOT_PERMISSIONS.includes('ManageRoles')), `${o.ping} ne pourrait pas être pingé`);
    assert.ok(o.label.length > 2 && (o.emoji ?? '·').length > 0);
  }
});

test('manifeste : permissions du bot = assez, et rien de plus', () => {
  for (const p of BOT_PERMISSIONS) assert.ok(PERM_NAMES.includes(p), `permission inconnue : ${p}`);
  assert.ok(!BOT_PERMISSIONS.includes('Administrator'), 'Edge ne prend PAS Administrator (tu as dit « pas plus »)');
  for (const p of ['MentionEveryone', 'ManageRoles', 'ManageChannels', 'ModerateMembers', 'ViewAuditLog', 'ManageEvents', 'MoveMembers', 'MuteMembers']) {
    assert.ok(BOT_PERMISSIONS.includes(p as never), `il manque ${p} au bot`);
  }
  const url = inviteUrl('bot-test');
  assert.match(url, /scope=bot%20applications\.commands/);
  const given = BigInt(url.match(/permissions=(\d+)/)![1]!);
  const wanted = BOT_PERMISSIONS.reduce<bigint>((acc, p) => acc | (PermissionFlagsBits as unknown as Record<string, bigint>)[p], 0n);
  assert.equal(given, wanted, 'le lien d’invite doit demander exactement le manifeste');
});

/* ------------------------------------------------------------------ UI */
test('ui : durees, barres, dates, troncature', () => {
  assert.equal(parseDuration('1h30'), 5_400_000);
  assert.equal(parseDuration('2j'), 172_800_000);
  assert.equal(parseDuration('45 min'), 2_700_000);
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('bientôt'), null, 'entrée invalide = null, jamais NaN');
  assert.equal(fmtDur(0), '0s');
  assert.equal(fmtDur(3_725_000), '1h 2min', 'au-dela de la minute, les secondes ne font que du bruit');
  assert.equal(fmtDur(90_000), '1min 30s');
  assert.equal(fmtDur(86_400_000 + 3_600_000), '1j 1h');
  assert.equal(fmtDur(-60_000), '-1min');
  assert.equal(at(null), '—', 'une date manquante ne doit jamais sortir « Invalid Date »');
  assert.match(at(Date.now()), /^<t:\d+:F>$/, 'les timestamps Discord rendent l’heure locale de chacun');
  assert.equal(at('pas une date'), '—', 'une date pourrie ne doit pas sortir en NaN');
  assert.equal(at(new Date('2026-01-01T00:00:00Z')), '<t:1767225600:F>');
  assert.equal(bar(0), '░░░░░░░░░░░░ 0%', 'bar() prend une fraction 0..1');
  assert.equal(bar(1), '▓▓▓▓▓▓▓▓▓▓▓▓ 100%');
  assert.equal(bar(0.5).split('').filter((c) => c === '▓').length, 6);
  assert.equal(bar(-1), '░░░░░░░░░░░░ 0%', 'un pourcentage hors bornes ne casse pas la barre');
  assert.equal(bar(5).split('').filter((c) => c === '▓').length, 12);
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdefg', 5).length, 5);
  assert.equal(xpForLevel(0), 0);
  assert.equal(xpForLevel(1), 100);
  assert.ok(xpForLevel(10) > xpForLevel(9), 'la courbe doit etre strictement croissante');
  assert.equal(levelFromXp(0).level, 0, 'on commence au niveau 0, comme MEE6');
  assert.ok(levelFromXp(50_000).level > 10, 'la courbe doit monter');
  assert.equal(slug('🎉 Fête du Jeu !'), 'fete-du-jeu');
  assert.equal(slug('***'), 'sans-nom');
});

/* ------------------------------------------------------------------ base en memoire */
test('db en memoire : insert / bump / upsert / count / remove', async () => {
  const db = Db.memory();
  const row = await db.insert('members', { user_id: 'u1', guild_id: 'g', xp: 10 });
  assert.equal(row.xp, 10);
  await db.bump('members', { user_id: 'u1', guild_id: 'g' }, 'xp', 5);
  assert.equal((await db.one('members', { user_id: 'u1' }))!.xp, 15, 'bump additionne, il n’écrase pas');
  await db.upsert('members', ['user_id', 'guild_id'], { user_id: 'u1', guild_id: 'g', xp: 3 });
  assert.equal((await db.one('members', { user_id: 'u1' }))!.xp, 3, 'upsert écrase');
  await db.bump('members', { user_id: 'u2', guild_id: 'g' }, 'xp', 7);
  assert.equal(await db.count('members'), 2);
  await db.remove('members', { user_id: 'u2' });
  assert.equal(await db.count('members'), 1);
  assert.equal(await db.one('members', { user_id: 'u2' }), null, 'un trou = null, jamais undefined');
  assert.equal(db.isPersisted, false);
});

test('db : kv ( compteurs ) et flags ( on/off modules )', async () => {
  const db = Db.memory();
  assert.equal(await db.kv.get<number>('ticket:counter'), null);
  await db.kv.set('ticket:counter', 1);
  assert.equal(await db.kv.get<number>('ticket:counter'), 1);
  await db.kv.del('ticket:counter');
  assert.equal(await db.kv.get<number>('ticket:counter'), null);
  assert.equal(await db.flags.isOn('module:automod', true), true, 'un module est actif tant que rien n’est écrit');
  await db.flags.set('module:automod', false);
  assert.equal(await db.flags.isOn('module:automod', true), false);
  assert.equal((await db.flags.all()).length, 1);
});

test('db : requete sur table vide = tableau vide, pas d’exception', async () => {
  const db = Db.memory();
  assert.deepEqual(await db.all('cases', {}), []);
  assert.equal(await db.count('cases'), 0);
  await db.track('test', { a: 1 });
  assert.equal((await db.all('bot_events', {})).length, 1);
});

/* ------------------------------------------------------------------ structure */
test('structure : un serveur conforme ne declenche aucune erreur bloquante', () => {
  const r = resolveStructure(fakeGuild() as never);
  const erreurs = driftReport(r).filter((d) => d.level === 'error');
  assert.equal(erreurs.length, 0, erreurs.map((e) => e.what).join(' | '));
  assert.equal(r.missingChannels.length, 0);
  assert.equal(r.missingRoles.length, 0);
  assert.equal(Object.keys(r.channels).length, 30);
});

test('structure : renommage d’un salon = un seul module coupe, et c’est dit', () => {
  const r = resolveStructure(fakeGuild({ renameChannel: ['discussion', '💬│・Chat'] }) as never);
  assert.deepEqual(r.missingChannels, ['discussion']);
  assert.ok(driftReport(r).some((d) => d.level === 'error' && d.what.includes('💬│・Discussion')));
});

test('structure : fuite @everyone dans une categorie privee = bloquant', () => {
  const fuites = driftReport(resolveStructure(fakeGuild({ leakPrivate: true }) as never)).filter((d) => d.what.includes('FUITE'));
  assert.ok(fuites.length >= 1);
  assert.ok(fuites.every((d) => d.level === 'error'), 'une fuite n’est pas un simple avertissement');
});

test('structure : role Edge mal place et MentionEveryone absent sont vus', () => {
  assert.ok(driftReport(resolveStructure(fakeGuild({ edgeTooHigh: true }) as never)).some((d) => d.level === 'error' && d.what.includes('trop haut')));
  assert.ok(driftReport(resolveStructure(fakeGuild({ edgeNoMention: true }) as never)).some((d) => d.level === 'error' && d.what.includes('MentionEveryone')));
  assert.ok(driftReport(resolveStructure(fakeGuild({ extraChannel: '💬│・Old' }) as never)).some((d) => d.what.includes('hors manifeste')));
});

/* ------------------------------------------------------------------ modules */
test('modules : cles uniques, au moins un mecanique chacun', () => {
  const keys = new Set<string>();
  for (const m of MODULES) {
    assert.ok(!keys.has(m.key), `double clé de module : ${m.key}`);
    keys.add(m.key);
    assert.ok(m.label.trim().length > 0, `${m.key} : label requis`);
    assert.equal(m.key, m.key.toLowerCase(), `${m.key} : clé en minuscules`);
    const vivant = [m.commands, m.components, m.listeners, m.jobs, m.panels, m.sync].some(Boolean);
    assert.ok(vivant, `${m.key} ne branche rien (ni commande, ni bouton, ni event, ni job)`);
    if (m.commands) assert.ok(Array.isArray(m.commands({} as never) as unknown), `${m.key}.commands doit renvoyer un tableau`);
  }
  for (const attendu of ['welcome', 'rules', 'presentation', 'selfroles', 'tickets', 'moderation', 'audit', 'giveaway', 'polls', 'boosts', 'announcements', 'events', 'automod', 'antiraid', 'reports', 'partnership', 'recruitment', 'suggestions', 'invites', 'levels', 'voice', 'botadmin', 'help']) {
    assert.ok(keys.has(attendu), `module manquant : ${attendu}`);
  }
});

test('modules : chaque dependance declaree existe dans le manifeste', () => {
  for (const m of MODULES) {
    for (const k of m.needs?.channels ?? []) assert.ok(CHANNEL_DEFS.some((c) => c.key === k), `${m.key} dépend d’un salon inconnu : ${k}`);
    for (const k of m.needs?.roles ?? []) assert.ok(ROLE_DEFS.some((r) => r.key === k), `${m.key} dépend d’un rôle inconnu : ${k}`);
    for (const p of m.needs?.perms ?? []) assert.ok(BOT_PERMISSIONS.includes(p as never), `${m.key} demande une permission que le bot n’a pas : ${p}`);
  }
});

test('modules : un module coupe ne fait pas planter les autres (needs vides)', () => {
  const sansBesoin = MODULES.filter((m) => !m.needs || (!m.needs.channels?.length && !m.needs.roles?.length));
  assert.ok(sansBesoin.length >= 1, 'au moins un module tient sans salon dédié (aide, niveaux)');
  for (const m of sansBesoin) assert.ok(m.key === 'levels' || m.key === 'help' || m.key === 'botadmin', `${m.key} tourne sans dépendance : c’est voulu ?`);
});

test('copy : rien de vide, rien en anglais', () => {
  const seen: string[] = [];
  const walk = (o: unknown): void => {
    if (typeof o === 'string') { assert.ok(o.trim().length > 0, 'chaine vide'); seen.push(o); return; }
    if (o && typeof o === 'object') for (const v of Object.values(o as Record<string, unknown>)) walk(v);
  };
  for (const [k, v] of Object.entries(fr)) {
    if (typeof v === 'function') { const out = (v as unknown as (a: string) => string)(`«${k}»`); assert.equal(typeof out, 'string'); seen.push(out); } else seen.push(v as string);
  }
  assert.ok(seen.length >= 8, 'la copie française doit exister');
  const anglais = seen.filter((x) => /\b(you|your|please|error|not found|module is)\b/i.test(x));
  assert.deepEqual(anglais, [], `textes anglais restants : ${anglais.join(' | ')}`);
  for (const x of seen) assert.ok(!x.includes('undefined') && !x.includes('NaN'), `variable pas rempliee : ${x}`);
});

/* ------------------------------------------------------------------ deploiement */
test('sonde HTTP : /health repond meme avant la connexion, /ready dit la verite', async () => {
  assert.equal(env.port, 0, 'sans PORT (local), Edge n’ouvre aucun port et n’écrase rien');
  const h = startHealth({ port: 18099, status: () => statusOf(null, 'connexion à Discord…') });
  assert.ok(h, 'PORT fourni => la sonde s’ouvre');
  const health = await fetch('http://127.0.0.1:18099/health');
  const ready = await fetch('http://127.0.0.1:18099/ready');
  const page = await fetch('http://127.0.0.1:18099/');
  assert.equal(health.status, 200, 'la sonde de vivacite ne doit JAMAIS faire redemarrer Edge en boucle');
  assert.equal(ready.status, 503, 'pret = seulement quand Discord et la base sont la');
  const body = (await health.json()) as Record<string, unknown>;
  assert.equal(body.vivant, true);
  assert.equal(body.pret, false);
  assert.equal(body.raison, 'connexion à Discord…');
  assert.equal(body.base, 'absente', 'sans DATABASE_URL, la base est « absente », pas « ko »');
  assert.equal(typeof body.ramMb, 'number', 'la RAM est affichée : sur 512 Mo gratuits, un OOMkiller silencieux sinon');
  assert.equal(body.plateforme, 'local', 'Edge dit sur quelle plateforme il croit etre');
  assert.equal(body.autoping, null, 'sans URL publique, pas d autoping : le filet externe (GitHub Actions) prend le relais');
  assert.match((await page.text()).trim(), /Edge démarre/);
  assert.equal((await fetch('http://127.0.0.1:18099/admin')).status, 404, 'aucune route utile pour un curieux');
  await h!.close();
});

test('sonde : une base qui traine ne fait pas tomber /health', async () => {
  const h = startHealth({ port: 18098, status: () => new Promise((res) => setTimeout(() => res(statusOf(null, 'x')), 5_000)) });
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:18098/health');
  const b = (await r.json()) as Record<string, unknown>;
  assert.ok(Date.now() - t0 < 3_000, 'la sonde lache apres 1,5 s au lieu de pendre');
  assert.equal(r.status, 200);
  assert.equal(b.base, 'ko');
  await h!.close();
});

test('sonde : un port deja pris ne tue pas le bot', async () => {
  const concurrent = createServer((_q, res) => res.end('autre chose')).listen(18096);
  await new Promise((r) => concurrent.once('listening', r));
  const messages: string[] = [];
  const h = startHealth({ port: 18096, status: () => statusOf(null), log: (m) => messages.push(m) });
  assert.ok(h, 'startHealth ne l’exception pas, meme sur un port occupe');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(messages.some((m) => m.includes('sonde HTTP indisponible')), 'c’est dit une fois, puis Edge continue');
  concurrent.close();
  await h!.close();
});

test('keep-alive : ping immediat puis arret net (le minuteur ne survit pas a un stop)', async () => {
  let n = 0;
  const srv = createServer((_q, res) => { n += 1; res.writeHead(200); res.end('pong'); }).listen(18095);
  await new Promise((r) => srv.once('listening', r));
  const stop = startKeepalive('http://127.0.0.1:18095/', 60_000);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(n >= 1, 'le premier depart est immediat');
  stop();
  const apres = n;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(n, apres, 'stop() coupe vraiment le reveil : pas de timer zombie a la fermeture');
  srv.close();
});

/* ------------------------------------------------------------------ hebergement */
test('deploy : le port d écoute suit la plateforme, sans rien demander a personne', () => {
  assert.equal(resolvePort({ PORT: '10000' }), 10_000, 'Render/Railway/Northflank fournissent PORT');
  assert.equal(resolvePort({ RENDER: 'true' }), 10_000, 'Render sans PORT => son port de routage par defaut');
  assert.equal(resolvePort({ PORT: '8080', RENDER: 'true' }), 8_080, 'PORT explicite gagne, meme chez Render');
  assert.equal(resolvePort({ EDGE_HEALTH: true }), 8_080, 'EDGE_HEALTH=true ouvre 8080 en local');
  assert.equal(resolvePort({}), 0, 'local sans config => AUCUN port ouvert');
  assert.equal(resolvePort({ PORT: '0' }), 0, 'PORT=0 = explicitement ferme');
  assert.equal(resolvePort({ PORT: 'aberrant' }), 0, 'un PORT pourri hors plateforme = pas de sonde, jamais NaN');
  assert.equal(resolvePort({ PORT: 'aberrant', RENDER: 'true' }), 10_000, 'chez Render on retombe sur son port par defaut : la sonde ne doit jamais disparaitre');
});

test('deploy : autoping derive de RENDER_EXTERNAL_URL => zero reglage chez Render', () => {
  assert.equal(resolveKeepalive({ RENDER_EXTERNAL_URL: 'https://edge-bot.onrender.com' }), 'https://edge-bot.onrender.com/health');
  assert.equal(resolveKeepalive({ RENDER_EXTERNAL_URL: 'https://edge-bot.onrender.com/' }), 'https://edge-bot.onrender.com/health', 'la barre finale ne doit pas doubler');
  assert.equal(resolveKeepalive({ KEEPALIVE_URL: 'https://exemple.tld/ping', RENDER_EXTERNAL_URL: 'https://edge-bot.onrender.com' }), 'https://exemple.tld/ping', 'le réglage manuel prime');
  assert.equal(resolveKeepalive({ RENDER_EXTERNAL_URL: 'edge-bot.onrender.com' }), undefined, 'sans schéma http, on ne ping pas n’importe quoi');
  assert.equal(resolveKeepalive({}), undefined, 'hors Render et sans réglage => pas d autoping, le workflow GitHub prend le relais');
});

test('autoping : une URL https ne doit JAMAIS faire tomber Edge (la panne du deploy Render)', async () => {
  // Le 2026-10-10, un http.get sur l'URL publique (https) levait ERR_INVALID_PROTOCOL
  // au demarrage : le bot mourait avant meme de se connecter a Discord.
  const logs: string[] = [];
  let leve = false;
  try {
    const stop = startKeepalive('https://edge-bot.onrender.com/health', 60_000, (m) => logs.push(m));
    stop();
  } catch { leve = true; }
  assert.equal(leve, false, 'startKeepalive ne doit jamais lever, meme sur un reseau bouché');
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(logs.every((m) => m.includes('le bot tourne quand même')), `tonnage calme attendu : ${logs.join(' | ')}`);
});

test('autoping : une URL vide ou absurde est signalee, pas laissee trainer en rejet non gère', async () => {
  const logs: string[] = [];
  let leve = false;
  try { startKeepalive('pas-une-url', 60_000, (m) => logs.push(m))(); } catch { leve = true; }
  assert.equal(leve, false);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(logs.length >= 1, 'c est dit une fois, puis plus rien');
});

test('DATABASE_URL : on explique au lieu de laisser pg cracher « invalid connection »', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'a'.repeat(40) + '.' + 'b'.repeat(40);
  assert.match(dbUrlProblem(jwt) ?? '', /SERVICE_ROLE/i, 'une clé API collée dans DATABASE_URL = le cas le plus fréquent');
  assert.match(dbUrlProblem('https://xyz.supabase.co/rest/v1/') ?? '', /postgres:\/\//);
  assert.match(dbUrlProblem('postgres://postgres:@localhost:5432/postgres') ?? '', /local/i);
  assert.match(dbUrlProblem('postgres://postgres:mdp@db.x.supabase.co:5433/postgres') ?? '', /5433/);
  assert.match(dbUrlProblem('postgres://postgres:mdp@db.x.supabase.co/postgres') ?? '', /^$/, 'sans port = direct 5432 implicite, donc on ne grogne pas');
  assert.equal(dbUrlProblem('postgres://postgres:mdp@db.x.supabase.co:5432/postgres'), null, 'direct : nickel');
  assert.equal(dbUrlProblem('postgresql://postgres:[m@dp]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'), null, 'transaction pooler 6543 : nickel');
  assert.equal(dbUrlProblem(undefined), null, 'absent = pas une erreur, juste pas de stockage');
});

/* ------------------------------------------------------------------ mode API Supabase */

type VueRequete = { method: string; path: string; query: string; body: any; prefer?: string; apikey?: string; auth?: string };
type Reponse = { status?: number; json?: unknown; texte?: string; headers?: Record<string, string> };

/** Un faux PostgREST : on verifie les requetes EMISES, pas une imitation de la base. */
function fauxSupabase(repondre: (q: { method: string; path: string; searchParams: URLSearchParams; body: any }) => Reponse | undefined) {
  const vus: VueRequete[] = [];
  const srv = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = buf ? JSON.parse(buf) : undefined;
      vus.push({ method: req.method ?? '?', path: u.pathname, query: u.search, body, prefer: req.headers.prefer as string | undefined, apikey: req.headers.apikey as string | undefined, auth: req.headers.authorization as string | undefined });
      let entete: Record<string, unknown> = { 'content-type': 'application/json' };
      const r = repondre({ method: req.method ?? '?', path: u.pathname, searchParams: u.searchParams, body }) ?? { json: [] };
      Object.assign(entete, r.headers ?? {});
      res.writeHead(r.status ?? 200, entete as never);
      res.end(r.texte ?? JSON.stringify(r.json ?? []));
    });
  });
  return new Promise<{ port: number; vus: VueRequete[]; fermer: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ port, vus, fermer: () => new Promise((r2) => void srv.close(() => r2(undefined))) });
    });
  });
}

const btoa = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

test('SUPABASE_URL : on accepte ce que le tableau de bord donne a copier, et rien d’autre', () => {
  const cle = 'x'.repeat(40);
  assert.deepEqual(resolveSupabase({ SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: cle }),
    { url: 'https://abcdefghijklmnopqrst.supabase.co', key: cle, schema: 'public' });
  assert.equal(resolveSupabase({ SUPABASE_URL: 'abcdefghijklmnopqrst.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: cle })?.url, 'https://abcdefghijklmnopqrst.supabase.co', 'sans protocole ni slash final');
  assert.equal(resolveSupabase({ SUPABASE_URL: 'abcdefghijklmnopqrst', SUPABASE_SERVICE_ROLE_KEY: cle })?.url, 'https://abcdefghijklmnopqrst.supabase.co', 'référence nue du dashboard');
  assert.equal(resolveSupabase({ SUPABASE_URL: 'https://abc.supabase.co/rest/v1', SUPABASE_SERVICE_ROLE_KEY: cle })?.url, 'https://abc.supabase.co', '/rest/v1 colle par-dessus');
  assert.equal(resolveSupabase({ SUPABASE_URL: 'http://cleartext.example.com', SUPABASE_SERVICE_ROLE_KEY: cle }), null, 'jamais de cle en clair hors localhost');
  assert.equal(resolveSupabase({ SUPABASE_URL: 'http://127.0.0.1:54324', SUPABASE_SERVICE_ROLE_KEY: cle })?.url, 'http://127.0.0.1:54324', 'Supabase auto-hébergé en local : OK');
  assert.equal(resolveSupabase({ SUPABASE_URL: 'https://abc.supabase.co' }), null, 'URL sans cle = on ne devine rien');
  assert.equal(resolveSupabase({ SUPABASE_URL: 'rien du tout', SUPABASE_SERVICE_ROLE_KEY: cle }), null);
  assert.equal(resolveSupabase({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_KEY: cle })?.key, cle, 'alias SUPABASE_KEY accepté');
});

test('la clé fournie est-elle la bonne ? jwtRole lit le JWT sans appeler Supabase', () => {
  assert.equal(jwtRole(`${btoa({ alg: 'HS256' })}.${btoa({ role: 'service_role' })}.sig`), 'service_role');
  assert.equal(jwtRole(`${btoa({})}.${btoa({ role: 'anon' })}.sig`), 'anon');
  assert.equal(jwtRole('pas-un-jwt'), null, 'on n’invente pas un role');
  assert.equal(jwtRole(undefined), null);
  assert.match(supabaseProblem({ SUPABASE_URL: 'https://abc.supabase.co' }) ?? '', /SERVICE_ROLE/, 'un URL sans cle = message explicite');
  assert.match(supabaseProblem({ SUPABASE_KEY: `${btoa({})}.${btoa({ role: 'anon' })}.s`, SUPABASE_URL: 'https://abc.supabase.co' }) ?? '', /service_role/, 'la cle anon doit etre refusee AVANT le premier ecrit');
  assert.equal(supabaseProblem({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: `${btoa({})}.${btoa({ role: 'service_role' })}.s` }), null);
  assert.equal(supabaseProblem({}), null, 'rien configure = rien a reprocher');
});

test('mode API : chaque operation de la facade devient la requete PostgREST attendue', async () => {
  const s = await fauxSupabase(({ method, path }) => {
    if (path === '/rest/v1/tickets' && method === 'POST') return { json: [{ id: 't-1', statut: 'open' }] };
    if (path === '/rest/v1/tickets' && method === 'PATCH') return { json: [{ id: 't-1', statut: 'closed' }] };
    if (path === '/rest/v1/tickets' && method === 'DELETE') return { json: [{ id: '1' }, { id: '2' }] };
    if (path === '/rest/v1/tickets' && method === 'GET') return { json: [{ id: 't-1' }], headers: { 'content-range': '0-0/42' } };
    if (path === '/rest/v1/rpc/edge_prune_events') return { json: [{ edge_prune_events: 7 }] };
    return { json: [] };
  });
  try {
    const db = Db.rest({ url: `http://127.0.0.1:${s.port}`, key: 'cle-de-test', timeoutMs: 5000 });
    assert.equal(db.mode, 'rest');
    assert.equal(db.libelle, 'API Supabase');

    const ins = await db.insert('tickets', { id: 't-1', statut: 'open', ouvert_le: new Date('2026-10-10T12:00:00Z'), payload: { n: 1 } });
    assert.equal(ins.id, 't-1');
    const v0 = s.vus[0]!;
    assert.equal(v0.method, 'POST');
    assert.equal(v0.apikey, 'cle-de-test', 'la cle part en en-tete apikey…');
    assert.equal(v0.auth, 'Bearer cle-de-test', '…et en Bearer, comme l’attend PostgREST');
    assert.match(v0.prefer ?? '', /return=representation/, 'sinon on ne recupere pas la ligne inseree');
    assert.equal(v0.body.ouvert_le, '2026-10-10T12:00:00.000Z', 'une Date devient un timestamp');
    assert.deepEqual(v0.body.payload, { n: 1 }, 'un objet part en jsonb, pas en chaine');

    await db.all('tickets', { where: { statut: 'open', id: ['12 34', '67'], refus_le: null }, orderBy: 'created_at', desc: true, limit: 3 });
    const q = new URLSearchParams(s.vus[1]!.query);
    assert.equal(q.get('select'), '*');
    assert.equal(q.get('statut'), 'eq.open');
    assert.equal(q.get('id'), 'in.("12 34","67")', 'IN avec valeur contenant une virgule, citee');
    assert.equal(q.get('refus_le'), 'is.null');
    assert.equal(q.get('order'), 'created_at.desc');
    assert.equal(q.get('limit'), '3');

    assert.equal(await db.count('tickets', { statut: 'open' }), 42, 'count lit l’en-tete Content-Range, pas les lignes');
    assert.match(s.vus[2]!.prefer ?? '', /count=exact/);
    assert.match(new URLSearchParams(s.vus[2]!.query).get('limit') ?? '', /^0$/, 'limite a zero : on ne transporte rien');

    const upd = await db.update('tickets', { id: 't-1' }, { statut: 'closed' });
    assert.equal(upd?.statut, 'closed');
    assert.equal(s.vus[3]!.method, 'PATCH');

    assert.equal(await db.remove('tickets', { id: 't-1' }), 2, 'le nombre de lignes rendues = le nombre supprime');
    assert.equal(s.vus[4]!.method, 'DELETE');

    assert.equal(await db.rpc1('edge_prune_events', { p_older_than: '2026-01-01T00:00:00Z' }), 7, 'une fonction SQL scalaire revient depouillee');
    assert.equal(s.vus[5]!.path, '/rest/v1/rpc/edge_prune_events');
    assert.deepEqual(s.vus[5]!.body, { p_older_than: '2026-01-01T00:00:00Z' });

    assert.equal(await db.ping(), true, 'ping = une selection minuscule, pas SELECT 1');
    assert.deepEqual(s.vus[6]!.path, '/rest/v1/kv_store');

    // une liste vide ne peut matcher : on n'appelle meme pas le serveur
    const avant = s.vus.length;
    assert.deepEqual(await db.all('tickets', { where: { statut: [] } }), []);
    assert.equal(await db.remove('tickets', { statut: [] }), 0);
    assert.equal(s.vus.length, avant, 'aucune requete inutile');
  } finally { await s.fermer(); }
});

test('mode API : upsert reste lire-puis-ecrire, et les erreurs deviennent des phrases', async () => {
  const s = await fauxSupabase(({ path }) => {
    if (path === '/rest/v1/kv_store') return { json: [{ key: 'panneaux', value: { a: 1 } }] };
    return { json: [] };
  });
  try {
    const db = Db.rest({ url: `http://127.0.0.1:${s.port}`, key: 'k', timeoutMs: 5000 });
    await db.kv.set('panneaux', { a: 2 });
    assert.deepEqual(s.vus.map((v) => v.method), ['GET', 'PATCH'], 'la ligne existe deja : on ne duplique pas');
    await assert.rejects(db.raw('SELECT 1'), /diteur SQL/, 'le SQL brut doit etre refuse en termes clairs');
  } finally { await s.fermer(); }

  const mechant = await fauxSupabase(({ path }) => (path === '/rest/v1/tickets' ? { status: 404, json: { code: 'PGRST202', message: 'could not find the relation public.tickets' } } : { json: [] }));
  try {
    const db = Db.rest({ url: `http://127.0.0.1:${mechant.port}`, key: 'k', timeoutMs: 5000 });
    await assert.rejects(db.all('tickets', {}), /schema\.sql/, 'table absente = on renvoie vers le fichier a coller');
    assert.equal(await db.ping(), true, 'la table tickets manque mais l’API repond : /health ne doit pas crier a la panne de base');
  } finally { await mechant.fermer(); }

  const coupee = await fauxSupabase(() => ({ status: 401, json: { message: 'JWSError' } }));
  try {
    const db = Db.rest({ url: `http://127.0.0.1:${coupee.port}`, key: 'k', timeoutMs: 5000 });
    await assert.rejects(db.all('tickets', {}), /service_role/, 'une cle refusee doit dire laquelle il faut');
  } finally { await coupee.fermer(); }
});

test('mode API : un Supabase injoignable ne tue pas Edge (le bot continue de tourner)', async () => {
  const db = Db.rest({ url: 'http://127.0.0.1:1', key: 'k', timeoutMs: 1500 });
  assert.equal(await db.ping(), false, 'ping = false, pas une exception');
  await assert.rejects(db.all('tickets', {}), /Supabase injoignable|reseau/i);
});

test('supabase/schema.sql est bien la copie a jour de migrations/*.sql (+ les 3 fonctions)', () => {
  const mig = readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort();
  const gen = readFileSync('supabase/schema.sql', 'utf8');
  assert.ok(mig.length >= 1, 'migrations absentes');
  for (const f of mig) {
    assert.ok(gen.includes(`-- ---- ${f} ----`), `${f} n'est pas reporte dans le fichier a coller`);
    const sql = readFileSync(`migrations/${f}`, 'utf8').trim();
    for (const ligne of sql.split('\n').filter((l: string) => l.trim().startsWith('CREATE TABLE') || l.trim().startsWith('CREATE INDEX'))) {
      assert.ok(gen.includes(ligne.trim()), `ligne absente du fichier a coller : ${ligne.trim().slice(0, 60)}`);
    }
  }
  for (const fn of ['edge_schema_check', 'edge_prune_events', 'edge_counts']) {
    assert.ok(gen.includes(`FUNCTION ${fn}(`), `fonction API ${fn} manquante`);
  }
  const sql = gen.split('\n').filter((l: string) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/DROP TABLE|DROP COLUMN|TRUNCATE|\bDELETE FROM [a-z_]+;/.test(sql.replace(/DELETE FROM bot_events\n  GET|DELETE FROM bot_events WHERE created_at < p_older_than;/, '')), 'le fichier a coller ne doit rien detruire (le menage passe par edge_prune_events)');
  assert.ok(gen.includes("NOTIFY pgrst, 'reload schema'"), 'sinon PostgREST ne voit pas les tables neuves');
});

test('le logger survit a une methode arrachee a son objet (le boot-loop de Render)', () => {
  // `cond ? log.warn : log.info`, `rows.forEach(log.warn)`, `[log.error]…` : des que la methode
  // quitte l'objet, this vaut undefined. Les methodes sont donc des fleches fixees.
  const log = new Logger('test');
  const { info, warn, error, ok, debug, line, child } = log;
  const arrachees = [info, warn, error, ok, debug] as const;
  assert.equal(arrachees.length, 5);
  for (const f of arrachees) f('appel sans this — ne doit pas lever');
  line?.('ops', 'ligne de salon sans this');
  const fils = child?.('enfant');
  assert.ok(fils instanceof Logger, 'child() doit rester utilisable detaché');
  // et la vraie forme qui plantait : selection de methode dans une ternaire
  const choix = (n: string) => (n === 'a' ? log.error : n === 'b' ? log.warn : log.info);
  for (const n of ['a', 'b', 'c']) choix(n)('dérive');
});

test('le manifeste ne donne pas deux fois la même couleur de rôle ( ma propre police le reprochait)', () => {
  // `npm run dry` affichait « [police] couleurs de rôles dupliquées » A PROPOS DU MANIFESTE
  // lui-meme : manager et mod partageaient #E67E22. Un audit qui engueule son propre plan,
  // ca use la confiance dans les 23 autres lignes du rapport.
  const vus = new Map<string, string>();
  for (const r of ROLE_DEFS) {
    if (!r.color) continue;
    const avant = vus.get(r.color.toLowerCase());
    assert.equal(avant, undefined, `${avant} et ${r.name} ont tous les deux ${r.color}`);
    vus.set(r.color.toLowerCase(), r.name);
  }
  assert.ok(vus.size >= ROLE_DEFS.length - 2, 'trop peu de couleurs distinctes pour être un hasard');
});

/* ------------------------------------------------------------------ schema SQL vs code */
test('schéma : le code ne touche aucune table ni colonne que les migrations ne déclarent pas', () => {
  const r = auditerSchema('.');
  assert.ok(r.tablesVue >= 24, `le parseur ne voit que ${r.tablesVue} tables`);
  assert.ok(r.fichiersVus > 40, `peu de fichiers scannés (${r.fichiersVus}) : l audit serait vide`);
  assert.ok(r.colonnesVerifiees > 150, `audit trop timide : ${r.colonnesVerifiees} colonnes verifiées`);
  console.log(`      ${r.tablesVue} tables · ${r.fichiersVus} fichiers scannés · ${r.colonnesVerifiees} colonnes vérifiées`);
  assert.deepEqual(r.problemes, [], `\n${r.problemes.join('\n')}`);
});

test('schéma : index, clés étrangères et compteurs de l API sont cohérents', () => {
  const { tables, sql } = schemaDesMigrations();
  const brut = sql.replace(/--[^\n]*/g, '');
  for (const m of brut.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_0-9]+) ON (?:public\.)?([a-z_]+)(?: ONLY)?\s*\(([^)]*)\)/g)) {
    const cols = tables.get(m[2]!) ?? [];
    for (const c of m[3]!.match(/[a-z_]+/g) ?? []) {
      if (['lower', 'now', 'coalesce', 'asc', 'desc', 'nulls', 'first', 'last'].includes(c)) continue;
      assert.ok(cols.includes(c), `index ${m[1]} : ${m[2]}.${c} n existe pas`);
    }
  }
  assert.ok(tables.has('announcements'), 'la table announcements doit exister : le module l écrit');
  assert.ok((tables.get('tickets') ?? []).includes('opener_id'), 'tickets.opener_id : la colonne qui a fait echouer le collage dans Supabase');
  for (const c of ['closed_by', 'pinged_after']) assert.ok((tables.get('tickets') ?? []).includes(c), `tickets.${c} écrit par le module tickets`);
  for (const c of ['verified_by', 'verified_at']) assert.ok((tables.get('presentations') ?? []).includes(c), `presentations.${c} écrit par le module presentation`);
  assert.ok((tables.get('applications') ?? []).includes('decided_at'), 'applications.decided_at écrit par recruitment');
  assert.ok((tables.get('reports') ?? []).includes('reviewed_by'), 'reports.reviewed_by écrit par reports');
});

/* ------------------------------------------------------------------ reglages (/edge config) */
import { construireRegistre, formater, invariantsRegistre, normaliser, REGLAGES_GENERAL, store, valider, Config, type SettingDef } from '../src/core/settings.js';

const def = (o: Partial<SettingDef>): SettingDef => ({ cle: 'x', module: 'test', type: 'chaine', label: 'Un réglage', defaut: '', ...o } as SettingDef);

test('réglages : chaque type accepte le bon format et refuse le reste, en français', () => {
  assert.deepEqual(valider(def({ type: 'chaine', maxLen: 10 }), '  bonjour  '), { ok: true, valeur: 'bonjour' });
  assert.equal(valider(def({ type: 'chaine', maxLen: 4 }), 'beaucoup trop long').ok, false);
  assert.equal(valider(def({ type: 'chaine' }), 'deux\nlignes').ok, false, 'un texte à la ligne doit passer par le type « texte »');
  assert.equal(valider(def({ type: 'texte' }), 'une\nligne\naussi').ok, true, '« texte » accepte les sauts de ligne');
  assert.deepEqual(valider(def({ type: 'nombre', min: 1, max: 10 }), '7'), { ok: true, valeur: 7 });
  assert.deepEqual(valider(def({ type: 'nombre' }), '2,5'), { ok: true, valeur: 2.5 }, 'la virgule française est admise');
  const refuse = valider(def({ type: 'nombre', min: 1 }), '0');
  assert.ok(!refuse.ok, 'hors bornes : refusé');
  const horsSujet = valider(def({ type: 'nombre' }), 'bientôt');
  assert.ok(!horsSujet.ok && horsSujet.raison === 'nombre attendu, reçu « bientôt »', 'la raison est écrite pour un humain');
  assert.deepEqual(valider(def({ type: 'couleur' }), 'vert'), { ok: true, valeur: '#2ECC71' }, 'les noms de couleur marchent');
  assert.deepEqual(valider(def({ type: 'couleur' }), '#1abc9c'), { ok: true, valeur: '#1ABC9C' });
  assert.equal(valider(def({ type: 'couleur' }), 'arc-en-ciel').ok, false);
  for (const [entree, valeur] of [['oui', true], ['non', false], ['vrai', true], ['0', false], ['on', true], ['couper', false]] as [string, boolean][]) {
    assert.deepEqual(valider(def({ type: 'booleen' }), entree), { ok: true, valeur }, `« ${entree} » doit se lire ${valeur}`);
  }
  assert.equal(valider(def({ type: 'booleen' }), 'peut-etre').ok, false);
  assert.deepEqual(valider(def({ type: 'salon' }), '<#1558076024778919946>'), { ok: true, valeur: '1558076024778919946' });
  assert.deepEqual(valider(def({ type: 'role' }), '1558076024778919946'), { ok: true, valeur: '1558076024778919946' });
  assert.equal(valider(def({ type: 'salon' }), '#-discussion').ok, false, 'un nom de salon n est pas un identifiant');
  assert.deepEqual(valider(def({ type: 'duree' }), '1h30'), { ok: true, valeur: 5_400_000 });
  assert.deepEqual(valider(def({ type: 'liste' }), 'a, b ; c'), { ok: true, valeur: ['a', 'b', 'c'] });
  assert.equal(valider(def({ type: 'liste', max: 1 }), 'a, b').ok, false);
  const choix = def({ type: 'choix', choix: [{ nom: 'Discret', valeur: 'discret' }, { nom: 'Bruyant', valeur: 'bruyant' }] as { nom: string; valeur: string }[] });
  assert.deepEqual(valider(choix, 'bruyant'), { ok: true, valeur: 'bruyant' });
  assert.match((valider(choix, 'n importe quoi') as { raison: string }).raison, /Discret \/ Bruyant/);
  assert.equal(formater(def({ type: 'booleen' }), true), '✅ oui');
  assert.equal(formater(def({ type: 'duree' }), 90_000), '90 s');
  assert.equal(normaliser(def({ type: 'nombre', min: 1, max: 10 }), 99), 10, 'une valeur sortie de la base est bornée, pas rejetée');
});

test('réglages : le registre est cohérent, et chaque réglage exposé est vraiment lu par son module', () => {
  const registre = construireRegistre(MODULES);
  registre.set('general', new Map(REGLAGES_GENERAL.map((d) => [d.cle, d])));
  const fichiers = readdirSync('src/modules').filter((f) => f.endsWith('.ts'));
  const source = (module: string): string => {
    if (module === 'general') return ['src/core/client.ts', 'src/core/send.ts', 'src/core/config-ui.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    const direct = fichiers.find((f) => f.replace(/\.ts$/, '') === module);
    const trouve = direct ?? fichiers.find((f) => readFileSync(`src/modules/${f}`, 'utf8').includes(`key: '${module}'`));
    assert.ok(trouve, `aucun fichier de module pour « ${module} » : le test ne peut pas prouver que le réglage est lu`);
    return readFileSync(`src/modules/${trouve}`, 'utf8');
  };
  const pb = invariantsRegistre(registre, source);
  assert.deepEqual(pb, [], `\n${pb.join('\n')}`);
  const nb = [...registre.values()].reduce((a, m) => a + m.size, 0);
  assert.ok(nb >= 16, `seulement ${nb} réglages exposés : la personnalisation promise n est pas là`);
  assert.ok(registre.get('general')!.has('salon_moderation'), 'les journaux doivent être déplaçables sans code');
  assert.ok(registre.get('welcome')!.has('message'), 'le texte de bienvenue doit être dans /edge config, pas seulement dans /bienvenue texte');
});

test('réglages : un défaut déclaré == le fallback réellement lu au pied du mur (sinon « oublier » armerait ce qui ne l’était pas)', () => {
  const registre = construireRegistre(MODULES);
  registre.set('general', new Map(REGLAGES_GENERAL.map((d) => [d.cle, d])));
  const source = ['src/core/client.ts', 'src/core/send.ts', ...readdirSync('src/modules').filter((f) => f.endsWith('.ts')).map((f) => `src/modules/${f}`)]
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const drapeaux = new Map<string, boolean>();
  for (const m of source.matchAll(/flags\.isOn\(\s*'([^']+)',\s*(true|false)\s*\)/g)) drapeaux.set(m[1]!, m[2] === 'true');
  for (const defs of registre.values()) {
    for (const def of defs.values()) {
      if (def.base !== 'flags') continue;
      const cle = (def.cleBase ?? def.cle).replace(/\{module\}/g, def.module);
      // Soit le module lit le flag lui-meme avec son propre fallback (log:* est lu par la couche
      // de reglages, donc le defaut declare EST la source de verite), soit il n'y a rien a croiser.
      if (!drapeaux.has(cle)) continue;
      assert.equal(def.defaut, drapeaux.get(cle), `${def.module}.${def.cle} : le défaut affiché par /edge config (${def.defaut}) difère du comportement réel (${drapeaux.get(cle)}) — « oublier » changerait donc le comportement du module`);
    }
  }
  assert.ok(drapeaux.size >= 7, `seulement ${drapeaux.size} flags littéraux trouvés : le test ne regarde plus rien`);
  // L'autre sens, celui qui compte pour « je veux tout modifier » : un flag qui change un
  // comportement ne doit jamais rester un reglage clandestin, invisible dans /edge config.
  // (log:* et module:* sont des cles composees : les premieres vivent dans general, les
  // secondes dans /edge module couper — verifiees par les deux tests precedents.)
  const declares = new Set<string>();
  for (const defs of registre.values()) for (const def of defs.values()) declares.add((def.cleBase ?? def.cle).replace(/\{module\}/g, def.module));
  for (const cle of drapeaux.keys()) {
    assert.ok(declares.has(cle), `le flag « ${cle} » change un comportement mais n'est déclaré dans aucun module : ajoute-le a ses reglages (base: flags)`);
  }
});

test('réglages : une base sans la table module_settings ne casse rien — défauts + une seule alerte', async () => {
  const db = Db.memory();
  const registre = construireRegistre([{ key: 'test', label: 'Test', reglages: [def({ cle: 'max', type: 'nombre', label: 'Max', defaut: 3 })] }]);
  (db as unknown as { one: (t: string, w?: unknown) => Promise<never> }).one = async () => {
    throw new Error('could not find the relation module_settings (42P01)');
  };
  let alertes = 0;
  const cfg = new Config(db, registre, () => void 0, () => { alertes++; });
  assert.equal(await cfg.pour('test').num('max'), 3, 'le module doit lire son défaut, pas une exception');
  assert.equal(await cfg.pour('test').num('max'), 3);
  assert.deepEqual(Object.keys(await cfg.exporter('test')), [], 'exporter sur une base muette renvoie vide, pas une erreur');
  assert.equal(alertes, 1, `une seule alerte, pas une par message lu : ${alertes}`);
});

test('réglages : régler / lire / oublier / exporter, sur la vraie couche de stockage', async () => {
  const db = Db.memory();
  const defs: SettingDef[] = [
    def({ cle: 'message', module: 'test', type: 'texte', label: 'Texte', defaut: 'par défaut', base: 'kv', cleBase: 'test:texte' }),
    def({ cle: 'actif', module: 'test', type: 'booleen', label: 'Actif', defaut: true, base: 'flags', cleBase: 'test.actif' }),
    def({ cle: 'max', module: 'test', type: 'nombre', label: 'Maximum', defaut: 3, min: 1, max: 5 }),
    def({ cle: 'secret', module: 'test', type: 'chaine', label: 'Avancé', defaut: 'x', avance: true }),
  ];
  const registre = construireRegistre([{ key: 'test', label: 'Test', reglages: defs }]);
  const cfg = new Config(db, registre);
  const vue = cfg.pour('test');

  assert.equal(await vue.texte('message'), 'par défaut', 'non réglé = le défaut déclaré');
  assert.equal(await vue.num('max'), 3);
  assert.equal(await vue.bool('actif'), true);

  assert.ok((await cfg.regler('test', 'max', '9')).ok === false, 'hors bornes : refusé');
  const r = await cfg.regler('test', 'max', '4');
  assert.ok(r.ok && r.valeur === 4);
  assert.equal(await vue.num('max'), 4, 'la valeur réglée est lue immédiatement');
  const ligne = await db.one('module_settings', { module_key: 'test', cle: 'max' });
  assert.equal(Number(ligne?.valeur), 4, `la valeur doit vivre en base, pas seulement en cache : ${JSON.stringify(ligne)}`);

  // les reglages historiques touchent l emplacement existant, pas une copie
  await cfg.regler('test', 'actif', 'faux');
  assert.equal(await db.flags.isOn('test.actif', true), false, 'un réglage « flags » doit écrire dans flags');
  await cfg.regler('test', 'message', 'salut {membre}');
  assert.equal(await db.kv.get<string>('test:texte'), 'salut {membre}', 'un réglage « kv » doit écrire dans kv_store');

  // le cache de 20 s est reel : une ecriture par-derriere ne se voit qu apres invalidation
  assert.equal(await vue.texte('message'), 'salut {membre}', 'premiere lecture = le cache se remplit');
  await db.kv.set('test:texte', 'écrit à la main');
  assert.equal(await vue.texte('message'), 'salut {membre}', 'le cache doit protéger la base des lectures répétées');
  cfg.invalider('test');
  assert.equal(await vue.texte('message'), 'écrit à la main');

  const exporte = await cfg.exporter('test');
  assert.deepEqual(Object.keys(exporte).sort(), ['actif', 'max', 'message'], 'exporter ne sort que ce qui a été réglé');
  const importE = await cfg.importer('test', { max: '2', inconnu: 1, actif: true });
  assert.deepEqual(importE.poses, ['max', 'actif']);
  assert.equal(importE.refuses[0]?.[0], 'inconnu');
  assert.equal(await vue.num('max'), 2);

  await cfg.oublier('test', 'max');
  assert.equal(await vue.num('max'), 3, 'oublier = revenir au défaut');
  await cfg.reinitialiser('test');
  assert.equal(await db.flags.isOn('test.actif', true), true, 'réinitialiser remet le défaut, y compris sur un flag');
  assert.equal(await vue.texte('message'), 'par défaut');
  assert.deepEqual(await store.lire(db, defs[2]!), null, 'la ligne module_settings est bien parties');

  const tout = await cfg.tout('test');
  assert.ok(Object.values(tout).every((e) => e.parDefaut), 'tout est revenu au défaut');
  assert.ok(tout['secret']!.def.avance, 'un réglage avancé reste accessible, il est juste masqué par défaut');
});

/* ------------------------------------------------------------------ garde-fils d'envoi (le bug /help) */
import { briderReponses, decouper, separer } from '../src/core/safe-reply.js';
import { DOCS, helpModule, lignesApercu, pagesApercu } from '../src/modules/help.js';

test('decouper : casse sur les lignes, jamais au milieu d’un mot, ne perd rien', () => {
  const lignes = Array.from({ length: 60 }, (_, k) => `ligne ${k} — un peu de texte pour pousser la taille`);
  const texte = lignes.join('\n');
  const pages = decouper(texte, 500);
  assert.ok(pages.length >= 5, `attendu plusieurs pages, recu ${pages.length}`);
  assert.ok(pages.every((t) => t.length <= 500), `une page depasse : ${Math.max(...pages.map((t) => t.length))}`);
  assert.equal(pages.join('\n'), texte, 'aucun caractère ne doit disparaître');
  assert.ok(pages.every((t) => !t.startsWith('\n')), 'une page ne commence pas par un saut de ligne');
  const brut = 'a'.repeat(4200);
  const dures = decouper(brut, 1000);
  assert.equal(dures.join(''), brut, 'une ligne kilométrique est tranchée, pas perdue');
  assert.equal(decouper('court', 1000)[0], 'court', 'ce qui passe n’est pas touché');
});

test('le filet de réponse : un content trop long part en messages de suite, au lieu de faire échouer la commande', async () => {
  const gros = Array.from({ length: 40 }, (_, k) => `- ${k} · ${'x'.repeat(60)}`).join('\n');
  assert.ok(gros.length > 2000, 'le jeu de test doit dépasser la limite Discord');
  const separe = separer({ content: gros, embeds: [], components: [] });
  assert.ok((separe.premier as { content: string }).content.length <= 1990, 'la première réponse passe la limite');
  assert.ok(separe.suivants.length >= 1, 'la suite existe');
  assert.deepEqual(separer('court').suivants, [], 'un payload conforme traverse sans copie');
  assert.deepEqual(separer({ embeds: [] }), { premier: { embeds: [] }, suivants: [] }, 'sans content, on ne touche à rien');

  const recus: string[] = [];
  const faux = {
    editReply: async (x: unknown) => { recus.push(`edit:${(x as { content: string }).content.length}`); return { id: 'm1' }; },
    followUp: async (x: unknown) => { recus.push(`suite:${typeof x === 'string' ? x.length : (x as { content: string }).content.length}`); return { id: 'm2' }; },
  };
  briderReponses(faux);
  await (faux as unknown as { editReply: (p: unknown) => Promise<unknown> }).editReply({ content: gros });
  assert.match(recus[0]!, /^edit:\d+$/, 'editReply a bien été bridé');
  assert.ok(recus.length > 1, `la suite devait partir en followUp : ${recus.join(', ')}`);
  assert.ok(recus.slice(1).every((r) => r.startsWith('suite:')), 'les suites sont bien des followUps');
});

test('/aide : les 23 fiches existent, et l’aperçu tient dans les embeds (le bug « Invalid Form Body »)', async () => {
  for (const m of MODULES) {
    const d = DOCS[m.key];
    assert.ok(d, `aucune fiche pour le module « ${m.key} » : /aide mentirait sur lui`);
    assert.ok(d.quoi.length > 40 && d.ou.length > 2 && d.cmd.length > 2, `${m.key} : fiche incomplète`);
  }
  for (const cle of Object.keys(DOCS)) assert.ok(MODULES.some((m) => m.key === cle), `DOCS garde une fiche orpheline : « ${cle} »`);
  const ctx = { disabled: new Map(), cfg: { defs: () => [] }, guild: { name: 'EdgeMode' } } as never;
  const lignes = lignesApercu(ctx);
  assert.equal(lignes.length, MODULES.length, 'un module oublié de l’aperçu = un module introuvable pour les membres');
  const texte = lignes.join('\n');
  assert.ok(texte.length > 2000, `cet échantillon devrait être au-dessus de la limite de contenu (${texte.length}) : le test ne prouverait rien`);
  const pages = pagesApercu(ctx);
  assert.ok(pages.length >= 1);
  for (const p of pages) assert.ok(p.length <= 3800, `une page de ${p.length} caractères ferait rejeter l’embed (limite 4096)`);
  assert.equal(pages.join('\n').replace(/\n+/g, '\n').includes('EdgeMode'), true, 'le nom du serveur doit être dans l’aperçu');
  const unSeulContenu = texte; // la version « content » de l'ancien /aide : c'est exactement ce qui faisait échouer la commande
  assert.ok(unSeulContenu.length > 2000, 'si l’aperçu rentrait dans un content, le garde-fou n’aurait plus d’utilité — mets à jour ce test avec conscience');
  assert.ok(typeof helpModule.components === 'function', '/aide doit rester maniable au clic (menu des modules)');
});

test('les menus d’Edge assainissent leurs `value` (le « Invalid Form Body » le plus vicieux)', () => {
  // Un select dont une value contient « : », une majuscule ou un accent : Discord rejette le
  // message entier. L'assainisseur est le seul endroit qui decide, et les constructeurs de menus
  // sont obliges de passer par lui.
  assert.equal(valeurOption('welcome.message'), 'welcome.message');
  assert.equal(valeurOption('antiraid:auto'), 'antiraid-auto', 'un deux-points devient un tiret : la value reste legale');
  assert.equal(valeurOption('Général'), 'general', 'les accents sautent (les cles du manifeste sont ASCII, donc le retour se fait a l’identique)');
  assert.equal(valeurOption('  '), 'valeur', 'jamais de value vide : Discord la refuserait');
  assert.equal(valeurOption('a'.repeat(300)).length, 100);
  assert.deepEqual(decouperOption('tickets.message_panneau'), ['tickets', 'message_panneau']);
  assert.deepEqual(decouperOption('general.salon_moderation'), ['general', 'salon_moderation']);
  for (const f of ['src/core/config-ui.ts', 'src/modules/help.ts']) {
    const src = readFileSync(f, 'utf8');
    const menus = src.match(/addOptions\(/g) ?? [];
    const assainis = src.match(/value: valeurOption\(/g) ?? [];
    assert.ok(menus.length > 0, `${f} : plus aucun menu construit ? ce test ne surveille rien`);
    assert.equal(assainis.length, menus.length, `${f} : ${menus.length} menu(s) construit(s), ${assainis.length} value(s) lavée(s) — une value non assainie peut faire rejeter tout le message`);
  }
  // et les cles qu'on encode dans une value doivent deja etre legales, sinon le retour ne marche plus
  for (const m of MODULES) {
    assert.equal(valeurOption(m.key), m.key, `la cle de module « ${m.key} » change en passant par le menu : /aide ne retrouverait plus le module`);
    for (const def of construireRegistre([m]).get(m.key)?.values() ?? []) {
      assert.equal(valeurOption(`${m.key}.${def.cle}`), `${m.key}.${def.cle}`, `${m.key}.${def.cle} : cle refusee dans une value de menu`);
    }
  }
});

test('/config : une commande sans option, un module, un réglage — et rien à retaper', async () => {
  const { commandeConfig, choixModules, vueModule } = await import('../src/core/config-ui.js');
  const data = commandeConfig().toJSON();
  assert.equal(data.name, 'config', 'le nom de la commande est la seule chose a retenir');
  assert.equal((data.options ?? []).length, 0, '/config ne doit AUCUNE option : un module se choisit dans le menu, pas a la souris du clavier');
  assert.ok((data.description ?? '').length <= 100, 'la description est ce que voit le membre dans la liste des commandes');
  assert.match(data.description ?? String(), /clique|clic/i, 'la description doit promettre le clic, sinon on croit qu il faut taper');

  const choix = choixModules(MODULES);
  assert.equal(choix.length, MODULES.length + 1, 'general + chaque module : un module absent est un module irreglable');
  assert.ok(choix.length <= 25, `${choix.length} options : Discord plafonne a 25 et rejetterait le message`);
  for (const o of choix) {
    assert.equal(valeurOption(o.value), o.value, `l option « ${o.value} » sera refusee par Discord`);
    assert.ok(o.name.length <= 100, `libelle trop long : ${o.name}`);
    assert.ok(o.name.length > 2, `libelle vide pour la valeur « ${o.value} » : introuvable dans le menu`);
  }

  // la vue d'un module ne doit plus rien demander a recopier
  const db = Db.memory();
  const registre = construireRegistre(MODULES);
  registre.set('general', new Map(REGLAGES_GENERAL.map((d) => [d.cle, d])));
  const c = { db, cfg: new Config(db, registre), guild: { name: 'EdgeMode' }, disabled: new Map() } as never;
  const vue = await vueModule(c, MODULES, 'welcome', false);
  const texte = JSON.stringify(vue.embeds);
  assert.ok(!texte.includes('/edge config regler'), 'un champ qui impose de recopier une commande = la plainte du joueur d a cote');
  assert.match(texte, /2️⃣/, 'la vue doit dire ou cliquer ensuite');
  assert.ok(vue.components.length <= 5, `${vue.components.length} rangees : Discord plafonne a 5 et rejette tout`);
  type Brut = { type?: number; options?: { label?: string; value?: string; description?: string }[] };
  // les builders discord.js gardent tout dans `.data` : on passe par toJSON(), comme le fera l'API.
  const brut = <T,>(x: unknown): T => {
    const f = (x as { toJSON?: () => T }).toJSON;
    return typeof f === 'function' ? f.call(x) : (x as T);
  };
  const menus = (vue.components as unknown[])
    .flatMap((r) => brut<{ components?: unknown[] }>(r).components ?? [])
    .map((x) => brut<Brut>(x));
  for (const opt of menus.flatMap((x) => x.options ?? [])) {
    assert.ok(opt.label && opt.value, `option de menu incomplete : ${JSON.stringify(opt)}`);
    if (opt.description !== undefined) assert.ok(opt.description.length >= 1 && opt.description.length <= 100, `description refusee par Discord : « ${opt.description} »`);
  }
  for (const f of (vue.embeds as unknown[]).flatMap((e) => brut<{ fields?: { name?: string; value?: string }[] }>(e).fields ?? [])) {
    assert.ok(f.name && f.value, `champ d'embed vide (Discord rejette le message entier) : ${JSON.stringify(f)}`);
  }
  assert.ok(menus.some((x) => x.type === 3), 'le menu des reglages doit etre pose la, sous les yeux');
  assert.equal(menus.filter((x) => x.type === 2).length, 5, 'couper, reinitialiser, exporter, avance, retour : les 5 boutons connus de la vue module');
});

/* ------------------------------------------------------------------ lanceur */
let echecs = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`\x1b[32m✔\x1b[0m ${t.name}`);
  } catch (e) {
    echecs++;
    console.log(`\x1b[31m✘\x1b[0m ${t.name}\n   ${(e as Error).message.split('\n').join('\n   ')}`);
  }
}
console.log(`\n${tests.length - echecs}/${tests.length} tests passent${echecs ? ` — ${echecs} ÉCHEC(S)` : ''}`);
if (echecs) process.exit(1);
