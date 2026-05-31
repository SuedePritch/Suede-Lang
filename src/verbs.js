// Model verbs — the seven operations that require ~= and cost tokens.
// Each verb has a baked-in prompt template and a response parser.
// Users never write prompts. The verbs are the interface.

export const MODEL_VERBS = new Set([
  "extract",
  "classify",
  "rewrite",
  "expand",
  "compress",
  "generate",
]);

export function buildPrompt(verb, input, options) {
  const inp = typeof input === "string" ? input : JSON.stringify(input);
  const JSON_SUFFIX = "\n\nReturn ONLY valid JSON (no markdown, no code fences, no explanation).";
  switch (verb) {
    case "extract":
      return `Extract the following fields from this text.\n\nFields: ${JSON.stringify(options.fields || [])}\n\nText: ${inp}\n\nReturn a JSON object with those fields. For numeric values like budget, return numbers not strings.${JSON_SUFFIX}`;
    case "classify":
      return `Classify this text into exactly one of these categories: ${JSON.stringify(options.into || [])}\n\nText: ${inp}\n\nReturn JSON: {"label":"<category>"}${JSON_SUFFIX}`;
    case "compress":
      return `Summarize this text in ${options.max || 60} characters or fewer${options.preserve ? `, preserving these details: ${JSON.stringify(options.preserve)}` : ""}.\n\nText: ${inp}\n\nReturn JSON: {"text":"<summary>"}${JSON_SUFFIX}`;
    case "rewrite":
      return `Rewrite this text${options.style ? ` in a ${options.style} style` : ""}.\n\nText: ${inp}\n\nReturn JSON: {"text":"<rewritten>"}${JSON_SUFFIX}`;
    case "expand":
      return `Expand on this text${options.max ? ` in about ${options.max} words` : ""}.\n\nText: ${inp}\n\nReturn JSON: {"text":"<expanded>"}${JSON_SUFFIX}`;
    case "generate":
      return `Generate content based on this:\n\n${inp}\n\nReturn a JSON object with these fields: ${JSON.stringify(options.format || ["text"])}${JSON_SUFFIX}`;
    default:
      return inp;
  }
}

// Aggressively clean model output into valid JSON.
// Models return markdown fences, single quotes, trailing commas, control chars,
// unquoted keys, boolean/null as strings, etc. This handles all of it.
// Throws if nothing parseable can be recovered.
export function asJson(input) {
  if (typeof input === "object" && input !== null) return input;
  const s = String(input);

  // fast path: already valid
  try {
    return JSON.parse(s);
  } catch {}

  // slow path: clean it up
  const cleaned = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .replace(/^[^{[]*([{[])/, "$1")
    .replace(/([}\]])([^}\]]*)$/, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/\n/g, " ");

  try {
    return JSON.parse(cleaned);
  } catch {}

  // deeper cleanup: fix quotes and keys
  const deeper = cleaned
    .replace(/(['"])?([a-zA-Z_][a-zA-Z0-9_]*)(['"])?(?=\s*:)/g, '"$2"')
    .replace(/:\s*'([^']*)'/g, ': "$1"');

  try {
    return JSON.parse(deeper);
  } catch {}

  // last resort: try to repair truncated JSON (model hit max_tokens)
  // close any open brackets/braces and strip trailing partial values
  let repaired = deeper
    .replace(/,\s*"[^"]*$/, "")   // remove trailing partial key
    .replace(/,\s*$/, "");         // remove trailing comma
  // count unclosed braces/brackets and close them
  let openBraces = 0, openBrackets = 0;
  for (const ch of repaired) {
    if (ch === "{") openBraces++;
    else if (ch === "}") openBraces--;
    else if (ch === "[") openBrackets++;
    else if (ch === "]") openBrackets--;
  }
  repaired += "]".repeat(Math.max(0, openBrackets)) + "}".repeat(Math.max(0, openBraces));

  try {
    return JSON.parse(repaired);
  } catch {}

  throw new Error(`could not parse model output as JSON: ${s.slice(0, 200)}`);
}

export function parseResponse(verb, value) {
  // if already an object/array (from a stub), pass through as-is
  if (typeof value === "object" && value !== null) return value;

  // parse raw string through asJson — all verbs return JSON objects
  return asJson(value);
}

// Built-in verb contract enforcement.
// extract must return all requested fields. classify must return a valid label.
// generate with format: must return all requested keys.
export function validateVerbContract(verb, value, namedArgs) {
  switch (verb) {
    case "extract": {
      const fields = namedArgs.fields;
      if (!Array.isArray(fields) || typeof value !== "object" || value == null)
        break;
      const missing = fields.filter(
        (f) => !(f in value) || value[f] == null || value[f] === "",
      );
      if (missing.length) {
        throw new Error(
          `extract failed: missing or empty fields: ${missing.join(", ")}`,
        );
      }
      break;
    }
    case "classify": {
      const into = namedArgs.into;
      if (!Array.isArray(into)) break;
      const labels = into.map((l) => String(l).toLowerCase());
      const raw = typeof value === "object" && value !== null && value.label !== undefined
        ? value.label : value;
      const got = String(raw).toLowerCase();
      if (!labels.includes(got)) {
        throw new Error(
          `classify returned '${raw}', expected one of: ${labels.join(", ")}`,
        );
      }
      break;
    }
    case "generate": {
      const format = namedArgs.format;
      if (!Array.isArray(format) || typeof value !== "object" || value == null)
        break;
      const missing = format.filter((f) => !(f in value));
      if (missing.length) {
        throw new Error(
          `generate failed: missing fields: ${missing.join(", ")}`,
        );
      }
      break;
    }
  }
}

export function validateExpect(value, expect) {
  if (typeof value !== "object" || value == null) {
    throw new Error(
      `expected object with fields {${Object.keys(expect).join(", ")}}, got ${typeof value}`,
    );
  }
  for (const [field, type] of Object.entries(expect)) {
    if (!(field in value))
      throw new Error(`expected field '${field}' missing from model output`);
    const v = value[field];
    const ok =
      (type === "text" && typeof v === "string") ||
      (type === "num" && typeof v === "number") ||
      (type === "bool" && typeof v === "boolean") ||
      (type === "list" && Array.isArray(v)) ||
      (type === "obj" &&
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v));
    if (!ok)
      throw new Error(
        `field '${field}' expected type '${type}', got ${typeof v}`,
      );
  }
}
