import { describe, it, expect } from "vitest";
import { run, compile, stubModel, asJson } from "../src/index.js";

describe("suede language", () => {
  it("runs a linear pipeline and meters model vs code", async () => {
    const src = `
      type Lead {
        domain: text
        details: obj
        note: obj
      }
      pipeline triage(raw: text) -> Lead {
        let domain = raw |> after("@") |> before(" ")
        let details ~= extract(raw, fields: [name, company])
        let note ~= compress(raw, max: 60)
        return @Lead { domain, details, note }
      }`;
    const model = stubModel({
      extract: () => ({ name: "Maria", company: "Westfield" }),
      compress: () => ({ text: "short note" }),
    });
    const { value, stats } = await run(src, "triage", { raw: "hi@westfield.edu now" }, model);
    expect(value.domain).toBe("westfield.edu");
    expect(value.details.name).toBe("Maria");
    expect(stats.modelCalls).toBe(2);
    expect(stats.codeSteps).toBe(1);
    expect(stats.inputTokens).toBeGreaterThan(0);
  });

  it("branches without spending a model call on the if", async () => {
    const src = `
      pipeline route(budget: num) -> text {
        if budget > 15000 {
          let tier = "hot"
          return tier
        } else {
          let tier = "cold"
          return tier
        }
      }`;
    const hot = await run(src, "route", { budget: 20000 }, stubModel());
    const cold = await run(src, "route", { budget: 5000 }, stubModel());
    expect(hot.value).toBe("hot");
    expect(cold.value).toBe("cold");
    expect(hot.stats.modelCalls).toBe(0);
  });

  it("loops and accumulates model calls per iteration", async () => {
    const src = `
      pipeline summarize_all(items: list) -> num {
        for it in items {
          let s ~= compress(it, max: 20)
        }
        return 0
      }`;
    const { stats } = await run(src, "summarize_all", { items: ["a", "b", "c"] }, stubModel());
    expect(stats.modelCalls).toBe(3);
  });

  it("rejects calling a model verb with plain '='", async () => {
    const src = `
      pipeline bad(raw: text) -> text {
        let x = extract(raw)
        return x
      }`;
    await expect(run(src, "bad", { raw: "x" }, stubModel())).rejects.toThrow(/model verb/);
  });

  it("rejects '~=' on a non-model function", async () => {
    const src = `
      pipeline bad(raw: text) -> text {
        let x ~= after(raw, "@")
        return x
      }`;
    await expect(run(src, "bad", { raw: "a@b" }, stubModel())).rejects.toThrow(/not a model verb/);
  });

  it("reports parse errors with line numbers", () => {
    expect(() => compile(`pipeline oops( {`)).toThrow(/line/);
  });

  it("parses init block and passes model alias via 'with'", async () => {
    const src = `
      init {
        model fast = "claude-haiku-4-5-20251001" {
          provider = "anthropic"
          temperature = 0.2
          max_tokens = 256
        }
        model smart = "claude-sonnet-4-6" {
          provider = "anthropic"
          temperature = 0.7
          max_tokens = 4096
        }
      }
      pipeline go(raw: text) -> obj {
        let x ~= compress(raw, max: 20) with fast
        let y ~= extract(raw, fields: [name]) with smart
        return x
      }`;
    const calls = [];
    const model = ({ verb, input, options, model: modelId, modelOpts }) => {
      calls.push({ verb, modelId, modelOpts });
      const values = { compress: { text: "short" }, extract: { name: "test" } };
      return { value: values[verb] || { text: "ok" }, inputTokens: 10, outputTokens: 5 };
    };
    const { stats } = await run(src, "go", { raw: "test" }, model);
    expect(stats.modelCalls).toBe(2);
    expect(calls[0].modelId).toBe("claude-haiku-4-5-20251001");
    expect(calls[0].modelOpts.temperature).toBe(0.2);
    expect(calls[0].modelOpts.max_tokens).toBe(256);
    expect(calls[1].modelId).toBe("claude-sonnet-4-6");
    expect(calls[1].modelOpts.temperature).toBe(0.7);
    expect(calls[1].modelOpts.max_tokens).toBe(4096);
    expect(stats.trace[0].model).toBe("fast");
    expect(stats.trace[1].model).toBe("smart");
  });

  it("supports recurse with base case check", async () => {
    const src = `
      pipeline shrink(items: list) -> text {
        if len(items) <= 1 {
          return items |> join(", ")
        } else {
          let half = len(items) / 2
          let left = slice(items, 0, half)
          let right = slice(items, half, len(items))
          let a = recurse(left)
          let b = recurse(right)
          return a
        }
      }`;
    const { value } = await run(src, "shrink", { items: ["a", "b", "c", "d"] }, stubModel());
    expect(value).toBe("a");  // recurses down to single items
  });

  it("runs par block concurrently", async () => {
    const src = `
      type Result {
        summary: obj
        mood: obj
        info: obj
      }
      pipeline analyze(text: text) -> Result {
        parallel {
          let summary ~= compress(text, max: 50)
          let mood ~= classify(text, into: [happy, sad])
          let info ~= extract(text, fields: [topic])
        }
        return @Result { summary, mood, info }
      }`;
    const order = [];
    const model = async ({ verb }) => {
      order.push(verb);
      const results = { compress: { text: "short" }, classify: { label: "happy" }, extract: { topic: "test" } };
      return { value: results[verb], inputTokens: 5, outputTokens: 3 };
    };
    const { value, stats } = await run(src, "analyze", { text: "hello" }, model);
    expect(value.summary).toEqual({ text: "short" });
    expect(value.mood).toEqual({ label: "happy" });
    expect(value.info).toEqual({ topic: "test" });
    expect(stats.modelCalls).toBe(3);
  });

  it("retries model calls on failure", async () => {
    const src = `
      pipeline go(raw: text) -> obj {
        let x ~= compress(raw, max: 20) retry 2
        return x
      }`;
    let callCount = 0;
    const model = ({ verb }) => {
      callCount++;
      if (callCount < 3) throw new Error("API error");
      return { value: { text: "ok" }, inputTokens: 5, outputTokens: 2 };
    };
    const { value } = await run(src, "go", { raw: "test" }, model);
    expect(value).toEqual({ text: "ok" });
    expect(callCount).toBe(3); // 1 original + 2 retries
  });

  it("supports null values and default()", async () => {
    const src = `
      pipeline go(x: num) -> num {
        let y = null
        let z = default(y, 42)
        return z
      }`;
    const { value } = await run(src, "go", { x: 1 }, stubModel());
    expect(value).toBe(42);
  });

  it("supports log statements", async () => {
    const src = `
      pipeline go(x: num) -> num {
        log x
        return x * 2
      }`;
    const steps = [];
    const { value } = await run(src, "go", { x: 5 }, stubModel(), (s) => steps.push(s));
    expect(value).toBe(10);
    expect(steps.some(s => s.type === "log" && s.value === 5)).toBe(true);
  });

  it("supports string builtins split/replace/starts_with", async () => {
    const src = `
      pipeline go(s: text) -> list {
        let parts = split(s, ",")
        return parts
      }`;
    const { value } = await run(src, "go", { s: "a,b,c" }, stubModel());
    expect(value).toEqual(["a", "b", "c"]);
  });

  it("supports list builtins unique/sort/reverse/first/last", async () => {
    const src = `
      pipeline go(items: list) -> text {
        let u = items |> unique() |> sort()
        let f = first(u)
        let l = last(u)
        return concat(f, l)
      }`;
    const { value } = await run(src, "go", { items: ["c", "a", "b", "a"] }, stubModel());
    expect(value).toBe("ac");
  });

  it("supports and/or/not operators", async () => {
    const src = `
      pipeline logic(a: num, b: num) -> text {
        if a > 5 and b > 5 {
          return "both"
        } else if a > 5 or b > 5 {
          return "one"
        } else {
          return "neither"
        }
      }`;
    expect((await run(src, "logic", { a: 10, b: 10 }, stubModel())).value).toBe("both");
    expect((await run(src, "logic", { a: 10, b: 1 }, stubModel())).value).toBe("one");
    expect((await run(src, "logic", { a: 1, b: 1 }, stubModel())).value).toBe("neither");
  });

  it("supports not operator", async () => {
    const src = `
      pipeline go(flag: bool) -> text {
        if not flag {
          return "negated"
        } else {
          return "original"
        }
      }`;
    expect((await run(src, "go", { flag: false }, stubModel())).value).toBe("negated");
    expect((await run(src, "go", { flag: true }, stubModel())).value).toBe("original");
  });

  it("supports try/catch for error handling", async () => {
    const src = `
      pipeline go(raw: text) -> text {
        try {
          let x ~= compress(raw, max: 20)
          return x
        } catch err {
          return err.message
        }
      }`;
    const model = () => { throw new Error("API down"); };
    const { value } = await run(src, "go", { raw: "test" }, model);
    expect(value).toBe("API down");
  });

  it("supports unary minus", async () => {
    const src = `
      pipeline go(x: num) -> num {
        let y = -x
        let z = y + -3
        return z
      }`;
    const { value } = await run(src, "go", { x: 5 }, stubModel());
    expect(value).toBe(-8);
  });

  it("rejects recurse outside an if block", () => {
    const src = `
      pipeline bad(x: num) -> num {
        let y = recurse(x)
        return y
      }`;
    expect(() => compile(src)).toThrow(/base case/);
  });

  it("calls one pipeline from another", async () => {
    const src = `
      pipeline summarize(text: text) -> obj {
        let s ~= compress(text, max: 50)
        return s
      }
      pipeline process(items: list) -> list {
        for item in items into results {
          let s = summarize(item)
          emit s
        }
        return results
      }`;
    const model = stubModel({ compress: (input) => ({ text: `short: ${String(input).slice(0, 10)}` }) });
    const { value, stats } = await run(src, "process", { items: ["hello world", "foo bar"] }, model);
    expect(value).toHaveLength(2);
    expect(stats.modelCalls).toBe(2);
  });

  it("for/into/emit collects values", async () => {
    const src = `
      pipeline double(nums: list) -> list {
        for n in nums into doubled {
          emit n * 2
        }
        return doubled
      }`;
    const { value } = await run(src, "double", { nums: [1, 2, 3] }, stubModel());
    expect(value).toEqual([2, 4, 6]);
  });

  it("interpolates strings with ${}", async () => {
    const src =
      'pipeline greet(name: text, title: text) -> text {\n' +
      '  let msg = "Hello ${name}, you are a ${title}"\n' +
      '  return msg\n' +
      '}';
    const { value } = await run(src, "greet", { name: "Alice", title: "engineer" }, stubModel());
    expect(value).toBe("Hello Alice, you are a engineer");
  });

  it("interpolates member access in strings", async () => {
    const src =
      'pipeline show(person: obj) -> text {\n' +
      '  let msg = "Name: ${person.name}, Age: ${person.age}"\n' +
      '  return msg\n' +
      '}';
    const { value } = await run(src, "show", { person: { name: "Bob", age: 30 } }, stubModel());
    expect(value).toBe("Name: Bob, Age: 30");
  });

  it("rejects recurse with wrong arg count", () => {
    const src = `
      pipeline bad(x: num, y: num) -> num {
        if x > 0 {
          return x
        } else {
          let z = recurse(x)
          return z
        }
      }`;
    expect(() => compile(src)).toThrow(/expects 2/);
  });

  // ── Agent tests ────────────────────────────────────────────────────
  it("runs an agent with tools and loop", async () => {
    const src = `
      type Answer {
        result: text
      }
      function lookup(query: text) -> text {
        return concat("found: ", query)
      }
      agent solver(question: text) -> Answer max 5 {
        tools { lookup(query: text) -> text }
        loop {
          let plan ~= generate(question, format: [thought, action])
          let result = use("lookup", question)
          let done ~= classify(result, into: [solved, unsolved])
          if done.label == "solved" {
            return @Answer { result }
          }
        }
      }`;
    const model = stubModel({
      generate: () => ({ thought: "let me look", action: "lookup" }),
      classify: () => ({ label: "solved" }),
    });
    const { value, stats } = await run(src, "solver", { question: "42" }, model);
    expect(value.result).toBe("found: 42");
    expect(stats.toolCalls).toBe(1);
    expect(stats.agentIterations).toBe(1);
    expect(stats.modelCalls).toBe(2);
  });

  it("agent hits max iterations", async () => {
    const src = `
      agent looper(x: text) -> text max 3 {
        loop {
          let s ~= compress(x, max: 10)
          log s
        }
      }`;
    await expect(run(src, "looper", { x: "hi" }, stubModel())).rejects.toThrow(/max iterations/);
  });

  // ── Cache tests ────────────────────────────────────────────────────
  it("caches model calls with cache keyword", async () => {
    const src = `
      init {
        cache {
          enabled = true
          ttl = 60
        }
      }
      pipeline go(text: text) -> text {
        let a ~= compress(text, max: 50) cache
        let b ~= compress(text, max: 50) cache
        return concat(a.text, b.text)
      }`;
    let callCount = 0;
    const model = ({ verb }) => { callCount++; return { value: { text: "short" }, inputTokens: 5, outputTokens: 2 }; };
    const { value, stats } = await run(src, "go", { text: "hello" }, model);
    expect(callCount).toBe(1); // second call hits cache
    expect(stats.cacheHits).toBe(1);
    expect(value).toBe("shortshort");
  });

  // ── Expect (schema validation) tests ───────────────────────────────
  it("validates model output with expect", async () => {
    const src =
      'pipeline go(raw: text) -> obj {\n' +
      '  let info ~= extract(raw, fields: [name, age])\n' +
      '    expect { name: text, age: num }\n' +
      '  return info\n' +
      '}';
    const good = stubModel({ extract: () => ({ name: "Alice", age: 30 }) });
    const { value } = await run(src, "go", { raw: "test" }, good);
    expect(value.name).toBe("Alice");

    const bad = stubModel({ extract: () => ({ name: "Alice" }) }); // missing age
    await expect(run(src, "go", { raw: "test" }, bad)).rejects.toThrow(/missing.*age/);
  });

  // ── Budget tests ───────────────────────────────────────────────────
  it("enforces token budget", async () => {
    const src = `
      init {
        budget {
          max_tokens = 20
          on_exceed = "stop"
        }
      }
      pipeline go(text: text) -> text {
        let a ~= compress(text, max: 50)
        let b ~= compress(text, max: 50)
        let c ~= compress(text, max: 50)
        return c
      }`;
    const model = () => ({ value: { text: "x" }, inputTokens: 10, outputTokens: 5 });
    await expect(run(src, "go", { text: "hi" }, model)).rejects.toThrow(/budget exceeded/);
  });

  // ── Embed (RAG) tests ──────────────────────────────────────────────
  // ── custom prompt tests ───────────────────────────────────────────
  it("custom prompt sends the template to the model", async () => {
    const src =
      'prompt score(text: text, criteria: list) -> num {\n' +
      '  "Rate this text 1-10 based on: ${criteria}. Text: ${text}. Return ONLY the number."\n' +
      '}\n' +
      'pipeline go(doc: text) -> num {\n' +
      '  let s ~= score(doc, criteria: [clarity, grammar])\n' +
      '  return s\n' +
      '}';
    const calls = [];
    const model = ({ prompt, verb }) => {
      calls.push({ prompt, verb });
      return { value: "8", inputTokens: 20, outputTokens: 2 };
    };
    const { value } = await run(src, "go", { doc: "hello world" }, model);
    expect(value).toBe(8);
    expect(calls[0].verb).toBe("score");
    expect(calls[0].prompt).toContain("clarity");
    expect(calls[0].prompt).toContain("hello world");
  });

  it("custom prompt with -> obj parses JSON response", async () => {
    const src =
      'prompt analyze(text: text) -> obj {\n' +
      '  "Analyze: ${text}. Return JSON with mood and confidence."\n' +
      '}\n' +
      'pipeline go(text: text) -> obj {\n' +
      '  let result ~= analyze(text)\n' +
      '  return result\n' +
      '}';
    const model = () => ({ value: '{"mood":"happy","confidence":0.9}', inputTokens: 10, outputTokens: 10 });
    const { value } = await run(src, "go", { text: "great day" }, model);
    expect(value.mood).toBe("happy");
    expect(value.confidence).toBe(0.9);
  });

  it("custom prompt requires ~= not =", async () => {
    const src =
      'prompt greet(name: text) -> text { "Hello ${name}" }\n' +
      'pipeline go(name: text) -> text {\n' +
      '  let x = greet(name)\n' +
      '  return x\n' +
      '}';
    await expect(run(src, "go", { name: "Bob" }, stubModel())).rejects.toThrow(/model verb/);
  });

  it("custom prompt -> num handles messy model output", async () => {
    const src =
      'prompt score(text: text) -> num {\n' +
      '  "Rate 1-10: ${text}"\n' +
      '}\n' +
      'pipeline go(text: text) -> num {\n' +
      '  let s ~= score(text)\n' +
      '  return s\n' +
      '}';
    // model returns "The score is 7 out of 10"
    const model = () => ({ value: "The score is 7 out of 10", inputTokens: 10, outputTokens: 5 });
    const { value } = await run(src, "go", { text: "hello" }, model);
    expect(value).toBe(7);
  });

  it("custom prompt -> bool handles bare true/false", async () => {
    const src =
      'prompt is_spam(text: text) -> bool {\n' +
      '  "Is this spam? ${text}"\n' +
      '}\n' +
      'pipeline go(text: text) -> bool {\n' +
      '  let s ~= is_spam(text)\n' +
      '  return s\n' +
      '}';
    const model = () => ({ value: "Yes, this is True.", inputTokens: 10, outputTokens: 5 });
    const { value } = await run(src, "go", { text: "buy now" }, model);
    expect(value).toBe(true);
  });

  it("custom prompt -> num throws on no number found", async () => {
    const src =
      'prompt score(text: text) -> num {\n' +
      '  "Rate: ${text}"\n' +
      '}\n' +
      'pipeline go(text: text) -> num {\n' +
      '  let s ~= score(text)\n' +
      '  return s\n' +
      '}';
    const model = () => ({ value: "I cannot rate this", inputTokens: 10, outputTokens: 5 });
    await expect(run(src, "go", { text: "hello" }, model)).rejects.toThrow(/expected num/);
  });

  // ── custom function tests ─────────────────────────────────────────
  it("custom function is callable with =", async () => {
    const src = `
      function clean(text: text) -> text {
        let result = text |> trim() |> lower()
        return result
      }
      pipeline go(doc: text) -> text {
        let cleaned = clean(doc)
        return cleaned
      }`;
    const { value } = await run(src, "go", { doc: "  HELLO  " }, stubModel());
    expect(value).toBe("hello");
  });

  it("custom function with logic", async () => {
    const src = `
      function grade(score: num) -> text {
        if score >= 90 {
          return "A"
        } else if score >= 80 {
          return "B"
        } else {
          return "C"
        }
      }
      pipeline go(score: num) -> text {
        let g = grade(score)
        return g
      }`;
    expect((await run(src, "go", { score: 95 }, stubModel())).value).toBe("A");
    expect((await run(src, "go", { score: 85 }, stubModel())).value).toBe("B");
    expect((await run(src, "go", { score: 70 }, stubModel())).value).toBe("C");
  });

  // ── Precedence fix: and binds tighter than or ─────────────────────
  it("and binds tighter than or (a or b and c = a or (b and c))", async () => {
    const src = `
      pipeline go(a: bool, b: bool, c: bool) -> bool {
        let result = a or b and c
        return result
      }`;
    // true or false and false => true or (false and false) => true
    expect((await run(src, "go", { a: true, b: false, c: false }, stubModel())).value).toBe(true);
    // false or true and true => false or (true and true) => true
    expect((await run(src, "go", { a: false, b: true, c: true }, stubModel())).value).toBe(true);
    // false or true and false => false or (true and false) => false
    expect((await run(src, "go", { a: false, b: true, c: false }, stubModel())).value).toBe(false);
  });

  // ── Agent with typed tool signatures ──────────────────────────────
  it("parses agent with typed tool signatures", async () => {
    const src = `
      type Answer {
        result: text
      }
      function search_kb(query: text) -> text {
        return concat("result: ", query)
      }
      function escalate(reason: text) -> bool {
        return true
      }
      agent helper(ticket: text) -> Answer max 3 {
        tools {
          search_kb(query: text) -> text
          escalate(reason: text) -> bool
        }
        loop {
          let result = use("search_kb", ticket)
          let done ~= classify(result, into: [resolved, stuck])
          if done.label == "resolved" {
            return @Answer { result }
          }
        }
      }`;
    const model = stubModel({ classify: () => ({ label: "resolved" }) });
    const { value } = await run(src, "helper", { ticket: "help" }, model);
    expect(value.result).toBe("result: help");
  });

  // ── Host-provided tools ───────────────────────────────────────────
  it("agent can use host-provided tools", async () => {
    const src = `
      type Answer {
        result: text
      }
      agent finder(query: text) -> Answer max 3 {
        tools { web_search(query: text) -> text }
        loop {
          let result = use("web_search", query)
          let done ~= classify(result, into: [found, not_found])
          if done.label == "found" {
            return @Answer { result }
          }
        }
      }`;
    const model = stubModel({ classify: () => ({ label: "found" }) });
    const { value } = await run(src, "finder", { query: "test" }, model, null, {
      tools: { web_search: async (q) => `results for: ${q}` },
    });
    expect(value.result).toBe("results for: test");
  });

  // ── Error on undefined model alias ────────────────────────────────
  it("errors on undefined model alias in 'with'", async () => {
    const src = `
      init {
        model fast = "test-model" { max_tokens = 100 }
      }
      pipeline go(text: text) -> text {
        let x ~= compress(text, max: 20) with nonexistent
        return x
      }`;
    await expect(run(src, "go", { text: "hi" }, stubModel())).rejects.toThrow(/nonexistent.*not defined/);
  });

  it("error on undefined model alias lists available models", async () => {
    const src = `
      init {
        model fast = "test-fast" { max_tokens = 100 }
        model smart = "test-smart" { max_tokens = 4096 }
      }
      pipeline go(text: text) -> text {
        let x ~= compress(text, max: 20) with oops
        return x
      }`;
    await expect(run(src, "go", { text: "hi" }, stubModel())).rejects.toThrow(/available: fast, smart/);
  });

  // ── Agent memory ──────────────────────────────────────────────────
  it("agent memory persists across loop iterations", async () => {
    const src = `
      agent counter(goal: num) -> obj max 10 {
        memory {
          count: num = 0
          log_str: text = ""
        }
        loop {
          let count = count + 1
          let log_str = concat(log_str, to_text(count))
          if count >= goal {
            return @Result { count, log_str }
          }
        }
      }`;
    const { value, stats } = await run(src, "counter", { goal: 3 }, stubModel());
    expect(value.count).toBe(3);
    expect(value.log_str).toBe("123");
    expect(stats.agentIterations).toBe(3);
  });

  it("agent memory initializes with defaults each run", async () => {
    const src = `
      agent ticker(n: num) -> num max 10 {
        memory {
          total: num = 0
        }
        loop {
          let total = total + n
          if total >= 10 {
            return total
          }
        }
      }`;
    const { value } = await run(src, "ticker", { n: 4 }, stubModel());
    expect(value).toBe(12); // 4, 8, 12
  });

  // ── System prompts ────────────────────────────────────────────────
  it("init-level system prompt is passed to model function", async () => {
    const src = `
      init {
        system = "You are a strict JSON parser"
      }
      pipeline go(text: text) -> obj {
        let x ~= compress(text, max: 20)
        return x
      }`;
    const calls = [];
    const model = (call) => {
      calls.push(call);
      return { value: { text: "short" }, inputTokens: 5, outputTokens: 2 };
    };
    await run(src, "go", { text: "hello" }, model);
    expect(calls[0].systemPrompt).toBe("You are a strict JSON parser");
  });

  it("per-call system prompt overrides init-level", async () => {
    const src =
      'init {\n' +
      '  system = "default system"\n' +
      '}\n' +
      'pipeline go(text: text) -> text {\n' +
      '  let a ~= compress(text, max: 20)\n' +
      '  let b ~= compress(text, max: 20) system "custom system"\n' +
      '  return concat(a.text, b.text)\n' +
      '}';
    const calls = [];
    const model = (call) => {
      calls.push(call);
      return { value: { text: "x" }, inputTokens: 5, outputTokens: 2 };
    };
    await run(src, "go", { text: "hi" }, model);
    expect(calls[0].systemPrompt).toBe("default system");
    expect(calls[1].systemPrompt).toBe("custom system");
  });

  it("system prompt works without init block", async () => {
    const src =
      'pipeline go(text: text) -> obj {\n' +
      '  let x ~= compress(text, max: 20) system "be brief"\n' +
      '  return x\n' +
      '}';
    const calls = [];
    const model = (call) => {
      calls.push(call);
      return { value: { text: "short" }, inputTokens: 5, outputTokens: 2 };
    };
    await run(src, "go", { text: "hello" }, model);
    expect(calls[0].systemPrompt).toBe("be brief");
  });

  // ── Guard modifier ────────────────────────────────────────────────
  it("guard passes when condition is true", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let info ~= extract(text, fields: [name])
          guard { has(info, "name") }
        return info
      }`;
    const model = stubModel({ extract: () => ({ name: "Alice" }) });
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value.name).toBe("Alice");
  });

  it("guard retries on failure then succeeds", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let info ~= extract(text, fields: [name]) retry 2
          guard { has(info, "name") and info.name != "" }
        return info
      }`;
    let callCount = 0;
    const model = ({ verb }) => {
      callCount++;
      const value = callCount < 2 ? { name: "" } : { name: "Alice" };
      return { value, inputTokens: 5, outputTokens: 5 };
    };
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value.name).toBe("Alice");
    expect(callCount).toBe(2);
  });

  it("guard throws when retries exhausted", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let info ~= extract(text, fields: [name]) retry 1
          guard { info.name != "INVALID" }
        return info
      }`;
    const model = () => ({ value: { name: "INVALID" }, inputTokens: 5, outputTokens: 5 });
    await expect(run(src, "go", { text: "test" }, model)).rejects.toThrow(/guard failed/);
  });

  it("guard works with expect (expect runs first)", async () => {
    const src =
      'pipeline go(text: text) -> obj {\n' +
      '  let info ~= extract(text, fields: [name, score]) retry 1\n' +
      '    expect { name: text, score: num }\n' +
      '    guard { info.score > 5 }\n' +
      '  return info\n' +
      '}';
    let callCount = 0;
    const model = () => {
      callCount++;
      return { value: { name: "A", score: callCount < 2 ? 3 : 8 }, inputTokens: 5, outputTokens: 5 };
    };
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value.score).toBe(8);
  });

  // ── Verb contract enforcement ─────────────────────────────────────
  it("extract auto-validates: missing fields trigger retry", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let info ~= extract(text, fields: [name, email]) retry 2
        return info
      }`;
    let callCount = 0;
    const model = () => {
      callCount++;
      // first call missing email, second has it
      const value = callCount < 2 ? { name: "Alice" } : { name: "Alice", email: "a@b.com" };
      return { value, inputTokens: 5, outputTokens: 5 };
    };
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value.email).toBe("a@b.com");
    expect(callCount).toBe(2);
  });

  it("classify auto-validates: invalid label triggers retry", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let mood ~= classify(text, into: [happy, sad, neutral]) retry 2
        return mood
      }`;
    let callCount = 0;
    const model = () => {
      callCount++;
      const value = callCount < 2 ? { label: "confused" } : { label: "happy" };
      return { value, inputTokens: 5, outputTokens: 2 };
    };
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value).toEqual({ label: "happy" });
    expect(callCount).toBe(2);
  });

  it("classify without retry throws on invalid label", async () => {
    const src = `
      pipeline go(text: text) -> text {
        let mood ~= classify(text, into: [happy, sad])
        return mood
      }`;
    const model = () => ({ value: { label: "confused" }, inputTokens: 5, outputTokens: 2 });
    await expect(run(src, "go", { text: "test" }, model)).rejects.toThrow(/classify.*confused.*happy, sad/);
  });

  it("generate auto-validates: missing format fields trigger retry", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let result ~= generate(text, format: [greeting, body]) retry 1
        return result
      }`;
    let callCount = 0;
    const model = () => {
      callCount++;
      const value = callCount < 2
        ? { greeting: "hi" }
        : { greeting: "hi", body: "content" };
      return { value, inputTokens: 5, outputTokens: 5 };
    };
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value.body).toBe("content");
    expect(callCount).toBe(2);
  });
});

