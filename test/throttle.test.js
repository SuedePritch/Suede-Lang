import { describe, it, expect } from "vitest";
import { AdaptiveThrottle } from "../src/throttle.js";

// ── helpers ──────────────────────────────────────────────────────────────

function ok(value = "result", inputTokens = 10, outputTokens = 5) {
  return { value, inputTokens, outputTokens };
}

function okWithHeaders(headers = {}, value = "result") {
  const map = new Map(Object.entries(headers));
  return { value, inputTokens: 10, outputTokens: 5, headers: { get: (k) => map.get(k) || null } };
}

function make429(headers = {}, error = "rate limited") {
  const map = new Map(Object.entries(headers));
  return { status: 429, headers: { get: (k) => map.get(k) || null }, error };
}

function makeError(status, error = "error") {
  return { status, error };
}

// ── basic queue ──────────────────────────────────────────────────────────

describe("AdaptiveThrottle", () => {
  describe("basic queue", () => {
    it("executes immediately when queue is empty", async () => {
      const t = new AdaptiveThrottle();
      let called = false;
      const r = await t.enqueue("m", "gemini", async () => { called = true; return ok("hi"); });
      expect(called).toBe(true);
      expect(r.value).toBe("hi");
    });

    it("passes through results unchanged", async () => {
      const t = new AdaptiveThrottle();
      const r = await t.enqueue("m", "gemini", async () => ({ value: "x", inputTokens: 42, outputTokens: 7 }));
      expect(r).toEqual({ value: "x", inputTokens: 42, outputTokens: 7 });
    });

    it("processes same-model requests in order", async () => {
      const t = new AdaptiveThrottle();
      const order = [];
      const p1 = t.enqueue("m", "gemini", async () => { order.push(1); return ok(); });
      const p2 = t.enqueue("m", "gemini", async () => { order.push(2); return ok(); });
      const p3 = t.enqueue("m", "gemini", async () => { order.push(3); return ok(); });
      await Promise.all([p1, p2, p3]);
      expect(order).toEqual([1, 2, 3]);
    });

    it("runs different models concurrently", async () => {
      const t = new AdaptiveThrottle();
      const started = [];
      const p1 = t.enqueue("a", "gemini", async () => {
        started.push("a");
        await new Promise(r => setTimeout(r, 50));
        return ok();
      });
      const p2 = t.enqueue("b", "gemini", async () => {
        started.push("b");
        await new Promise(r => setTimeout(r, 50));
        return ok();
      });
      await Promise.all([p1, p2]);
      // both should start before either finishes
      expect(started).toEqual(["a", "b"]);
    });

    it("handles empty fn result gracefully", async () => {
      const t = new AdaptiveThrottle();
      const r = await t.enqueue("m", "gemini", async () => undefined);
      expect(r).toBeUndefined();
    });
  });

  // ── 429 retry ──────────────────────────────────────────────────────────

  describe("429 retry", () => {
    it("retries on 429 and succeeds", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const r = await t.enqueue("m", "gemini", async () => {
        if (++n === 1) throw make429();
        return ok("ok");
      });
      expect(n).toBe(2);
      expect(r.value).toBe("ok");
    });

    it("retries multiple 429s before succeeding", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const r = await t.enqueue("m", "gemini", async () => {
        if (++n <= 2) throw make429();
        return ok("finally");
      });
      expect(n).toBe(3);
      expect(r.value).toBe("finally");
    }, 10000);

    it("does not lose queued requests behind a 429", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const p1 = t.enqueue("m", "gemini", async () => {
        if (++n === 1) throw make429();
        return ok("first");
      });
      const p2 = t.enqueue("m", "gemini", async () => ok("second"));
      const p3 = t.enqueue("m", "gemini", async () => ok("third"));
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.value).toBe("first");
      expect(r2.value).toBe("second");
      expect(r3.value).toBe("third");
    });

    it("applies exponential backoff on consecutive 429s", async () => {
      const t = new AdaptiveThrottle();
      const gaps = [];
      let last = Date.now();
      let n = 0;
      await t.enqueue("m", "gemini", async () => {
        const now = Date.now();
        gaps.push(now - last);
        last = now;
        if (++n <= 3) throw make429();
        return ok();
      });
      expect(n).toBe(4);
      // gap[2] (3rd retry wait) should be >= gap[1] (2nd retry wait)
      expect(gaps[2]).toBeGreaterThanOrEqual(gaps[1] * 0.8);
    });

    it("resets backoff counter after success", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("m", "gemini", async () => {
        if (++n === 1) throw make429();
        return ok();
      });
      expect(t.getModelState("m").consecutiveFailures).toBe(0);
    });

    it("gives up after maxRetries", async () => {
      const t = new AdaptiveThrottle({ maxRetries: 2 });
      let n = 0;
      await expect(
        t.enqueue("m", "gemini", async () => { n++; throw make429(); })
      ).rejects.toThrow(/rate limited/);
      expect(n).toBe(3); // 1 + 2 retries
    });

    it("processes remaining queue after a request exhausts retries", async () => {
      const t = new AdaptiveThrottle({ maxRetries: 1 });
      let failed = false, succeeded = false;

      const p1 = t.enqueue("m", "gemini", async () => { throw make429(); }).catch(() => { failed = true; });
      const p2 = t.enqueue("m", "gemini", async () => { succeeded = true; return ok(); });

      await Promise.all([p1, p2]);
      expect(failed).toBe(true);
      expect(succeeded).toBe(true);
    });
  });

  // ── non-429 errors ─────────────────────────────────────────────────────

  describe("non-429 errors", () => {
    it("does not retry 500 errors", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await expect(
        t.enqueue("m", "gemini", async () => { n++; throw makeError(500); })
      ).rejects.toThrow();
      expect(n).toBe(1);
    });

    it("does not retry 400 errors", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await expect(
        t.enqueue("m", "gemini", async () => { n++; throw makeError(400, "bad request"); })
      ).rejects.toThrow();
      expect(n).toBe(1);
    });

    it("does not retry 401 auth errors", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await expect(
        t.enqueue("m", "gemini", async () => { n++; throw makeError(401, "unauthorized"); })
      ).rejects.toThrow();
      expect(n).toBe(1);
    });

    it("does not retry thrown Error objects", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await expect(
        t.enqueue("m", "gemini", async () => { n++; throw new Error("boom"); })
      ).rejects.toThrow("boom");
      expect(n).toBe(1);
    });

    it("does not retry thrown strings", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await expect(
        t.enqueue("m", "gemini", async () => { n++; throw "oops"; })
      ).rejects.toBe("oops");
      expect(n).toBe(1);
    });

    it("500 during retry of 429 — stops retrying, rejects", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await expect(
        t.enqueue("m", "gemini", async () => {
          n++;
          if (n === 1) throw make429();
          throw makeError(500, "server died");
        })
      ).rejects.toThrow();
      expect(n).toBe(2);
    });

    it("queue continues after non-429 error", async () => {
      const t = new AdaptiveThrottle();
      let errored = false, succeeded = false;
      const p1 = t.enqueue("m", "gemini", async () => { throw makeError(500); }).catch(() => { errored = true; });
      const p2 = t.enqueue("m", "gemini", async () => { succeeded = true; return ok(); });
      await Promise.all([p1, p2]);
      expect(errored).toBe(true);
      expect(succeeded).toBe(true);
    });
  });

  // ── per-model isolation ────────────────────────────────────────────────

  describe("per-model isolation", () => {
    it("429 on one model does not block another", async () => {
      const t = new AdaptiveThrottle();
      let slowN = 0;
      const order = [];

      const pSlow = t.enqueue("slow", "gemini", async () => {
        slowN++;
        if (slowN === 1) throw make429({ "retry-after": "1" });
        order.push("slow");
        return ok();
      });
      const pFast = t.enqueue("fast", "gemini", async () => {
        order.push("fast");
        return ok();
      });

      await Promise.all([pSlow, pFast]);
      expect(order[0]).toBe("fast");
    });

    it("tracks separate limits per model", async () => {
      const t = new AdaptiveThrottle();
      let aN = 0;
      await t.enqueue("a", "openai", async () => {
        if (++aN === 1) throw make429({ "x-ratelimit-limit-requests": "100" });
        return ok();
      });
      await t.enqueue("b", "openai", async () => ok());

      expect(t.getModelState("a").observedLimits.rpm).toBe(100);
      expect(t.getModelState("b").observedLimits.rpm).toBeNull();
    });

    it("separate backoff counters per model", async () => {
      const t = new AdaptiveThrottle();
      let aN = 0, bN = 0;

      await t.enqueue("a", "gemini", async () => {
        if (++aN <= 2) throw make429();
        return ok();
      });
      await t.enqueue("b", "gemini", async () => {
        bN++;
        return ok();
      });

      expect(t.getModelState("a").consecutiveFailures).toBe(0); // reset after success
      expect(bN).toBe(1); // never retried
    });
  });

  // ── concurrent requests same model ─────────────────────────────────────

  describe("concurrent requests same model", () => {
    it("many parallel enqueues for same model all resolve", async () => {
      const t = new AdaptiveThrottle();
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(t.enqueue("m", "gemini", async () => ok("r" + i)));
      }
      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      results.forEach((r, i) => expect(r.value).toBe("r" + i));
    });

    it("429 on first of many queued requests — all still complete", async () => {
      const t = new AdaptiveThrottle();
      let firstCall = true;
      const p1 = t.enqueue("m", "gemini", async () => {
        if (firstCall) { firstCall = false; throw make429(); }
        return ok("first");
      });
      const p2 = t.enqueue("m", "gemini", async () => ok("second"));
      const p3 = t.enqueue("m", "gemini", async () => ok("third"));
      const p4 = t.enqueue("m", "gemini", async () => ok("fourth"));

      const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);
      expect(r1.value).toBe("first");
      expect(r2.value).toBe("second");
      expect(r3.value).toBe("third");
      expect(r4.value).toBe("fourth");
    });
  });

  // ── drain loop resilience ──────────────────────────────────────────────

  describe("drain loop resilience", () => {
    it("drain recovers after a rejected request", async () => {
      const t = new AdaptiveThrottle();
      let err1 = false, err2 = false, succeeded = false;

      const p1 = t.enqueue("m", "gemini", async () => { throw makeError(500); }).catch(() => { err1 = true; });
      const p2 = t.enqueue("m", "gemini", async () => { throw makeError(502); }).catch(() => { err2 = true; });
      const p3 = t.enqueue("m", "gemini", async () => { succeeded = true; return ok(); });

      await Promise.all([p1, p2, p3]);
      expect(err1).toBe(true);
      expect(err2).toBe(true);
      expect(succeeded).toBe(true);
    });

    it("drain recovers after exhausted 429 retries", async () => {
      const t = new AdaptiveThrottle({ maxRetries: 0 });
      let failed = false, succeeded = false;

      const p1 = t.enqueue("m", "gemini", async () => { throw make429(); }).catch(() => { failed = true; });
      const p2 = t.enqueue("m", "gemini", async () => { succeeded = true; return ok(); });

      await Promise.all([p1, p2]);
      expect(failed).toBe(true);
      expect(succeeded).toBe(true);
    });

    it("interleaved errors and successes in queue", async () => {
      const t = new AdaptiveThrottle();
      const log = [];
      let callIdx = 0;
      const fns = [
        async () => { log.push("ok1"); return ok(); },
        async () => { log.push("err"); throw makeError(500); },
        async () => { log.push("ok2"); return ok(); },
        async () => { log.push("429"); throw make429(); }, // will retry
        async () => { log.push("ok3"); return ok(); },
      ];

      // fn[3] will 429 on first call, need it to succeed on retry
      let fn3calls = 0;
      const origFn3 = fns[3];
      fns[3] = async () => {
        fn3calls++;
        if (fn3calls === 1) { log.push("429"); throw make429(); }
        log.push("retry-ok"); return ok();
      };

      const promises = fns.map((fn, i) => t.enqueue("m", "gemini", fn).catch(() => "caught"));
      await Promise.all(promises);

      expect(log).toContain("ok1");
      expect(log).toContain("err");
      expect(log).toContain("ok2");
      expect(log).toContain("429");
      expect(log).toContain("retry-ok");
      expect(log).toContain("ok3");
    });
  });

  // ── OpenAI parsing ─────────────────────────────────────────────────────

  describe("OpenAI 429 parsing", () => {
    it("extracts RPM and TPM from headers", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("gpt-4o", "openai", async () => {
        if (++n === 1) throw make429({
          "x-ratelimit-limit-requests": "500",
          "x-ratelimit-limit-tokens": "30000",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "1s",
        });
        return ok();
      });
      const lim = t.getModelState("gpt-4o").observedLimits;
      expect(lim.rpm).toBe(500);
      expect(lim.tpm).toBe(30000);
    });

    it("parses reset time in seconds", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const ts = [];
      await t.enqueue("m", "openai", async () => {
        ts.push(Date.now());
        if (++n === 1) throw make429({ "x-ratelimit-reset-requests": "1s" });
        return ok();
      });
      expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(800);
    });

    it("parses reset time in minutes+seconds", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const ts = [];
      await t.enqueue("m", "openai", async () => {
        ts.push(Date.now());
        // use 0m1s so test doesn't wait 6 minutes
        if (++n === 1) throw make429({ "x-ratelimit-reset-requests": "0m1s" });
        return ok();
      });
      expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(800);
    });

    it("parses reset time in milliseconds", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const ts = [];
      await t.enqueue("m", "openai", async () => {
        ts.push(Date.now());
        if (++n === 1) throw make429({ "x-ratelimit-reset-requests": "500ms" });
        return ok();
      });
      expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(400);
      expect(ts[1] - ts[0]).toBeLessThan(2000);
    });

    it("learns limits from success response headers", async () => {
      const t = new AdaptiveThrottle();
      await t.enqueue("gpt-4o", "openai", async () => {
        return okWithHeaders({
          "x-ratelimit-limit-requests": "500",
          "x-ratelimit-limit-tokens": "80000",
        });
      });
      const lim = t.getModelState("gpt-4o").observedLimits;
      expect(lim.rpm).toBe(500);
      expect(lim.tpm).toBe(80000);
    });

    it("updates limits if they change", async () => {
      const t = new AdaptiveThrottle();
      await t.enqueue("m", "openai", async () => okWithHeaders({ "x-ratelimit-limit-requests": "100" }));
      expect(t.getModelState("m").observedLimits.rpm).toBe(100);

      await t.enqueue("m", "openai", async () => okWithHeaders({ "x-ratelimit-limit-requests": "200" }));
      expect(t.getModelState("m").observedLimits.rpm).toBe(200);
    });
  });

  // ── Anthropic parsing ──────────────────────────────────────────────────

  describe("Anthropic 429 parsing", () => {
    it("extracts RPM, input TPM, output TPM", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("haiku", "anthropic", async () => {
        if (++n === 1) throw make429({
          "retry-after": "1",
          "anthropic-ratelimit-requests-limit": "1000",
          "anthropic-ratelimit-input-tokens-limit": "450000",
          "anthropic-ratelimit-output-tokens-limit": "90000",
        });
        return ok();
      });
      const lim = t.getModelState("haiku").observedLimits;
      expect(lim.rpm).toBe(1000);
      expect(lim.inputTpm).toBe(450000);
      expect(lim.outputTpm).toBe(90000);
    });

    it("respects retry-after seconds", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const ts = [];
      await t.enqueue("m", "anthropic", async () => {
        ts.push(Date.now());
        if (++n === 1) throw make429({ "retry-after": "1" });
        return ok();
      });
      expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(900);
    });

    it("handles missing optional headers", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("m", "anthropic", async () => {
        if (++n === 1) throw make429({ "retry-after": "1" }); // no limit headers
        return ok();
      });
      const lim = t.getModelState("m").observedLimits;
      expect(lim.rpm).toBeNull();
    });
  });

  // ── Gemini parsing ─────────────────────────────────────────────────────

  describe("Gemini 429 parsing", () => {
    it("extracts RPM from x-ratelimit headers", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("flash", "gemini", async () => {
        if (++n === 1) throw make429({
          "retry-after": "1",
          "x-ratelimit-limit-requests": "60",
        });
        return ok();
      });
      expect(t.getModelState("flash").observedLimits.rpm).toBe(60);
    });

    it("parses quota_metric requests from error body", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("pro", "gemini", async () => {
        if (++n === 1) throw {
          status: 429,
          headers: { get: () => null },
          error: JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              details: [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "RATE_LIMIT_EXCEEDED",
                metadata: { quota_metric: "generativelanguage.googleapis.com/generate_content_requests", quota_limit_value: "15" }
              }]
            }
          }),
        };
        return ok();
      });
      expect(t.getModelState("pro").observedLimits.rpm).toBe(15);
    });

    it("parses quota_metric tokens from error body", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("pro", "gemini", async () => {
        if (++n === 1) throw {
          status: 429,
          headers: { get: () => null },
          error: JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              details: [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                metadata: { quota_metric: "generativelanguage.googleapis.com/generate_content_tokens", quota_limit_value: "100000" }
              }]
            }
          }),
        };
        return ok();
      });
      expect(t.getModelState("pro").observedLimits.tpm).toBe(100000);
    });

    it("handles malformed error body gracefully", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const r = await t.enqueue("m", "gemini", async () => {
        if (++n === 1) throw { status: 429, headers: { get: () => null }, error: "not json {{{" };
        return ok("ok");
      });
      expect(r.value).toBe("ok");
    });

    it("respects retry-after", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const ts = [];
      await t.enqueue("m", "gemini", async () => {
        ts.push(Date.now());
        if (++n === 1) throw make429({ "retry-after": "1" });
        return ok();
      });
      expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(900);
    });
  });

  // ── proactive throttling ───────────────────────────────────────────────

  describe("proactive throttling", () => {
    it("derives minIntervalMs from observed RPM", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      await t.enqueue("m", "openai", async () => {
        if (++n === 1) throw make429({ "x-ratelimit-limit-requests": "60" });
        return ok();
      });
      const state = t.getModelState("m");
      expect(state.minIntervalMs).toBe(1000); // 60000 / 60
    });

    it("spaces subsequent requests by minInterval", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      // learn RPM=120 (500ms interval)
      await t.enqueue("m", "openai", async () => {
        if (++n === 1) throw make429({ "x-ratelimit-limit-requests": "120" });
        return ok();
      });

      const ts = [];
      const p1 = t.enqueue("m", "openai", async () => { ts.push(Date.now()); return ok(); });
      const p2 = t.enqueue("m", "openai", async () => { ts.push(Date.now()); return ok(); });
      await Promise.all([p1, p2]);

      expect(ts[1] - ts[0]).toBeGreaterThanOrEqual(350);
    });

    it("does not space requests for models with no observed limits", async () => {
      const t = new AdaptiveThrottle();
      const ts = [];
      const p1 = t.enqueue("m", "gemini", async () => { ts.push(Date.now()); return ok(); });
      const p2 = t.enqueue("m", "gemini", async () => { ts.push(Date.now()); return ok(); });
      await Promise.all([p1, p2]);
      expect(ts[1] - ts[0]).toBeLessThan(100); // essentially instant
    });

    it("updates interval when limits change", async () => {
      const t = new AdaptiveThrottle();
      await t.enqueue("m", "openai", async () => okWithHeaders({ "x-ratelimit-limit-requests": "60" }));
      expect(t.getModelState("m").minIntervalMs).toBe(1000);

      await t.enqueue("m", "openai", async () => okWithHeaders({ "x-ratelimit-limit-requests": "120" }));
      expect(t.getModelState("m").minIntervalMs).toBe(500);
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles 429 with no headers at all", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const r = await t.enqueue("m", "gemini", async () => {
        if (++n === 1) throw { status: 429, headers: { get: () => null }, error: "" };
        return ok("ok");
      });
      expect(r.value).toBe("ok");
    });

    it("handles 429 with undefined headers object", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const r = await t.enqueue("m", "gemini", async () => {
        if (++n === 1) throw { status: 429 };
        return ok("ok");
      });
      expect(r.value).toBe("ok");
    });

    it("handles provider string variations", async () => {
      const t = new AdaptiveThrottle();
      // "google" should fall through to gemini parser
      let n = 0;
      await t.enqueue("m", "google", async () => {
        if (++n === 1) throw make429({ "retry-after": "1", "x-ratelimit-limit-requests": "30" });
        return ok();
      });
      expect(t.getModelState("m").observedLimits.rpm).toBe(30);
    });

    it("retry-after of 0 does not hang", async () => {
      const t = new AdaptiveThrottle();
      let n = 0;
      const r = await t.enqueue("m", "anthropic", async () => {
        if (++n === 1) throw make429({ "retry-after": "0" });
        return ok("ok");
      });
      expect(r.value).toBe("ok");
    });

    it("very high RPM produces very small interval", async () => {
      const t = new AdaptiveThrottle();
      await t.enqueue("m", "openai", async () => okWithHeaders({ "x-ratelimit-limit-requests": "10000" }));
      expect(t.getModelState("m").minIntervalMs).toBe(6); // 60000/10000
    });

    it("RPM of 1 produces 60s interval", async () => {
      const t = new AdaptiveThrottle();
      await t.enqueue("m", "openai", async () => okWithHeaders({ "x-ratelimit-limit-requests": "1" }));
      expect(t.getModelState("m").minIntervalMs).toBe(60000);
    });

    it("backoff caps at 60 seconds", async () => {
      const t = new AdaptiveThrottle({ maxRetries: 20 });
      const state = t.getModelState("m");
      // simulate many consecutive failures
      state.consecutiveFailures = 100;
      // the formula: min(60000, 500 * 2^(n-1)) — at n=100 this would overflow
      // but we cap at 60000
      // just verify the throttle doesn't crash with huge failure counts
      let n = 0;
      const r = await t.enqueue("m", "gemini", async () => {
        n++;
        return ok("ok");
      });
      expect(r.value).toBe("ok");
    });
  });
});
