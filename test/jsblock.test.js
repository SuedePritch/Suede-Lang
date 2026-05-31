import { describe, it, expect } from "vitest";
import { run, stubModel } from "../src/index.js";

const model = stubModel();

describe("js blocks", () => {
  describe("basic execution", () => {
    it("executes a js block and returns a value", async () => {
      const src = `
        main(x: num) -> num {
          let result = js { return x * 2 }
          return result
        }`;
      const { value } = await run(src, "main", { x: 5 }, model);
      expect(value).toBe(10);
    });

    it("returns strings", async () => {
      const src = `
        main(name: text) -> text {
          let greeting = js { return "hello " + name }
          return greeting
        }`;
      const { value } = await run(src, "main", { name: "world" }, model);
      expect(value).toBe("hello world");
    });

    it("returns objects", async () => {
      const src = `
        main(x: num) -> obj {
          let result = js { return { doubled: x * 2, tripled: x * 3 } }
          return result
        }`;
      const { value } = await run(src, "main", { x: 4 }, model);
      expect(value).toEqual({ doubled: 8, tripled: 12 });
    });

    it("returns arrays", async () => {
      const src = `
        main(x: num) -> list {
          let result = js { return [x, x + 1, x + 2] }
          return result
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toEqual([1, 2, 3]);
    });

    it("returns null", async () => {
      const src = `
        main(x: num) -> obj {
          let result = js { return null }
          return result
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toBeNull();
    });
  });

  describe("scope access", () => {
    it("reads suede variables", async () => {
      const src = `
        main(a: num) -> num {
          let b = 10
          let result = js { return a + b }
          return result
        }`;
      const { value } = await run(src, "main", { a: 5 }, model);
      expect(value).toBe(15);
    });

    it("reads model call results", async () => {
      const src = `
        init { model fast = "test" {} }
        main(text: text) -> text {
          let info ~= extract(text, fields: [name]) with fast
          let upper = js { return info.name.toUpperCase() }
          return upper
        }`;
      const m = stubModel({ extract: () => ({ name: "alice" }) });
      const { value } = await run(src, "main", { text: "hi" }, m);
      expect(value).toBe("ALICE");
    });

    it("reads nested object properties", async () => {
      const src = `
        main(data: obj) -> text {
          let result = js { return data.user.name + " is " + data.user.age }
          return result
        }`;
      const { value } = await run(src, "main", { data: { user: { name: "bob", age: 30 } } }, model);
      expect(value).toBe("bob is 30");
    });
  });

  describe("async support", () => {
    it("supports await", async () => {
      const src = `
        main(x: num) -> num {
          let result = js {
            const val = await Promise.resolve(x * 10)
            return val
          }
          return result
        }`;
      const { value } = await run(src, "main", { x: 3 }, model);
      expect(value).toBe(30);
    });

    it("supports async fetch-like patterns", async () => {
      const src = `
        main(url: text) -> obj {
          let result = js {
            const data = await Promise.resolve({ status: 200, body: "ok from " + url })
            return data
          }
          return result
        }`;
      const { value } = await run(src, "main", { url: "https://example.com" }, model);
      expect(value).toEqual({ status: 200, body: "ok from https://example.com" });
    });
  });

  describe("error handling", () => {
    it("propagates errors from js blocks", async () => {
      const src = `
        main(x: num) -> num {
          let result = js { throw new Error("js error") }
          return result
        }`;
      await expect(run(src, "main", { x: 1 }, model)).rejects.toThrow("js error");
    });

    it("catchable in try/catch", async () => {
      const src = `
        main(x: num) -> obj {
          try {
            let result = js { throw new Error("oops") }
            return result
          } catch err {
            return @Fallback { message: err.message }
          }
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toEqual({ message: "oops" });
    });
  });

  describe("uses = not ~=", () => {
    it("counts as a code step not a model call", async () => {
      const src = `
        main(x: num) -> num {
          let result = js { return x + 1 }
          return result
        }`;
      const { stats } = await run(src, "main", { x: 1 }, model);
      expect(stats.modelCalls).toBe(0);
      expect(stats.codeSteps).toBe(1);
    });
  });

  describe("multiline blocks", () => {
    it("handles complex multiline js", async () => {
      const src = `
        main(items: list) -> obj {
          let result = js {
            const total = items.reduce((sum, n) => sum + n, 0)
            const avg = total / items.length
            const max = Math.max(...items)
            return { total, avg, max }
          }
          return result
        }`;
      const { value } = await run(src, "main", { items: [10, 20, 30] }, model);
      expect(value).toEqual({ total: 60, avg: 20, max: 30 });
    });
  });

  describe("tricky js syntax in blocks", () => {
    it("handles nested braces in objects", async () => {
      const src = `
        main(x: num) -> obj {
          let result = js {
            const a = { inner: { deep: x } }
            return a
          }
          return result
        }`;
      const { value } = await run(src, "main", { x: 42 }, model);
      expect(value).toEqual({ inner: { deep: 42 } });
    });

    it("handles braces in strings", async () => {
      const src = `
        main(x: num) -> text {
          let result = js { return "hello { world }" }
          return result
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toBe("hello { world }");
    });

    it("handles braces in single-quoted strings", async () => {
      const src = `
        main(x: num) -> text {
          let result = js { return '{ not a block }' }
          return result
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toBe("{ not a block }");
    });

    it("handles template literals with expressions", async () => {
      const src = `
        main(name: text) -> text {
          let result = js {
            const x = 10
            return \`hello \${name}, value is \${x + 1}\`
          }
          return result
        }`;
      const { value } = await run(src, "main", { name: "world" }, model);
      expect(value).toBe("hello world, value is 11");
    });

    it("handles template literals with nested braces", async () => {
      const src = `
        main(x: num) -> text {
          let result = js {
            const obj = { a: 1 }
            return \`result: \${JSON.stringify(obj)}\`
          }
          return result
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toBe('result: {"a":1}');
    });

    it("handles line comments with braces", async () => {
      const src = `
        main(x: num) -> num {
          let result = js {
            // this has a } but it's a comment
            return x + 1 // and another {
          }
          return result
        }`;
      const { value } = await run(src, "main", { x: 5 }, model);
      expect(value).toBe(6);
    });

    it("handles block comments with braces", async () => {
      const src = `
        main(x: num) -> num {
          let result = js {
            /* { this is a comment } */
            return x * 2
          }
          return result
        }`;
      const { value } = await run(src, "main", { x: 3 }, model);
      expect(value).toBe(6);
    });

    it("handles regex literals with braces", async () => {
      const src = `
        main(text: text) -> bool {
          let result = js {
            const re = /\\{[^}]+\\}/
            return re.test(text)
          }
          return result
        }`;
      const { value } = await run(src, "main", { text: "hello {world}" }, model);
      expect(value).toBe(true);
    });

    it("handles arrow functions with braces", async () => {
      const src = `
        main(items: list) -> list {
          let result = js {
            return items.map(x => { return x * 2 })
          }
          return result
        }`;
      const { value } = await run(src, "main", { items: [1, 2, 3] }, model);
      expect(value).toEqual([2, 4, 6]);
    });

    it("handles escaped quotes in strings", async () => {
      const src = `
        main(x: num) -> text {
          let result = js { return "she said \\"hello\\" and { left }" }
          return result
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toBe('she said "hello" and { left }');
    });

    it("handles division (not regex) correctly", async () => {
      const src = `
        main(x: num) -> num {
          let result = js {
            const a = 10
            return a / 2
          }
          return result
        }`;
      const { value } = await run(src, "main", { x: 1 }, model);
      expect(value).toBe(5);
    });
  });
});
