import { describe, it, expect } from "vitest";
import { compile, run, stubModel } from "../src/index.js";
import { analyze as runAnalyze } from "../src/analyze.js";

function analyze(src, args = {}, entry) {
  return runAnalyze(compile(src), args, () => {}, entry);
}

describe("main entry point", () => {
  it("main block is the default entry point", async () => {
    const src = `
      pipeline helper(x: num) -> num {
        return x * 2
      }
      main(n: num) -> num {
        let result = helper(n)
        return result
      }`;
    const { value } = await run(src, null, { n: 5 }, stubModel());
    expect(value).toBe(10);
  });

  it("run with entry='main' uses the main block", async () => {
    const src = `
      main(x: text) -> text {
        return x |> upper()
      }`;
    const { value } = await run(src, "main", { x: "hello" }, stubModel());
    expect(value).toBe("HELLO");
  });

  it("only one main allowed", () => {
    const src = `
      main(x: num) -> num { return x }
      main(y: num) -> num { return y }`;
    expect(() => compile(src)).toThrow(/only one main/);
  });

  it("can still run named pipelines directly", async () => {
    const src = `
      pipeline helper(x: num) -> num { return x + 1 }
      main(x: num) -> num { return helper(x) }`;
    const { value } = await run(src, "helper", { x: 10 }, stubModel());
    expect(value).toBe(11);
  });
});

