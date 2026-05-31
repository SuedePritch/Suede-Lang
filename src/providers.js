// API providers — baked into the runtime.
// The interpreter calls these directly. Users never write API code.

export async function callModel(
  prompt,
  verb,
  input,
  modelId,
  modelOpts,
  config,
  systemPrompt,
) {
  const provider = config?.provider || "gemini";
  if (provider === "gemini" || provider === "google") {
    return callGemini(prompt, verb, input, modelId, modelOpts, config, systemPrompt);
  }
  if (provider === "anthropic") {
    return callAnthropic(prompt, verb, input, modelId, modelOpts, config, systemPrompt);
  }
  if (provider === "openai") {
    return callOpenAI(prompt, verb, input, modelId, modelOpts, config, systemPrompt);
  }
  throw new Error(
    `unknown provider '${provider}' — supported: gemini, anthropic, openai`,
  );
}

async function callGemini(prompt, verb, input, modelId, modelOpts, config, systemPrompt) {
  const apiKey = config?.api_key;
  if (!apiKey || apiKey.startsWith("${"))
    throw new Error("api_key not set in init block");

  const model = modelId || "gemini-2.0-flash";

  // text generation
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: modelOpts?.max_tokens || 1024 },
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (modelOpts?.temperature !== undefined)
    body.generationConfig.temperature = modelOpts.temperature;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const t = await r.text();
    let detail = t;
    try { detail = JSON.parse(t)?.error?.message || t; } catch {}
    const err = new Error(`gemini ${r.status}: ${detail}`);
    err.status = r.status;
    err.headers = r.headers;
    err.body = t;
    throw err;
  }
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const usage = data.usageMetadata || {};
  return {
    value: text,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
  };
}

async function callOpenAI(prompt, verb, input, modelId, modelOpts, config, systemPrompt) {
  const apiKey = config?.api_key;
  if (!apiKey || apiKey.startsWith("${"))
    throw new Error("api_key not set in init block");

  const model = modelId || "gpt-4o-mini";
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });
  const body = {
    model,
    messages,
    max_tokens: modelOpts?.max_tokens || 1024,
  };
  if (modelOpts?.temperature !== undefined)
    body.temperature = modelOpts.temperature;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    let detail = t;
    try { detail = JSON.parse(t)?.error?.message || t; } catch {}
    const err = new Error(`openai ${r.status}: ${detail}`);
    err.status = r.status;
    err.headers = r.headers;
    err.body = t;
    throw err;
  }
  const data = await r.json();
  return {
    value: data.choices?.[0]?.message?.content || "",
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function callAnthropic(prompt, verb, input, modelId, modelOpts, config, systemPrompt) {
  const apiKey = config?.api_key;
  if (!apiKey || apiKey.startsWith("${"))
    throw new Error("api_key not set in init block");

  const body = {
    model: modelId || "claude-haiku-4-5-20251001",
    max_tokens: modelOpts?.max_tokens || 1024,
    messages: [{ role: "user", content: prompt }],
  };
  if (systemPrompt) body.system = systemPrompt;
  if (modelOpts?.temperature !== undefined)
    body.temperature = modelOpts.temperature;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    let detail = t;
    try { detail = JSON.parse(t)?.error?.message || t; } catch {}
    const err = new Error(`anthropic ${r.status}: ${detail}`);
    err.status = r.status;
    err.headers = r.headers;
    err.body = t;
    throw err;
  }
  const data = await r.json();
  return {
    value: data.content[0]?.text || "",
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}
