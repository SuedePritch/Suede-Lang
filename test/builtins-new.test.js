import { describe, it, expect } from "vitest";
import { run, stubModel, asJson } from "../src/index.js";

describe("new builtins", () => {
  // ── parse_json / to_json ───────────────────────────────────────────
  it("parse_json parses a JSON string into an object", async () => {
    const src = `
      pipeline go(raw: text) -> obj {
        let data = parse_json(raw)
        return data
      }`;
    const { value } = await run(src, "go", { raw: '{"name":"Alice","age":30}' }, stubModel());
    expect(value.name).toBe("Alice");
    expect(value.age).toBe(30);
  });

  it("parse_json parses a JSON array", async () => {
    const src = `
      pipeline go(raw: text) -> list {
        let data = parse_json(raw)
        return data
      }`;
    const { value } = await run(src, "go", { raw: '[1,2,3]' }, stubModel());
    expect(value).toEqual([1, 2, 3]);
  });

  it("to_json serializes a value to a JSON string", async () => {
    const src = `
      pipeline go(x: text) -> text {
        let list = [1, 2, 3]
        let out = to_json(list)
        return out
      }`;
    const { value } = await run(src, "go", { x: "" }, stubModel());
    expect(value).toBe("[1,2,3]");
  });

  // ── filter functions ───────────────────────────────────────────────
  it("filter keeps items where key == value", async () => {
    const src = `
      pipeline go(x: text) -> list {
        let items = parse_json(x)
        let bugs = filter(items, "type", "bug")
        return bugs
      }`;
    const input = JSON.stringify([
      { type: "bug", name: "a" },
      { type: "feature", name: "b" },
      { type: "bug", name: "c" },
    ]);
    const { value } = await run(src, "go", { x: input }, stubModel());
    expect(value).toHaveLength(2);
    expect(value[0].name).toBe("a");
    expect(value[1].name).toBe("c");
  });

  it("filter_gte keeps items where key >= value", async () => {
    const src = `
      pipeline go(x: text) -> list {
        let items = parse_json(x)
        let hot = filter_gte(items, "score", 8)
        return hot
      }`;
    const input = JSON.stringify([
      { score: 9, name: "a" },
      { score: 5, name: "b" },
      { score: 8, name: "c" },
      { score: 3, name: "d" },
    ]);
    const { value } = await run(src, "go", { x: input }, stubModel());
    expect(value).toHaveLength(2);
    expect(value[0].name).toBe("a");
    expect(value[1].name).toBe("c");
  });

  it("filter_lt keeps items where key < value", async () => {
    const src = `
      pipeline go(x: text) -> list {
        let items = parse_json(x)
        let low = filter_lt(items, "score", 5)
        return low
      }`;
    const input = JSON.stringify([
      { score: 9 }, { score: 5 }, { score: 3 }, { score: 1 },
    ]);
    const { value } = await run(src, "go", { x: input }, stubModel());
    expect(value).toHaveLength(2);
    expect(value[0].score).toBe(3);
    expect(value[1].score).toBe(1);
  });

  it("filter_gt and filter_lte work", async () => {
    const src = `
      pipeline go(x: text) -> list {
        let items = parse_json(x)
        let gt5 = filter_gt(items, "n", 5)
        let lte5 = filter_lte(items, "n", 5)
        return concat(gt5, lte5)
      }`;
    const input = JSON.stringify([{ n: 3 }, { n: 5 }, { n: 7 }]);
    const { value } = await run(src, "go", { x: input }, stubModel());
    expect(value).toHaveLength(3);
    expect(value[0].n).toBe(7);    // gt5
    expect(value[1].n).toBe(3);    // lte5
    expect(value[2].n).toBe(5);    // lte5
  });
});

describe("parallel for", () => {
  it("runs iterations concurrently and collects results", async () => {
    const src = `
      pipeline go(items: list) -> list {
        parallel for item in items into results {
          let upper = upper(item)
          emit upper
        }
        return results
      }`;
    const { value } = await run(src, "go", { items: ["a", "b", "c"] }, stubModel());
    expect(value).toEqual(["A", "B", "C"]);
  });

  it("parallel for with pipeline calls", async () => {
    const src = `
      pipeline double(x: num) -> num {
        return x * 2
      }
      pipeline go(nums: list) -> list {
        parallel for n in nums into results {
          let d = double(n)
          emit d
        }
        return results
      }`;
    const { value } = await run(src, "go", { nums: [1, 2, 3, 4] }, stubModel());
    expect(value).toEqual([2, 4, 6, 8]);
  });

  it("parallel for with model calls runs concurrently", async () => {
    const order = [];
    const model = stubModel({
      compress: (prompt) => {
        order.push("start");
        order.push("end");
        return { text: "short" };
      },
    });
    const src = `
      pipeline go(items: list) -> list {
        parallel for item in items into results {
          let s ~= compress(item, max: 10)
          emit s
        }
        return results
      }`;
    const { value } = await run(src, "go", { items: ["a", "b", "c"] }, model);
    expect(value).toHaveLength(3);
  });
});

describe("truncated JSON repair", () => {
  it("repairs truncated JSON with missing closing braces", () => {
    const truncated = '{"name": "Alice", "skills": ["React", "TypeScript"], "years';
    const result = asJson(truncated);
    expect(result.name).toBe("Alice");
    expect(result.skills).toEqual(["React", "TypeScript"]);
  });

  it("repairs truncated JSON mid-array", () => {
    const truncated = '{"items": [1, 2, 3';
    const result = asJson(truncated);
    expect(result.items).toEqual([1, 2, 3]);
  });

  it("still throws on total garbage", () => {
    expect(() => asJson("not json at all")).toThrow();
  });
});