describe("static analyzer", () => {
  it("counts a single model call", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> text {
        let s ~= compress(text, max: 50) with fast
        return s
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(1);
    expect(paths[0].byModel.fast.calls).toBe(1);
  });

  it("counts code steps", () => {
    const src = `
      main(text: text) -> text {
        let a = text |> upper()
        let b = text |> lower()
        return concat(a, b)
      }`;
    const paths = analyze(src, { text: "hi" });
    expect(paths).toHaveLength(1);
    expect(paths[0].codeSteps).toBe(2);
    expect(paths[0].modelCalls).toBe(0);
  });

  it("parallel block counts all calls", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> obj {
        parallel {
          let a ~= extract(text, fields: [name]) with fast
          let b ~= classify(text, into: [pos, neg]) with fast
          let c ~= compress(text, max: 50) with fast
        }
        return @R { a, b, c }
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(3);
    expect(paths[0].byModel.fast.calls).toBe(3);
  });

  it("if/else creates two paths", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> text {
        let x ~= classify(text, into: [a, b]) with fast
        if x == "a" {
          let y ~= compress(text, max: 50) with fast
          return y
        } else {
          return "nope"
        }
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(2);
    // then path: classify + compress = 2 calls
    expect(paths.find(p => p.modelCalls === 2)).toBeTruthy();
    // else path: classify only = 1 call
    expect(paths.find(p => p.modelCalls === 1)).toBeTruthy();
  });

  it("nested if creates multiple paths", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> text {
        if true {
          if true {
            let a ~= compress(text, max: 10) with fast
            return a
          } else {
            let b ~= expand(text, max: 50) with fast
            return b
          }
        } else {
          let c ~= classify(text, into: [x, y]) with fast
          return c
        }
      }`;
    const paths = analyze(src, { text: "hi" });
    expect(paths).toHaveLength(3);
  });

  it("parallel + if = all paths include parallel calls", () => {
    const src = `
      init {
        model fast = "test" { max_tokens = 100 }
        model smart = "big" { max_tokens = 4000 }
      }
      main(text: text) -> text {
        parallel {
          let a ~= extract(text, fields: [name]) with fast
          let b ~= classify(text, into: [x, y]) with fast
        }
        if b == "x" {
          let c ~= expand(text, max: 200) with smart
          return c
        } else {
          let d ~= compress(text, max: 50) with fast
          return d
        }
      }`;
    const paths = analyze(src, { text: "hello world test" });
    expect(paths).toHaveLength(2);
    // both paths should have at least 3 calls (2 parallel + 1 branch)
    for (const p of paths) {
      expect(p.modelCalls).toBeGreaterThanOrEqual(3);
    }
    // the path with smart model should have higher worst case
    const smartPath = paths.find(p => p.byModel.smart);
    const fastOnlyPath = paths.find(p => !p.byModel.smart);
    expect(smartPath).toBeTruthy();
    expect(fastOnlyPath).toBeTruthy();
    expect(smartPath.worstTokens).toBeGreaterThan(fastOnlyPath.worstTokens);
  });

  it("per-model breakdown is accurate", () => {
    const src = `
      init {
        model fast = "f" { max_tokens = 100 }
        model smart = "s" { max_tokens = 2000 }
      }
      main(text: text) -> text {
        let a ~= classify(text, into: [x]) with fast
        let b ~= expand(text, max: 500) with smart
        return b
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(1);
    expect(paths[0].byModel.fast.calls).toBe(1);
    expect(paths[0].byModel.smart.calls).toBe(1);
    // smart worst output should be 2000 (its max_tokens)
    expect(paths[0].byModel.smart.worstOut).toBe(2000);
    // fast worst output should be 100
    expect(paths[0].byModel.fast.worstOut).toBe(100);
  });

  it("try/catch walks the try body, not both", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> text {
        try {
          let a ~= compress(text, max: 50) with fast
          let b ~= expand(text, max: 100) with fast
          return b
        } catch err {
          return "error"
        }
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(2); // both calls in the try body
  });

  it("budget warning when worst case exceeds limit", () => {
    const src = `
      init {
        model big = "test" { max_tokens = 10000 }
        budget { max_tokens = 5000  on_exceed = "stop" }
      }
      main(text: text) -> text {
        let a ~= expand(text, max: 1000) with big
        return a
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths[0].worstTokens).toBeGreaterThan(5000);
    expect(paths[0].budgetWarning).toBeTruthy();
    expect(paths[0].budgetWarning).toContain("5000");
  });

  it("no budget warning when within limit", () => {
    const src = `
      init {
        model fast = "test" { max_tokens = 100 }
        budget { max_tokens = 5000  on_exceed = "stop" }
      }
      main(text: text) -> text {
        let a ~= compress(text, max: 50) with fast
        return a
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths[0].budgetWarning).toBeNull();
  });

  it("input tokens use actual prompt templates", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> text {
        let a ~= classify(text, into: [happy, sad, angry]) with fast
        return a
      }`;
    // short input
    const short = analyze(src, { text: "hi" });
    // long input
    const long = analyze(src, { text: "this is a much longer piece of text that should result in more input tokens being estimated" });
    // longer input should mean more input tokens
    expect(long[0].byModel.fast.inputTokens).toBeGreaterThan(short[0].byModel.fast.inputTokens);
  });

  it("best case output is realistic per verb", () => {
    const src = `
      init { model fast = "test" { max_tokens = 1000 } }
      main(text: text) -> obj {
        let a ~= classify(text, into: [short, x]) with fast
        let b ~= extract(text, fields: [name, email, phone]) with fast
        return @R { a, b }
      }`;
    const paths = analyze(src, { text: "hello" });
    const steps = paths[0].steps.filter(s => s.type === "model");
    // classify best case should be very small (one word)
    const classifyStep = steps.find(s => s.verb === "classify");
    expect(classifyStep.outputBest).toBeLessThan(5);
    // extract best case should be larger (JSON with 3 fields)
    const extractStep = steps.find(s => s.verb === "extract");
    expect(extractStep.outputBest).toBeGreaterThan(classifyStep.outputBest);
    // both worst cases should be max_tokens
    expect(classifyStep.outputWorst).toBe(1000);
    expect(extractStep.outputWorst).toBe(1000);
  });

  it("worst case output equals max_tokens from model config", () => {
    const src = `
      init {
        model small = "s" { max_tokens = 50 }
        model large = "l" { max_tokens = 8000 }
      }
      main(text: text) -> text {
        let a ~= compress(text, max: 20) with small
        let b ~= expand(text, max: 500) with large
        return concat(a, b)
      }`;
    const paths = analyze(src, { text: "hello" });
    const steps = paths[0].steps.filter(s => s.type === "model");
    expect(steps[0].outputWorst).toBe(50);
    expect(steps[1].outputWorst).toBe(8000);
  });

  it("for loop counts one iteration", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(items: list) -> list {
        for item in items into results {
          let s ~= compress(item, max: 50) with fast
          emit s
        }
        return results
      }`;
    const paths = analyze(src, { items: ["a", "b", "c"] });
    expect(paths).toHaveLength(1);
    // for loop in analyzer counts as 1 iteration
    expect(paths[0].modelCalls).toBe(1);
  });

  it("handles programs with no model calls", () => {
    const src = `
      main(x: num) -> num {
        let y = x * 2
        let z = y + 1
        return z
      }`;
    const paths = analyze(src, { x: 5 });
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(0);
    expect(paths[0].codeSteps).toBe(2);
    expect(paths[0].bestTokens).toBe(0);
    expect(paths[0].worstTokens).toBe(0);
  });

  it("sorts paths by worst case tokens", () => {
    const src = `
      init {
        model fast = "f" { max_tokens = 100 }
        model smart = "s" { max_tokens = 5000 }
      }
      main(text: text) -> text {
        if true {
          let a ~= expand(text, max: 500) with smart
          return a
        } else {
          let b ~= compress(text, max: 50) with fast
          return b
        }
      }`;
    const paths = analyze(src, { text: "hello" });
    paths.sort((a, b) => a.worstTokens - b.worstTokens);
    expect(paths[0].worstTokens).toBeLessThan(paths[1].worstTokens);
  });
});

