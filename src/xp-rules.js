// Règles de gain d'XP, partagées entre le moteur de niveaux (leveling.js) et le module de configuration.
const VOICE_XP = 20; // XP crédités à chaque intervalle vocal
const VOICE_TICK_MS = 30_000; // intervalle vocal : toutes les 30 secondes
const TEXT_XP = 5; // XP par message écrit (sans limite de fréquence)

module.exports = { VOICE_XP, VOICE_TICK_MS, TEXT_XP };
