import { describe, it, expect } from "vitest";
import { compile, compileWithFiles, check, run, stubModel } from "../src/index.js";

describe("import merging", () => {
  it("merges types from imported files", () => {
    const files = new Map([
      ["main.suede", `
        import { process } from "./logic.suede"
        pipeline go(x: text) -> Result {
          return process(x)
        }
      `],
      ["logic.suede", `
        import { Result } from "./types.suede"
        pipeline process(x: text) -> Result {
          return @Result { value: x }
        }
      `],
      ["types.suede", `
        type Result {
          value: text
        }
      `],
    ]);
    const prog = compileWithFiles(files.get("main.suede"), files);
    expect(prog.types.Result).toBeTruthy();
    expect(prog.types.Result.value).toBe("text");
  });

  it("merges errors from imported files", () => {
    const files = new Map([
      ["main.suede", `
        import { risky } from "./logic.suede"
        pipeline go(x: text) -> text {
          return risky(x)
        }
      `],
      ["logic.suede", `
        import { NotFound } from "./errors.suede"
        pipeline risky(x: text) -> text {
          throw NotFound("gone", key: x)
        }
      `],
      ["errors.suede", `
        error NotFound {
          key: text
        }
      `],
    ]);
    const prog = compileWithFiles(files.get("main.suede"), files);
    expect(prog.errors.NotFound).toBeTruthy();
  });

  it("merges init from imported files", () => {
    const files = new Map([
      ["main.suede", `
        import { helper } from "./lib.suede"
        pipeline go(x: text) -> text {
          return helper(x)
        }
      `],
      ["lib.suede", `
        init {
          api_keys { gemini = "test" }
          model fast = "test-model" {
            provider = "gemini"
            temperature = 0.2
            max_tokens = 100
          }
        }
        pipeline helper(x: text) -> text {
          return x
        }
      `],
    ]);
    const prog = compileWithFiles(files.get("main.suede"), files);
    expect(prog.init).toBeTruthy();
    expect(prog.init.models.fast.id).toBe("test-model");
  });

  it("merges all functions (not just selectively imported ones)", () => {
    const files = new Map([
      ["main.suede", `
        import { go } from "./lib.suede"
        pipeline start(x: text) -> text {
          return go(x)
        }
      `],
      ["lib.suede", `
        function helper(x: text) -> text {
          return upper(x)
        }
        pipeline go(x: text) -> text {
          return helper(x)
        }
      `],
    ]);
    const prog = compileWithFiles(files.get("main.suede"), files);
    // helper should be merged even though it wasn't in the import list
    const funcNames = prog.functions.map(f => f.name);
    expect(funcNames).toContain("helper");
  });

  it("check passes on multi-file project with types in separate file", async () => {
    const files = new Map([
      ["main.suede", `
        import { greet } from "./greet.suede"
        pipeline go(name: text) -> Greeting {
          return greet(name)
        }
      `],
      ["greet.suede", `
        import { Greeting } from "./types.suede"
        pipeline greet(name: text) -> Greeting {
          return @Greeting { message: concat("hello ", name) }
        }
      `],
      ["types.suede", `
        type Greeting {
          message: text
        }
      `],
    ]);
    const prog = compileWithFiles(files.get("main.suede"), files);
    const issues = check(prog);
    expect(issues.length).toBe(0);
  });

  it("runs across multiple files end-to-end", async () => {
    const files = new Map([
      ["types.suede", `
        type Result { answer: text }
      `],
      ["helpers.suede", `
        function shout(x: text) -> text {
          return upper(x)
        }
      `],
      ["main.suede", `
        import { Result } from "./types.suede"
        import { shout } from "./helpers.suede"
        main(input: text) -> Result {
          let loud = shout(input)
          return @Result { answer: loud }
        }
      `],
    ]);
    const prog = compileWithFiles(files.get("main.suede"), files);
    const { Interpreter } = await import("../src/interpreter.js");
    const interp = new Interpreter(stubModel(), () => {});
    const result = await interp.run(prog, null, { input: "hello" });
    expect(result.answer).toBe("HELLO");
  });
});
