import { describe, it, expect } from "vitest";
import { run, stubModel } from "../src/index.js";

describe("const vs let scoping", () => {
  it("let propagates mutations out of for loops", async () => {
    const src = `
      pipeline sum(nums: list) -> num {
        let total = 0
        for n in nums {
          let total = total + n
        }
        return total
      }`;
    const { value } = await run(src, "sum", { nums: [1, 2, 3, 4] }, stubModel());
    expect(value).toBe(10);
  });

  it("const does NOT propagate out of for loops", async () => {
    const src = `
      pipeline sum(nums: list) -> num {
        const total = 0
        for n in nums {
          const total = total + n
        }
        return total
      }`;
    const { value } = await run(src, "sum", { nums: [1, 2, 3, 4] }, stubModel());
    expect(value).toBe(0);
  });

  it("let propagates mutations out of if blocks", async () => {
    const src = `
      pipeline check(x: num) -> text {
        let result = "small"
        if x > 10 {
          let result = "big"
        }
        return result
      }`;
    const { value } = await run(src, "check", { x: 20 }, stubModel());
    expect(value).toBe("big");
  });

  it("const does NOT propagate out of if blocks", async () => {
    const src = `
      pipeline check(x: num) -> text {
        const result = "small"
        if x > 10 {
          const result = "big"
        }
        return result
      }`;
    const { value } = await run(src, "check", { x: 20 }, stubModel());
    expect(value).toBe("small");
  });

  it("let accumulator works across nested if inside for", async () => {
    const src = `
      pipeline count_big(nums: list) -> num {
        let count = 0
        for n in nums {
          if n > 5 {
            let count = count + 1
          }
        }
        return count
      }`;
    const { value } = await run(src, "count_big", { nums: [1, 8, 3, 9, 2, 7] }, stubModel());
    expect(value).toBe(3);
  });

  it("const inside loop stays local per iteration", async () => {
    const src = `
      pipeline collect(items: list) -> list {
        for item in items into results {
          const doubled = item * 2
          emit doubled
        }
        return results
      }`;
    const { value } = await run(src, "collect", { items: [1, 2, 3] }, stubModel());
    expect(value).toEqual([2, 4, 6]);
  });

  it("let does not propagate new variables that did not exist in outer scope", async () => {
    const src = `
      pipeline test(x: num) -> num {
        let a = 1
        if x > 0 {
          let a = 99
          let b = 42
        }
        return a
      }`;
    const { value } = await run(src, "test", { x: 5 }, stubModel());
    expect(value).toBe(99);
    // b should not exist in outer scope — it was new, not a rebinding
  });
});