describe("asJson", () => {
  it("passes through valid JSON", () => {
    expect(asJson('{"name":"Alice"}')).toEqual({ name: "Alice" });
  });

  it("passes through objects", () => {
    expect(asJson({ a: 1 })).toEqual({ a: 1 });
  });

  it("strips markdown code fences", () => {
    expect(asJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips preamble text before JSON", () => {
    expect(asJson('Here is the result:\n{"name":"Bob"}')).toEqual({ name: "Bob" });
  });

  it("strips trailing text after JSON", () => {
    expect(asJson('{"x":1}\nLet me know if you need more.')).toEqual({ x: 1 });
  });

  it("fixes trailing commas", () => {
    expect(asJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it("fixes unquoted keys", () => {
    expect(asJson('{name:"Alice",age:30}')).toEqual({ name: "Alice", age: 30 });
  });

  it("fixes single-quoted values", () => {
    expect(asJson("{\"name\":'Alice'}")).toEqual({ name: "Alice" });
  });

  it("handles arrays", () => {
    expect(asJson('```json\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it("strips control characters", () => {
    expect(asJson('{"a":\x01"hello"\x00}')).toEqual({ a: "hello" });
  });

  it("throws on unparseable input", () => {
    expect(() => asJson("just some random text")).toThrow(/could not parse/);
  });

  it("extract verb uses asJson on messy model output", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        let info ~= extract(text, fields: [name, email])
        return info
      }`;
    const model = () => ({
      value: '```json\n{"name": "Alice", "email": "a@b.com",}\n```\nHope this helps!',
      inputTokens: 10, outputTokens: 10,
    });
    const { value } = await run(src, "go", { text: "test" }, model);
    expect(value.name).toBe("Alice");
    expect(value.email).toBe("a@b.com");
  });

  // ── match statement ────────────────────────────────────────────────
  it("match dispatches to the correct case", async () => {
    const src = `
      pipeline route(action: text) -> text {
        match action {
          case "search" { return "searched" }
          case "escalate" { return "escalated" }
          else { return "unknown" }
        }
      }`;
    const r1 = await run(src, "route", { action: "search" }, stubModel());
    expect(r1.value).toBe("searched");
    const r2 = await run(src, "route", { action: "escalate" }, stubModel());
    expect(r2.value).toBe("escalated");
    const r3 = await run(src, "route", { action: "nope" }, stubModel());
    expect(r3.value).toBe("unknown");
  });

  it("match with no else and no hit falls through", async () => {
    const src = `
      pipeline route(x: text) -> text {
        match x {
          case "a" { return "found" }
        }
        return "miss"
      }`;
    const { value } = await run(src, "route", { x: "b" }, stubModel());
    expect(value).toBe("miss");
  });

  it("match works with numbers", async () => {
    const src = `
      pipeline check(n: num) -> text {
        match n {
          case 1 { return "one" }
          case 2 { return "two" }
          else { return "other" }
        }
      }`;
    const { value } = await run(src, "check", { n: 2 }, stubModel());
    expect(value).toBe("two");
  });

  it("match works with model-derived values", async () => {
    const src = `
      pipeline triage(raw: text) -> text {
        let cat ~= classify(raw, into: [bug, feature, question])
        match cat.label {
          case "bug" { return "filing bug" }
          case "feature" { return "logging feature" }
          else { return "generic" }
        }
      }`;
    const model = stubModel({ classify: () => ({ label: "bug" }) });
    const { value } = await run(src, "triage", { raw: "it crashed" }, model);
    expect(value).toBe("filing bug");
  });

  // ── timeout ────────────────────────────────────────────────────────
  it("timeout throws when model call exceeds limit", async () => {
    const src = `
      init {
        model slow = "test-model" { temperature = 0.5 }
      }
      pipeline go(text: text) -> text {
        let x ~= compress(text, max: 50) with slow timeout 50
        return x
      }`;
    const slowModel = () => new Promise((resolve) =>
      setTimeout(() => resolve({ value: "done", inputTokens: 1, outputTokens: 1 }), 200)
    );
    await expect(run(src, "go", { text: "hi" }, slowModel)).rejects.toThrow(/timed out/);
  });

  it("timeout does not throw when model completes in time", async () => {
    const src = `
      init {
        model fast = "test-model" { temperature = 0.5 }
      }
      pipeline go(text: text) -> obj {
        let x ~= compress(text, max: 50) with fast timeout 5000
        return x
      }`;
    const model = stubModel();
    const { value } = await run(src, "go", { text: "hello" }, model);
    expect(value).toBeDefined();
  });

  it("timeout + retry retries on timeout then succeeds", async () => {
    const src = `
      init {
        model m = "test-model" {}
      }
      pipeline go(text: text) -> obj {
        let x ~= compress(text, max: 50) with m retry 2 timeout 50
        return x
      }`;
    let calls = 0;
    const model = () => {
      calls++;
      if (calls === 1) return new Promise((r) => setTimeout(() => r({ value: "late", inputTokens: 1, outputTokens: 1 }), 200));
      return Promise.resolve({ value: JSON.stringify({ text: "ok" }), inputTokens: 1, outputTokens: 1 });
    };
    const { value } = await run(src, "go", { text: "hi" }, model);
    expect(value).toEqual({ text: "ok" });
    expect(calls).toBe(2);
  });

  // ── math builtins ──────────────────────────────────────────────────
  it("min/max work with args and lists", async () => {
    const src = `
      pipeline go(x: num) -> obj {
        let a = min(3, 1, 2)
        let b = max(3, 1, 2)
        let c = min([5, 2, 8])
        let d = max([5, 2, 8])
        return @Result { a, b, c, d }
      }`;
    const { value } = await run(src, "go", { x: 0 }, stubModel());
    expect(value.a).toBe(1);
    expect(value.b).toBe(3);
    expect(value.c).toBe(2);
    expect(value.d).toBe(8);
  });

  it("abs/round/floor/ceil work", async () => {
    const src = `
      pipeline go(x: num) -> obj {
        let a = abs(0 - 5)
        let b = round(3.7)
        let c = floor(3.7)
        let d = ceil(3.2)
        return @Result { a, b, c, d }
      }`;
    const { value } = await run(src, "go", { x: 0 }, stubModel());
    expect(value.a).toBe(5);
    expect(value.b).toBe(4);
    expect(value.c).toBe(3);
    expect(value.d).toBe(4);
  });

  // ── default param values ───────────────────────────────────────────
  it("pipeline uses default when arg is omitted", async () => {
    const src = `
      pipeline greet(name: text, greeting: text = "Hello") -> text {
        return concat(greeting, concat(" ", name))
      }`;
    const r1 = await run(src, "greet", { name: "Alice" }, stubModel());
    expect(r1.value).toBe("Hello Alice");
    const r2 = await run(src, "greet", { name: "Bob", greeting: "Hi" }, stubModel());
    expect(r2.value).toBe("Hi Bob");
  });

  it("function uses default when arg is omitted", async () => {
    const src = `
      function add(a: num, b: num = 10) -> num {
        return a + b
      }
      pipeline go(x: num) -> num {
        return add(x)
      }`;
    const { value } = await run(src, "go", { x: 5 }, stubModel());
    expect(value).toBe(15);
  });

  it("multiple defaults work", async () => {
    const src = `
      pipeline go(a: num, b: num = 2, c: num = 3) -> num {
        return a + b + c
      }`;
    const r1 = await run(src, "go", { a: 1 }, stubModel());
    expect(r1.value).toBe(6);
    const r2 = await run(src, "go", { a: 1, b: 10 }, stubModel());
    expect(r2.value).toBe(14);
  });

  it("rejects required param after default param", () => {
    const src = `
      pipeline bad(a: num = 1, b: num) -> num {
        return a + b
      }`;
    expect(() => compile(src)).toThrow(/must have a default/);
  });

  it("still errors on missing required param", async () => {
    const src = `
      pipeline go(a: num, b: num) -> num {
        return a + b
      }`;
    await expect(run(src, "go", { a: 1 }, stubModel())).rejects.toThrow(/missing argument/);
  });

  // ── Type declarations & schema enforcement ────────────────────────
  it("enforces type schema: missing field", async () => {
    const src = `
      type Lead {
        name: text
        score: num
      }
      pipeline go(name: text) -> Lead {
        return @Lead { name }
      }`;
    await expect(run(src, "go", { name: "Alice" }, stubModel())).rejects.toThrow(/missing required field 'score'/);
  });

  it("enforces type schema: wrong field type", async () => {
    const src = `
      type Lead {
        name: text
        score: num
      }
      pipeline go(name: text) -> Lead {
        return @Lead { name, score: "high" }
      }`;
    await expect(run(src, "go", { name: "Alice" }, stubModel())).rejects.toThrow(/expected type 'num'/);
  });

  it("enforces type schema: extra field rejected", async () => {
    const src = `
      type Lead {
        name: text
      }
      pipeline go(name: text) -> Lead {
        return @Lead { name, extra: "nope" }
      }`;
    await expect(run(src, "go", { name: "Alice" }, stubModel())).rejects.toThrow(/unexpected field 'extra'/);
  });

  it("type schema passes on valid record", async () => {
    const src = `
      type Lead {
        name: text
        score: num
        tags: list
      }
      pipeline go(name: text) -> Lead {
        return @Lead { name, score: 42, tags: ["hot"] }
      }`;
    const { value } = await run(src, "go", { name: "Alice" }, stubModel());
    expect(value.name).toBe("Alice");
    expect(value.score).toBe(42);
    expect(value.tags).toEqual(["hot"]);
  });

  it("errors if return type has no matching type block", () => {
    const src = `
      pipeline go(x: text) -> Nope {
        return @Nope { x }
      }`;
    expect(() => compile(src)).toThrow(/return type 'Nope' is not defined/);
  });

  it("untyped records still work without enforcement", async () => {
    const src = `
      pipeline go(x: num) -> obj {
        return @Foo { x, y: "bar" }
      }`;
    const { value } = await run(src, "go", { x: 1 }, stubModel());
    expect(value.x).toBe(1);
    expect(value.y).toBe("bar");
  });

  // ── Agents as tools ───────────────────────────────────────────────
  it("agent can use another agent as a tool", async () => {
    const src = `
      agent researcher(topic: text) -> obj max 3 {
        loop {
          let summary ~= compress(topic, max: 50)
          return @Result { answer: summary.text }
        }
      }
      agent coordinator(question: text) -> obj max 3 {
        tools {
          researcher(topic: text) -> obj
        }
        loop {
          let result = use("researcher", question)
          return @Answer { result }
        }
      }`;
    const model = stubModel({ compress: () => ({ text: "researched answer" }) });
    const { value, stats } = await run(src, "coordinator", { question: "what is AI" }, model);
    expect(value.result.answer).toBe("researched answer");
    expect(stats.toolCalls).toBe(1);
  });

  // ── map builtin ───────────────────────────────────────────────────
  it("map plucks a field by string key", async () => {
    const src = `
      pipeline go(items: list) -> list {
        let names = map(items, "name")
        return names
      }`;
    const { value } = await run(src, "go", {
      items: [{ name: "Alice" }, { name: "Bob" }],
    }, stubModel());
    expect(value).toEqual(["Alice", "Bob"]);
  });

  it("map calls a function per item", async () => {
    const src = `
      function double(n: num) -> num {
        return n * 2
      }
      pipeline go(nums: list) -> list {
        let result = map(nums, double())
        return result
      }`;
    const { value } = await run(src, "go", { nums: [1, 2, 3] }, stubModel());
    expect(value).toEqual([2, 4, 6]);
  });

  it("map calls a pipeline per item", async () => {
    const src = `
      pipeline tag(item: text) -> text {
        return concat("[", concat(item, "]"))
      }
      pipeline go(items: list) -> list {
        let result = map(items, tag())
        return result
      }`;
    const { value } = await run(src, "go", { items: ["a", "b"] }, stubModel());
    expect(value).toEqual(["[a]", "[b]"]);
  });

  // ── Return type enforcement ───────────────────────────────────────
  it("errors when return value doesn't match declared return type", async () => {
    const src = `
      pipeline go(x: num) -> num {
        return "not a number"
      }`;
    await expect(run(src, "go", { x: 1 }, stubModel())).rejects.toThrow(/expected num, got string/);
  });

  it("errors when return value doesn't match custom type schema", async () => {
    const src = `
      type Result {
        name: text
        score: num
      }
      pipeline go(x: text) -> Result {
        return @Result { name: x, score: "high" }
      }`;
    await expect(run(src, "go", { x: "Alice" }, stubModel())).rejects.toThrow(/expected.*num.*got.*string/);
  });

  it("return type enforcement passes on correct type", async () => {
    const src = `
      type Info {
        name: text
        count: num
      }
      pipeline go(name: text) -> Info {
        return @Info { name, count: 5 }
      }`;
    const { value } = await run(src, "go", { name: "Bob" }, stubModel());
    expect(value.name).toBe("Bob");
    expect(value.count).toBe(5);
  });

  // ── Param type enforcement ────────────────────────────────────────
  it("errors when param doesn't match declared builtin type", async () => {
    const src = `
      pipeline go(x: num) -> num {
        return x * 2
      }`;
    await expect(run(src, "go", { x: "hello" }, stubModel())).rejects.toThrow(/param 'x'.*expected num/);
  });

  it("errors when param doesn't match custom type", async () => {
    const src = `
      type Analysis {
        mood: text
        score: num
      }
      pipeline process(data: Analysis) -> text {
        return data.mood
      }`;
    await expect(run(src, "go", { data: { mood: "happy" } }, stubModel())).rejects.toThrow();
  });

  it("param type enforcement passes on correct custom type", async () => {
    const src = `
      type Analysis {
        mood: text
        score: num
      }
      pipeline process(data: Analysis) -> text {
        return data.mood
      }`;
    const { value } = await run(src, "process", { data: { mood: "happy", score: 9 } }, stubModel());
    expect(value).toBe("happy");
  });

  it("function param type is enforced", async () => {
    const src = `
      function double(n: num) -> num {
        return n * 2
      }
      pipeline go(x: text) -> num {
        return double(x)
      }`;
    await expect(run(src, "go", { x: "oops" }, stubModel())).rejects.toThrow(/param 'n'.*expected num/);
  });

  // ── throw / catch ───────────────────────────────────────────────────
  it("bare throw is caught by untyped catch", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        try {
          throw "something broke"
        } catch err {
          return @Result { message: err.message }
        }
      }`;
    const { value } = await run(src, "go", { text: "hi" }, stubModel());
    expect(value).toEqual({ message: "something broke" });
  });

  it("typed throw is caught by typed catch", async () => {
    const src = `
      error NotFound {
        query: text
      }
      pipeline go(text: text) -> obj {
        try {
          throw NotFound("no results", query: text)
        } catch NotFound as err {
          return @Result { message: err.message, query: err.query }
        }
      }`;
    const { value } = await run(src, "go", { text: "search term" }, stubModel());
    expect(value).toEqual({ message: "no results", query: "search term" });
  });

  it("typed catch only matches its error type", async () => {
    const src = `
      error NotFound {
        query: text
      }
      error Forbidden {
        reason: text
      }
      pipeline go(text: text) -> obj {
        try {
          throw Forbidden("access denied", reason: "no auth")
        } catch NotFound as err {
          return @Result { caught: "notfound" }
        } catch err {
          return @Result { caught: "fallback", message: err.message }
        }
      }`;
    const { value } = await run(src, "go", { text: "hi" }, stubModel());
    expect(value).toEqual({ caught: "fallback", message: "access denied" });
  });

  it("throw bypasses return type check", async () => {
    const src = `
      type Strict {
        name: text
        score: num
      }
      pipeline go(text: text) -> Strict {
        if text == "" {
          throw "empty input"
        }
        return @Strict { name: "ok", score: 1 }
      }
      pipeline wrapper(text: text) -> obj {
        try {
          let result = go(text)
          return result
        } catch err {
          return @Fallback { error: err.message }
        }
      }`;
    const { value } = await run(src, "wrapper", { text: "" }, stubModel());
    expect(value).toEqual({ error: "empty input" });
  });

  it("typed throw validates fields against error schema", async () => {
    const src = `
      error BadInput {
        field: text
      }
      pipeline go(text: text) -> obj {
        throw BadInput("bad", field: 42)
        return @Result {}
      }`;
    await expect(run(src, "go", { text: "hi" }, stubModel())).rejects.toThrow(/expected text/);
  });

  it("uncaught throw propagates as error", async () => {
    const src = `
      pipeline go(text: text) -> obj {
        throw "boom"
        return @Result {}
      }`;
    await expect(run(src, "go", { text: "hi" }, stubModel())).rejects.toThrow("boom");
  });

  // ── runtime errors as typed catches ────────────────────────────────
  it("TimedOut is catchable as a typed error", async () => {
    const src = `
      init {
        model slow = "test-model" {}
      }
      pipeline go(text: text) -> obj {
        try {
          let x ~= compress(text, max: 50) with slow timeout 50
          return x
        } catch TimedOut as err {
          return @Result { caught: "timeout", timeout: err.timeout }
        }
      }`;
    const slowModel = () => new Promise((resolve) =>
      setTimeout(() => resolve({ value: "done", inputTokens: 1, outputTokens: 1 }), 200)
    );
    const { value } = await run(src, "go", { text: "hi" }, slowModel);
    expect(value.caught).toBe("timeout");
    expect(value.timeout).toBe(50);
  });

  it("BudgetExceeded is catchable as a typed error", async () => {
    const src = `
      init {
        model m = "test" {}
        budget {
          max_tokens = 50
          on_exceed = "stop"
        }
      }
      pipeline go(text: text) -> obj {
        try {
          let a ~= compress(text, max: 50) with m
          let b ~= compress(text, max: 50) with m
          return b
        } catch BudgetExceeded as err {
          return @Result { caught: "budget", max: err.max }
        }
      }`;
    const model = () => ({ value: { text: "ok" }, inputTokens: 30, outputTokens: 30 });
    const { value } = await run(src, "go", { text: "hi" }, model);
    expect(value.caught).toBe("budget");
    expect(value.max).toBe(50);
  });

  it("AgentMaxIterations is catchable as a typed error", async () => {
    const src = `
      agent looper(text: text) -> obj max 2 {
        loop {
          let x ~= compress(text, max: 50)
          log x
        }
      }
      pipeline go(text: text) -> obj {
        try {
          let result = looper(text)
          return result
        } catch AgentMaxIterations as err {
          return @Result { caught: "max_iter", agent: err.agent, max: err.max }
        }
      }`;
    const { value } = await run(src, "go", { text: "hi" }, stubModel());
    expect(value.caught).toBe("max_iter");
    expect(value.agent).toBe("looper");
    expect(value.max).toBe(2);
  });
});
