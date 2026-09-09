import test from "node:test";
import assert from "node:assert/strict";
import { apiSettings, complete } from "./llm-api.mjs";
const env = { REPORT_LLM_PROVIDER: "openai-compatible", REPORT_LLM_MODEL: "test-model", REPORT_LLM_API_KEY: "test-key" };
test("unset provider preserves the CLI route; configured APIs require credentials and secure URL", () => {
  assert.equal(apiSettings({}), null);
  for (const patch of [{ REPORT_LLM_PROVIDER: "typo" }, { REPORT_LLM_API_KEY: "" }, { REPORT_LLM_BASE_URL: "http://external.example/v1" }, { REPORT_LLM_BASE_URL: "https://user:pass@example.com" }]) assert.throws(() => apiSettings({ ...env, ...patch }));
  assert.equal(apiSettings({ ...env, REPORT_LLM_BASE_URL: "http://localhost:1234/v1/" }).baseUrl, "http://localhost:1234/v1");
});
test("OpenAI-compatible request uses selected model and has no tools", async () => {
  const result = await complete("synthetic input", apiSettings(env), async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "test-model"); assert.equal(body.messages[0].content, "synthetic input"); assert.equal(body.tools, undefined);
    return Response.json({ choices: [{ message: { content: "[]" }, finish_reason: "stop" }] });
  });
  assert.equal(result.stdout, "[]");
});
test("Anthropic request and text blocks", async () => {
  const result = await complete("test", apiSettings({ ...env, REPORT_LLM_PROVIDER: "anthropic" }), async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages"); assert.equal(init.headers["x-api-key"], "test-key");
    return Response.json({ content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "[]" }], stop_reason: "end_turn" });
  });
  assert.equal(result.stdout, "[]");
});
test("HTTP errors, empty and truncated output fail without exposing provider error body", async () => {
  await assert.rejects(complete("x", apiSettings(env), async () => new Response("secret", { status: 401 })), /HTTP 401$/);
  for (const body of [{}, { choices: [{ message: { content: "[" }, finish_reason: "length" }] }]) await assert.rejects(complete("x", apiSettings(env), async () => Response.json(body)));
});
