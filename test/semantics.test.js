import { describe, it, expect } from "vitest";
import { run, compile, stubModel } from "../src/index.js";

/**
 * These tests document exactly how Suede constructs resolve to JavaScript.
 * Each test proves the runtime behavior by inspecting execution order,
 * model call arguments, and output values.
 */

describe("suede → js semantics", () => {

  // ── = (plain assignment) ──────────────────────────────────────────
  // Suede:  let x = expr
  // JS:     scope.set("x", eval(expr))
  // No model call. Free. Deterministic.

  it("= evaluates the expression and binds to scope", async () => {
    const src = `
      pipeline go(a: num, b: num) -> num {
        let sum = a + b
        let doubled = sum * 2
        return doubled
      }`;
    const { value, stats } = await run(src, "go", { a: 3, b: 4 }, stubModel());
    expect(value).toBe(14);         // (3+4)*2
    expect(stats.modelCalls).toBe(0);
    expect(stats.codeSteps).toBe(2); // two = bindings
  });

  // ── ~= (model call) ──────────────────────────────────────────────
  // Suede:  let x ~= extract(input, fields: [name]) with fast
  // JS:     const res = await model({ verb: "extract", input, options: { fields: ["name"] }, model: "gemini-...", modelOpts: { provider: "gemini", temperature: 0.2, ... }, config: { provider: "gemini", ... } })
  //         scope.set("x", res.value)
  //         stats.modelCalls++; stats.inputTokens += res.inputTokens; ...

  it("~= calls the model function with verb, input, options, model config", async () => {
    const src = `
      init {
        model fast = "gemini-3.5-flash" {
          provider = "gemini"
          temperature = 0.2
          max_tokens = 256
        }
      }
      pipeline go(text: text) -> obj {
        let info ~= extract(text, fields: [name, age]) with fast
        return info
      }`;
    const calls = [];
    const model = (call) => {
      calls.push(call);
      return { value: { name: "Alice", age: 30 }, inputTokens: 20, outputTokens: 10 };
    };
    const { value, stats } = await run(src, "go", { text: "Alice is 30" }, model);

    // the model function received a prompt (built by the interpreter), verb, and model config:
    expect(calls).toHaveLength(1);
    expect(calls[0].verb).toBe("extract");
    expect(calls[0].prompt).toContain("name");     // prompt mentions the fields
    expect(calls[0].prompt).toContain("age");
    expect(calls[0].prompt).toContain("Alice is 30"); // prompt contains the input text
    expect(calls[0].model).toBe("gemini-3.5-flash");
    expect(calls[0].modelOpts.temperature).toBe(0.2);
    expect(calls[0].modelOpts.max_tokens).toBe(256);
    expect(calls[0].config.provider).toBe("gemini");

    // the return value is res.value from the model function
    expect(value).toEqual({ name: "Alice", age: 30 });
    expect(stats.modelCalls).toBe(1);
    expect(stats.inputTokens).toBe(20);
    expect(stats.outputTokens).toBe(10);
  });

  // ── parallel ──────────────────────────────────────────────────────
  // Suede:  parallel { let a ~= ...; let b ~= ...; let c ~= ... }
  // JS:     const [a, b, c] = await Promise.all([model(...), model(...), model(...)])
  // All calls start at the same time. Results assigned after all complete.

  it("parallel resolves to Promise.all — calls start concurrently", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        parallel {
          let a ~= compress(text, max: 50)
          let b ~= classify(text, into: [pos, neg])
          let c ~= extract(text, fields: [topic])
        }
        return @Result { a, b, c }
      }`;
    const callOrder = [];
    const resolveOrder = [];
    const results = { compress: { text: "short" }, classify: { label: "pos" }, extract: { topic: "test" } };
    const model = async ({ verb }) => {
      callOrder.push(verb);
      // simulate different latencies — classify is fastest, extract slowest
      const delays = { compress: 30, classify: 10, extract: 50 };
      await new Promise(r => setTimeout(r, delays[verb]));
      resolveOrder.push(verb);
      return { value: results[verb], inputTokens: 5, outputTokens: 3 };
    };
    const { value } = await run(src, "go", { text: "hello" }, model);

    // all three were called (started) before any resolved
    expect(callOrder).toEqual(["compress", "classify", "extract"]);
    // they resolved in latency order, not call order — proving concurrency
    expect(resolveOrder).toEqual(["classify", "compress", "extract"]);
    // all results available after the block
    expect(value.a).toEqual({ text: "short" });
    expect(value.b).toEqual({ label: "pos" });
    expect(value.c).toEqual({ topic: "test" });
  });

  // ── pipe operator |> ──────────────────────────────────────────────
  // Suede:  x |> f(a) |> g(b)
  // JS:     g(f(x, a), b)
  // Left value becomes first argument of right call.

  it("|> injects left as first arg of right call", async () => {
    const src = `
      pipeline go(text: text) -> text {
        let result = text |> after("@") |> before(" ") |> upper()
        return result
      }`;
    const { value } = await run(src, "go", { text: "user@domain.com rest" }, stubModel());
    expect(value).toBe("DOMAIN.COM");
  });

  // ── for / into / emit ────────────────────────────────────────────
  // Suede:  for item in items into results { ... emit value }
  // JS:     const results = []; for (const item of items) { results.push(value); }

  it("for/into/emit collects emitted values into a list", async () => {
    const src = `
      pipeline go(items: list) -> list {
        for item in items into results {
          let upper = item |> upper()
          emit upper
        }
        return results
      }`;
    const { value } = await run(src, "go", { items: ["a", "b", "c"] }, stubModel());
    expect(value).toEqual(["A", "B", "C"]);
  });

  // ── retry ─────────────────────────────────────────────────────────
  // Suede:  let x ~= verb(...) retry 3
  // JS:     for (let attempt = 0; attempt <= 3; attempt++) { try { ... break } catch { if (attempt < 3) continue; throw } }

  it("retry N retries the model call up to N times on failure", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let x ~= compress(text, max: 10) retry 2
        return x
      }`;
    let attempts = 0;
    const model = () => {
      attempts++;
      if (attempts < 3) throw new Error("transient failure");
      return { value: { text: "ok" }, inputTokens: 5, outputTokens: 2 };
    };
    const { value } = await run(src, "go", { text: "hello" }, model);
    expect(value).toEqual({ text: "ok" });
    expect(attempts).toBe(3); // 1 original + 2 retries
  });

  // ── try / catch ───────────────────────────────────────────────────
  // Suede:  try { ... } catch err { ... }
  // JS:     try { ... } catch (e) { scope.set("err", { message: e.message, name: e.name }) }

  it("try/catch catches errors and exposes err.message", async () => {
    const src = `
      pipeline go(text: text) -> text {
        try {
          let x ~= compress(text, max: 10)
          return x
        } catch err {
          return err.message
        }
      }`;
    const model = () => { throw new Error("API rate limited"); };
    const { value } = await run(src, "go", { text: "hi" }, model);
    expect(value).toBe("API rate limited");
  });

  // ── pipeline calls ────────────────────────────────────────────────
  // Suede:  let result = other_pipeline(args)
  // JS:     Looks up pipeline by name in prog.pipelines, calls _runPipeline with args.
  //         Model calls inside the called pipeline still count toward stats.

  it("pipeline calls execute the target pipeline and track stats across calls", async () => {
    const src = `
      pipeline helper(x: text) -> obj {
        let s ~= compress(x, max: 20)
        return s
      }
      pipeline process(text: text) -> text {
        let a = helper(text)
        let b = helper(text)
        return concat(a.text, b.text)
      }`;
    const model = stubModel({ compress: () => ({ text: "short" }) });
    const { value, stats } = await run(src, "process", { text: "hello" }, model);
    expect(value).toBe("shortshort");
    expect(stats.modelCalls).toBe(2); // both helper calls tracked
  });

  // ── recurse ───────────────────────────────────────────────────────
  // Suede:  recurse(new_args)
  // JS:     return _runPipeline(prog, currentPipeline, { param: new_args })
  // Must be inside an if block (parser enforces base case exists).

  it("recurse calls the enclosing pipeline with new args", async () => {
    const src = `
      pipeline sum_list(items: list) -> num {
        if len(items) <= 1 {
          return first(items)
        } else {
          let head = first(items)
          let rest = slice(items, 1, len(items))
          let rest_sum = recurse(rest)
          return head + rest_sum
        }
      }`;
    const { value } = await run(src, "sum_list", { items: [1, 2, 3, 4] }, stubModel());
    expect(value).toBe(10);
  });

  // ── agent / loop / use ────────────────────────────────────────────
  // Suede:  agent name(...) -> Type max N { tools { ... } loop { ... } }
  // JS:     for (let i = 0; i < N; i++) { exec(loopBody); if (returned) break; }
  //         use("tool", args) calls hostTools["tool"](args)
  //         Throws if max iterations hit without return.

  it("agent loops until return, use() dispatches to functions/pipelines", async () => {
    const src = `
      type Answer {
        result: text
      }
      function search(q: text) -> text {
        return concat("answer: ", q)
      }
      agent finder(query: text) -> Answer max 5 {
        tools { search(q: text) -> text }
        loop {
          let result = use("search", query)
          let done ~= classify(result, into: [found, not_found])
          if done.label == "found" {
            return @Answer { result }
          }
        }
      }`;
    let callCount = 0;
    const model = stubModel({ classify: () => { callCount++; return callCount >= 2 ? { label: "found" } : { label: "not_found" }; } });
    const { value, stats } = await run(src, "finder", { query: "42" }, model);
    expect(value.result).toBe("answer: 42");
    expect(stats.toolCalls).toBe(2);
    expect(stats.agentIterations).toBe(2);
  });

  // ── cache ─────────────────────────────────────────────────────────
  // Suede:  let x ~= verb(...) cache
  // JS:     key = hash(verb, input, options, modelId)
  //         if (cache.has(key)) return cache.get(key)
  //         else { result = await model(...); cache.set(key, result) }

  it("cache prevents duplicate model calls for same inputs", async () => {
    const src = `
      init {
        cache { enabled = true  ttl = 60 }
      }
      pipeline go(text: text) -> obj {
        let a ~= compress(text, max: 50) cache
        let b ~= compress(text, max: 50) cache
        let c ~= compress(text, max: 50) cache
        return @Result { a, b, c }
      }`;
    let modelCalls = 0;
    const model = () => { modelCalls++; return { value: { text: "cached" }, inputTokens: 5, outputTokens: 2 }; };
    const { value, stats } = await run(src, "go", { text: "hello" }, model);
    expect(modelCalls).toBe(1);       // model called only once
    expect(stats.cacheHits).toBe(2);  // two cache hits
    expect(value).toEqual({ a: { text: "cached" }, b: { text: "cached" }, c: { text: "cached" } });
  });

  // ── expect (schema validation) ────────────────────────────────────
  // Suede:  let x ~= extract(...) expect { name: text, age: num }
  // JS:     if (typeof result.name !== "string") throw
  //         if (typeof result.age !== "number") throw

  it("expect validates output shape — passes on correct types", async () => {
    const src =
      'pipeline go(text: text) -> obj {\n' +
      '  let info ~= extract(text, fields: [name, age])\n' +
      '    expect { name: text, age: num }\n' +
      '  return info\n' +
      '}';
    const model = stubModel({ extract: () => ({ name: "Alice", age: 30 }) });
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value).toEqual({ name: "Alice", age: 30 });
  });

  it("expect throws on wrong type", async () => {
    const src =
      'pipeline go(text: text) -> obj {\n' +
      '  let info ~= extract(text, fields: [name, age])\n' +
      '    expect { name: text, age: num }\n' +
      '  return info\n' +
      '}';
    const model = stubModel({ extract: () => ({ name: "Alice", age: "thirty" }) }); // age is string not num
    await expect(run(src, "go", { text: "test" }, model)).rejects.toThrow(/age.*expected type.*num/);
  });

  it("expect throws on missing field", async () => {
    const src =
      'pipeline go(text: text) -> obj {\n' +
      '  let info ~= extract(text, fields: [name, age])\n' +
      '    expect { name: text, age: num }\n' +
      '  return info\n' +
      '}';
    const model = stubModel({ extract: () => ({ name: "Alice" }) }); // missing age
    await expect(run(src, "go", { text: "test" }, model)).rejects.toThrow(/missing.*age/);
  });

  // ── budget ────────────────────────────────────────────────────────
  // Suede:  init { budget { max_tokens = 100  on_exceed = "stop" } }
  // JS:     Before each _evalFuzzy: if (stats.inputTokens + stats.outputTokens >= max) throw BudgetExceeded

  it("budget throws when token limit exceeded", async () => {
    const src = `
      init { budget { max_tokens = 30  on_exceed = "stop" } }
      pipeline go(text: text) -> text {
        let a ~= compress(text, max: 50)
        let b ~= compress(text, max: 50)
        return b
      }`;
    const model = () => ({ value: { text: "x" }, inputTokens: 15, outputTokens: 10 });
    // first call: 25 tokens. second call: budget check sees 25 >= 30? no. call happens, now 50.
    // actually: first call uses 25, then budget check before second sees 25 < 30, so second runs too.
    // let me use a tighter budget:
    const src2 = `
      init { budget { max_tokens = 20  on_exceed = "stop" } }
      pipeline go(text: text) -> text {
        let a ~= compress(text, max: 50)
        let b ~= compress(text, max: 50)
        return b
      }`;
    await expect(run(src2, "go", { text: "hi" }, model)).rejects.toThrow(/budget exceeded/);
  });

  // ── string interpolation ──────────────────────────────────────────
  // Suede:  "Hello ${name}, your ${obj.field}"
  // JS:     "Hello " + scope.get("name") + ", your " + scope.get("obj").field

  it("string interpolation resolves variables and member access", async () => {
    const src =
      'pipeline go(user: obj) -> text {\n' +
      '  let msg = "Hi ${user.name}, age ${user.age}"\n' +
      '  return msg\n' +
      '}';
    const { value } = await run(src, "go", { user: { name: "Bob", age: 25 } }, stubModel());
    expect(value).toBe("Hi Bob, age 25");
  });

  // ── record literals ───────────────────────────────────────────────
  // Suede:  @Name { field: expr, shorthand }
  // JS:     { field: eval(expr), shorthand: scope.get("shorthand") }

  it("record literals create objects with field shorthand", async () => {
    const src = `
      pipeline go(x: num) -> obj {
        let name = "test"
        let score = x * 10
        return @Result { name, score, extra: "yes" }
      }`;
    const { value } = await run(src, "go", { x: 5 }, stubModel());
    expect(value).toEqual({ name: "test", score: 50, extra: "yes" });
  });
});
