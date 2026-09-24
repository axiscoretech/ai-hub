const STREAMS = [
  { service: "ChatGPT", method: "POST", url: /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/backend-api\/(?:f\/)?conversation(?:\/|$|\?)/i },
  { service: "Claude", method: "POST", url: /^https:\/\/claude\.ai\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion(?:\/|$|\?)/i },
  { service: "Gemini", method: "POST", url: /^https:\/\/gemini\.google\.com\/.*StreamGenerate(?:\?|$)/i },
  { service: "DeepSeek", method: "POST", url: /^https:\/\/chat\.deepseek\.com\/api\/v0\/chat\/completion(?:\/|$|\?)/i },
  { service: "Qwen", method: "POST", url: /^https:\/\/chat\.qwen\.ai\/api\/v2\/chat\/completions?(?:\/|$|\?)/i },
  { service: "Perplexity", method: "POST", url: /^https:\/\/www\.perplexity\.ai\/rest\/.*perplexity_ask(?:\/|$|\?)/i },
  { service: "Mistral", method: "POST", url: /^https:\/\/chat\.mistral\.ai\/api\/chat(?:\/|$|\?)/i },
  { service: "Kimi", method: "POST", url: /^https:\/\/(?:www\.)?kimi\.com\/api\/chat\/[^/]+\/completion(?:\/|$|\?)/i },
  { service: "Grok", method: "POST", url: /^https:\/\/grok\.com\/rest\/app-chat\/conversations\/[^/]+\/responses(?:\/|$|\?)/i },
];

const SKIP_TYPES = new Set(["image", "stylesheet", "script", "font", "media", "ping", "cspReport"]);

function streamEnded(service, details) {
  if (!details || typeof details.url !== "string") return false;
  if (SKIP_TYPES.has(details.resourceType)) return false;
  const status = Number(details.statusCode);
  if (!Number.isFinite(status) || status < 200 || status >= 400) return false;
  const method = String(details.method || "GET").toUpperCase();
  return STREAMS.some((pattern) => (
    pattern.service === service
    && pattern.method === method
    && pattern.url.test(details.url)
  ));
}

module.exports = {
  STREAMS,
  streamEnded,
};
