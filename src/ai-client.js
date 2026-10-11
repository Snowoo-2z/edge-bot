// Client minimal de l'API Mistral (chat completions). La clé vient UNIQUEMENT de la variable
// d'environnement MISTRAL_API_KEY : elle n'est ni écrite sur disque, ni journalisée, ni renvoyée au tableau de bord.
const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const TIMEOUT_MS = 20000;

class AiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function apiKey() {
  return (process.env.MISTRAL_API_KEY ?? '').trim();
}

function isConfigured() {
  return apiKey().length > 0;
}

// messages : [{ role, content, ... }] (conversation complète). tools : outils proposés au modèle (facultatif).
// Renvoie { text, toolCalls } : le texte (peut être vide si le modèle appelle un outil) et les appels demandés.
async function chat({ model, messages, tools, temperature = 0.5, maxTokens = 400 }) {
  const key = apiKey();
  if (!key) {
    throw new AiError('Clé MISTRAL_API_KEY absente : ajoute-la aux variables d’environnement de l’hébergeur.', 'no_key');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AiError(
      err.name === 'AbortError' ? 'Mistral ne répond pas (délai dépassé).' : 'Connexion à Mistral impossible.',
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AiError('Clé Mistral refusée (401/403) : vérifie MISTRAL_API_KEY.', 'auth');
  }
  if (res.status === 429) throw new AiError('Limite Mistral atteinte : réessaie dans un moment.', 'rate');
  if (!res.ok) throw new AiError(`Mistral a répondu ${res.status}.`, 'http');

  const data = await res.json().catch(() => null);
  const message = data?.choices?.[0]?.message ?? {};
  const text = typeof message.content === 'string' ? message.content.trim() : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!text && !toolCalls.length) throw new AiError('Réponse vide de Mistral.', 'empty');
  return { text, toolCalls, message };
}

module.exports = { chat, isConfigured, AiError };
