// /rob @membre : tenter de voler l'argent « sur soi » d'un membre (pas celui qui est à la banque).
//  - Une tentative toutes les robCooldownHours heures (3 h par défaut).
//  - Réussite : chance de base (robSuccessPercent, 50 % par défaut) ajustée selon le solde de la victime : plus elle
//    est riche, plus la chance est haute (+5 points par multiplication par 10 au-dessus de 1 000 $, borné à ±20).
//    La chance reste entre 5 et 90 %.
//  - Réussite : le voleur prend entre 1 % et robMaxPercent % du solde de la victime.
//  - Échec : le voleur verse une amende entre robFailMin et robFailMax (limitée à son solde).
// Tout est tiré et enregistré côté base (edge_economy_rob, section 14 de schema.sql).
const store = require('../store');
const { embed, ephemeralPayload } = require('../ui');
const { formatMoney } = require('../economy-money');

// Ajustement de la chance selon le solde de la victime (ces constantes sont transmises à la base).
const WEALTH = { ref: 1000, slope: 5, clamp: 20 };

function robSettings(cfg) {
  return {
    cooldownHours: cfg.robCooldownHours,
    base: cfg.robSuccessPercent,
    ...WEALTH,
    maxPercent: cfg.robMaxPercent,
    fineMin: cfg.robFailMin,
    fineMax: cfg.robFailMax,
  };
}

const mention = (id) => `<@${id}>`;

async function handleRob(interaction, cfg) {
  const guild = interaction.guild;
  const thief = interaction.user;
  const target = interaction.options.getUser('membre', true);
  if (target.bot) return interaction.reply(ephemeralPayload('Les bots n’ont pas d’argent à voler.'));
  if (target.id === thief.id) return interaction.reply(ephemeralPayload('Tu ne peux pas te voler toi-même.'));

  const res = await store.economyRob(guild.id, thief.id, target.id, robSettings(cfg));
  switch (res.status) {
    case 'not_started':
      return interaction.reply(ephemeralPayload('Ouvre d’abord ton compte avec **/play** pour voler.'));
    case 'victim_not_started':
      return interaction.reply(ephemeralPayload(`${mention(target.id)} n’a pas encore de compte : il n’a rien à voler.`));
    case 'self':
      return interaction.reply(ephemeralPayload('Tu ne peux pas te voler toi-même.'));
    case 'cooldown': {
      const unix = Math.floor(Date.parse(res.next_at) / 1000);
      return interaction.reply(ephemeralPayload(`Tu dois attendre encore un peu : prochain vol <t:${unix}:R>.`));
    }
    case 'empty':
      return interaction.reply(
        ephemeralPayload(
          `${mention(target.id)} n’a rien sur lui. Son argent est peut-être à la banque, à l’abri des voleurs.`,
        ),
      );
    case 'ok':
      return res.success ? robSucceeded(interaction, cfg, target, res) : robFailed(interaction, cfg, target, res);
    default:
      return interaction.reply(ephemeralPayload('Le vol n’a pas pu aboutir. Réessaie dans un instant.'));
  }
}

// Résultat public : le voleur, la victime et le montant. Pas de ping (allowedMentions vide).
function robSucceeded(interaction, cfg, target, res) {
  const text =
    `🦹 ${mention(interaction.user.id)} a volé **${formatMoney(res.amount, cfg)}** à ${mention(target.id)} ` +
    `(${res.pct} % de son solde). Chance de réussite : ${res.chance} %.`;
  return interaction.reply({ embeds: [embed(text)], allowedMentions: { parse: [] } });
}

function robFailed(interaction, cfg, target, res) {
  const fine = Number(res.fine);
  const paid = Number(res.paid);
  const verdict =
    paid > 0
      ? `verse **${formatMoney(paid, cfg)}** à ${mention(target.id)}` +
        (paid < fine ? ` (amende de ${formatMoney(fine, cfg)} limitée à son solde)` : '')
      : `n’a plus rien à verser à ${mention(target.id)}`;
  const text = `🚓 ${mention(interaction.user.id)} a raté son coup et ${verdict}. Chance de réussite : ${res.chance} %.`;
  return interaction.reply({ embeds: [embed(text)], allowedMentions: { parse: [] } });
}

module.exports = { handleRob, robSettings, WEALTH };
