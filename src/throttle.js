// Adaptive rate limiter. Zero config — learns limits from 429 responses.
// Per-model queues, per-provider header parsing, exponential backoff.

// ── Provider-specific 429 parsers ──────────────────────────────────────

function parseOpenAI(headers) {
  const limits = {};
  const rpm = headers.get("x-ratelimit-limit-requests");
  const tpm = headers.get("x-ratelimit-limit-tokens");
  if (rpm) limits.rpm = Number(rpm);
  if (tpm) limits.tpm = Number(tpm);

  // parse reset time: "1s", "6m0s", "200ms"
  let waitMs = null;
  const reset = headers.get("x-ratelimit-reset-requests");
  if (reset) waitMs = parseResetDuration(reset);

  return { limits, waitMs };
}

function parseAnthropic(headers) {
  const limits = {};
  const rpm = headers.get("anthropic-ratelimit-requests-limit");
  const itpm = headers.get("anthropic-ratelimit-input-tokens-limit");
  const otpm = headers.get("anthropic-ratelimit-output-tokens-limit");
  if (rpm) limits.rpm = Number(rpm);
  if (itpm) limits.inputTpm = Number(itpm);
  if (otpm) limits.outputTpm = Number(otpm);

  let waitMs = null;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) waitMs = Number(retryAfter) * 1000;

  return { limits, waitMs };
}

function parseGemini(headers, errorStr) {
  const limits = {};

  // headers
  const rpm = headers.get("x-ratelimit-limit-requests");
  if (rpm) limits.rpm = Number(rpm);

  let waitMs = null;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) waitMs = Number(retryAfter) * 1000;

  // try to parse quota info from error body
  if (errorStr && !limits.rpm) {
    try {
      const body = typeof errorStr === "string" ? JSON.parse(errorStr) : errorStr;
      const details = body?.error?.details || [];
      for (const d of details) {
        if (d.metadata?.quota_limit_value) {
          const metric = d.metadata.quota_metric || "";
          const val = Number(d.metadata.quota_limit_value);
          if (metric.includes("requests")) limits.rpm = val;
          else if (metric.includes("token")) limits.tpm = val;
        }
      }
    } catch {}
  }

  return { limits, waitMs };
}

// parse durations like "1s", "6m0s", "200ms"
function parseResetDuration(s) {
  let ms = 0;
  const mMatch = s.match(/(\d+)m(?!\s*s)/);
  const sMatch = s.match(/(\d+)s/);
  const msMatch = s.match(/(\d+)ms/);
  if (mMatch) ms += Number(mMatch[1]) * 60000;
  if (sMatch) ms += Number(sMatch[1]) * 1000;
  if (msMatch) ms += Number(msMatch[1]);
  return ms || null;
}

function parseProvider(provider, headers, errorStr) {
  const safe = headers && typeof headers.get === "function" ? headers : { get: () => null };
  if (provider === "openai") return parseOpenAI(safe);
  if (provider === "anthropic") return parseAnthropic(safe);
  return parseGemini(safe, errorStr);
}

// ── Model state ────────────────────────────────────────────────────────

function createModelState() {
  return {
    observedLimits: { rpm: null, tpm: null, inputTpm: null, outputTpm: null },
    consecutiveFailures: 0,
    minIntervalMs: 0,
    lastRequestTime: 0,
    queue: [],
    draining: false,
  };
}

// ── AdaptiveThrottle ───────────────────────────────────────────────────

export class AdaptiveThrottle {
  constructor(opts = {}) {
    this.maxRetries = opts.maxRetries ?? 10;
    this.models = new Map();
  }

  getModelState(modelId) {
    if (!this.models.has(modelId)) this.models.set(modelId, createModelState());
    return this.models.get(modelId);
  }

  enqueue(modelId, provider, fn) {
    const state = this.getModelState(modelId);
    return new Promise((resolve, reject) => {
      state.queue.push({ fn, provider, resolve, reject, retries: 0 });
      this._drain(modelId);
    });
  }

  async _drain(modelId) {
    const state = this.getModelState(modelId);
    if (state.draining) return;
    state.draining = true;

    let skipSpacing = false;
    while (state.queue.length > 0) {
      const item = state.queue[0];

      // respect observed rate limit spacing (skip after a 429 backoff — already waited)
      if (!skipSpacing && state.minIntervalMs > 0) {
        const elapsed = Date.now() - state.lastRequestTime;
        const wait = state.minIntervalMs - elapsed;
        if (wait > 0) await sleep(wait);
      }
      skipSpacing = false;

      try {
        state.lastRequestTime = Date.now();
        const result = await item.fn();

        // learn from success headers (OpenAI sends them on every response)
        if (result?.headers?.get) {
          this._learnFromHeaders(modelId, item.provider, result.headers);
        }

        state.consecutiveFailures = 0;
        state.queue.shift();
        item.resolve(result);
      } catch (err) {
        const is429 = err && typeof err === "object" && err.status === 429;
        if (is429) {
          state.consecutiveFailures++;

          // parse provider-specific headers
          const parsed = parseProvider(item.provider, err?.headers, err?.body || err?.error || err?.message);

          // update observed limits
          this._applyLimits(modelId, parsed.limits);

          // check retry budget
          if (item.retries >= this.maxRetries) {
            state.queue.shift();
            const rateErr = new Error(`rate limited after ${this.maxRetries} retries: ${err.message || err.error || "429"}`);
            rateErr._suede_rate_limited = true;
            rateErr._suede_retries = this.maxRetries;
            rateErr._suede_model = modelId;
            item.reject(rateErr);
            continue;
          }
          item.retries++;

          // wait: prefer provider's retry-after, fall back to exponential backoff
          const backoffMs = parsed.waitMs || Math.min(60000, 500 * Math.pow(2, state.consecutiveFailures - 1));
          await sleep(backoffMs);
          skipSpacing = true; // already waited — don't double-penalize
          // don't shift — retry the same item
        } else {
          // non-429: don't retry, reject immediately
          state.queue.shift();
          item.reject(err);
        }
      }
    }

    state.draining = false;
  }

  _applyLimits(modelId, limits) {
    const state = this.getModelState(modelId);
    const obs = state.observedLimits;
    if (limits.rpm != null) obs.rpm = limits.rpm;
    if (limits.tpm != null) obs.tpm = limits.tpm;
    if (limits.inputTpm != null) obs.inputTpm = limits.inputTpm;
    if (limits.outputTpm != null) obs.outputTpm = limits.outputTpm;

    // derive min interval from RPM
    if (obs.rpm && obs.rpm > 0) {
      state.minIntervalMs = Math.ceil(60000 / obs.rpm);
    }
  }

  _learnFromHeaders(modelId, provider, headers) {
    const parsed = parseProvider(provider, headers, null);
    if (Object.values(parsed.limits).some(v => v != null)) {
      this._applyLimits(modelId, parsed.limits);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
