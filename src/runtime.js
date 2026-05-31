// Runtime infrastructure — cache.
// Rate limiting is handled by AdaptiveThrottle in throttle.js.

// ── Cache ───────────────────────────────────────────────────────────────
export class CallCache {
  constructor(ttl = 3600) {
    this.ttl = ttl * 1000;
    this.map = new Map();
  }
  _key(verb, input, options, modelId) {
    return JSON.stringify([verb, input, options, modelId]);
  }
  get(verb, input, options, modelId) {
    const k = this._key(verb, input, options, modelId);
    const entry = this.map.get(k);
    if (!entry) return null;
    if (Date.now() - entry.time > this.ttl) {
      this.map.delete(k);
      return null;
    }
    return entry.result;
  }
  set(verb, input, options, modelId, result) {
    this.map.set(this._key(verb, input, options, modelId), {
      result,
      time: Date.now(),
    });
  }
}