describe("analyzer follows call chains", () => {

  it("main -> pipeline: analyzer sees model calls inside pipeline", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      pipeline do_work(text: text) -> text {
        let a ~= compress(text, max: 50) with fast
        let b ~= classify(text, into: [x, y]) with fast
        return b
      }
      main(text: text) -> text {
        let result = do_work(text)
        return result
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(2); // both calls inside do_work
  });

  it("main -> pipeline -> pipeline: analyzer follows nested calls", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      pipeline inner(text: text) -> text {
        let s ~= compress(text, max: 20) with fast
        return s
      }
      pipeline outer(text: text) -> text {
        let a = inner(text)
        let b ~= classify(text, into: [x, y]) with fast
        return b
      }
      main(text: text) -> text {
        let result = outer(text)
        return result
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(2); // compress in inner + classify in outer
  });

  it("main -> agent: analyzer walks agent loop body", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      function helper(x: text) -> text {
        return x |> upper()
      }
      agent worker(text: text) -> text max 3 {
        tools { helper(x: text) -> text }
        loop {
          let plan ~= generate(text, format: [action])  with fast
          let done ~= classify(plan, into: [yes, no]) with fast
          if done == "yes" {
            return plan
          }
        }
      }
      main(text: text) -> text {
        let result = worker(text)
        return result
      }`;
    const paths = analyze(src, { text: "hello" });
    // agent loop has if/else -> 2 paths through loop body
    expect(paths.length).toBeGreaterThanOrEqual(1);
    // every path should have at least 2 model calls (generate + classify)
    for (const p of paths) {
      expect(p.modelCalls).toBeGreaterThanOrEqual(2);
    }
  });

  it("main -> pipeline with parallel + if: full path analysis", () => {
    const src = `
      init {
        model fast = "f" { max_tokens = 100 }
        model smart = "s" { max_tokens = 4000 }
      }
      pipeline analyze(text: text) -> obj {
        parallel {
          let info ~= extract(text, fields: [name]) with fast
          let mood ~= classify(text, into: [good, bad]) with fast
        }
        if mood == "bad" {
          let detail ~= expand(text, max: 500) with smart
          return @R { info, detail }
        } else {
          return @R { info, summary: "all good" }
        }
      }
      main(text: text) -> obj {
        let result = analyze(text)
        return result
      }`;
    const paths = analyze(src, { text: "test message here" });
    expect(paths).toHaveLength(2);
    // both paths have the 2 parallel calls
    for (const p of paths) {
      expect(p.modelCalls).toBeGreaterThanOrEqual(2);
    }
    // the "bad" path has 3 calls (parallel 2 + expand 1) and uses smart
    const expensivePath = paths.find(p => p.byModel.smart);
    expect(expensivePath).toBeTruthy();
    expect(expensivePath.modelCalls).toBe(3);
    expect(expensivePath.worstTokens).toBeGreaterThan(paths.find(p => !p.byModel.smart).worstTokens);
  });

  it("custom prompt shows up in analyzer", () => {
    const src =
      'init { model fast = "test" { max_tokens = 200 } }\n' +
      'prompt score(text: text) -> num {\n' +
      '  "Rate 1-10: ${text}"\n' +
      '}\n' +
      'main(text: text) -> num {\n' +
      '  let s ~= score(text) with fast\n' +
      '  return s\n' +
      '}';
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(1);
    const step = paths[0].steps.find(s => s.type === "model");
    expect(step.verb).toBe("score");
    expect(step.outputWorst).toBe(200); // max_tokens from fast
  });

  it("function calls don't add model calls", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      function double(x: num) -> num {
        return x * 2
      }
      main(x: num) -> num {
        let a = double(x)
        let b ~= classify("test", into: [x, y]) with fast
        return a
      }`;
    const paths = analyze(src, { x: 5 });
    expect(paths[0].modelCalls).toBe(1); // only the classify, not double
  });

  it("deduplicates paths with identical model calls", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> text {
        let a ~= classify(text, into: [x, y]) with fast
        if a == "x" {
          return "yes"
        } else {
          return "no"
        }
      }`;
    const paths = analyze(src, { text: "hello" });
    // both branches have the same model calls (1 classify), so deduped to 1
    expect(paths).toHaveLength(1);
    expect(paths[0].modelCalls).toBe(1);
  });

  it("keeps paths with different model calls", () => {
    const src = `
      init { model fast = "test" { max_tokens = 100 } }
      main(text: text) -> text {
        if true {
          let a ~= compress(text, max: 50) with fast
          return a
        } else {
          let b ~= expand(text, max: 100) with fast
          let c ~= classify(text, into: [x]) with fast
          return c
        }
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths).toHaveLength(2);
    expect(paths.find(p => p.modelCalls === 1)).toBeTruthy();
    expect(paths.find(p => p.modelCalls === 2)).toBeTruthy();
  });

  it("budget warning on deep call chains", () => {
    const src = `
      init {
        model big = "test" { max_tokens = 10000 }
        budget { max_tokens = 5000  on_exceed = "stop" }
      }
      pipeline expensive(text: text) -> text {
        let a ~= expand(text, max: 1000) with big
        let b ~= generate(text, format: [x, y, z]) with big
        return b
      }
      main(text: text) -> text {
        let result = expensive(text)
        return result
      }`;
    const paths = analyze(src, { text: "hello" });
    expect(paths[0].budgetWarning).toBeTruthy();
    expect(paths[0].worstTokens).toBeGreaterThan(5000);
  });
});

describe("main runtime execution", () => {
  it("main calls pipeline calls function calls custom prompt", async () => {
    const src =
      'prompt rate(text: text) -> num {\n' +
      '  "Rate this 1-10: ${text}. Return only the number."\n' +
      '}\n' +
      'function label(score: num) -> text {\n' +
      '  if score >= 7 { return "good" } else { return "bad" }\n' +
      '}\n' +
      'pipeline evaluate(doc: text) -> obj {\n' +
      '  let score ~= rate(doc)\n' +
      '  let grade = label(score)\n' +
      '  return @Eval { score, grade }\n' +
      '}\n' +
      'main(doc: text) -> obj {\n' +
      '  let result = evaluate(doc)\n' +
      '  return result\n' +
      '}';
    const model = () => ({ value: "8", inputTokens: 10, outputTokens: 2 });
    const { value, stats } = await run(src, null, { doc: "great work" }, model);
    expect(value.score).toBe(8);
    expect(value.grade).toBe("good");
    expect(stats.modelCalls).toBe(1);
  });
});
