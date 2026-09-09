export function apiSettings(env = process.env) {
  const provider = env.REPORT_LLM_PROVIDER;
  if (!provider) return null;
  if (!["openai-compatible", "anthropic"].includes(provider)) throw new Error("Unsupported REPORT_LLM_PROVIDER");
  const url = new URL(env.REPORT_LLM_BASE_URL || (provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"));
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("LLM URL must use HTTPS (HTTP allowed only on localhost)");
  if (!env.REPORT_LLM_MODEL || !env.REPORT_LLM_API_KEY) throw new Error("REPORT_LLM_MODEL and REPORT_LLM_API_KEY are required");
  return { provider, baseUrl: url.href.replace(/\/$/, ""), model: env.REPORT_LLM_MODEL, key: env.REPORT_LLM_API_KEY };
}
export async function complete(prompt, settings = apiSettings(), fetchImpl = fetch) {
  if (!settings) throw new Error("API provider is not configured");
  const anthropic = settings.provider === "anthropic";
  const response = await fetchImpl(`${settings.baseUrl}/${anthropic ? "messages" : "chat/completions"}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(600_000),
    headers: { "Content-Type": "application/json", ...(anthropic ? { "x-api-key": settings.key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${settings.key}` }) },
    body: JSON.stringify({ model: settings.model, messages: [{ role: "user", content: prompt }], ...(anthropic ? { max_tokens: 8192 } : {}) }),
  });
  if (!response.ok) throw new Error(`LLM API failed: HTTP ${response.status}`);
  const body = await response.json();
  const result = anthropic ? body.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") : body.choices?.[0]?.message?.content;
  if (typeof result !== "string" || !result.trim()) throw new Error("LLM returned no text");
  if (body.stop_reason === "max_tokens" || body.choices?.[0]?.finish_reason === "length") throw new Error("LLM output was truncated");
  return { stdout: result };
}
