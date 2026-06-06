import { describe, it, expect } from "vitest";
import { run, stubModel } from "../src/index.js";

describe("variadic concat", () => {
  it("concat with 2 string args", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return concat("hello", " world")
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("hello world");
  });

  it("concat with 3 string args", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return concat("a", " ", "b")
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("a b");
  });

  it("concat with 5 string args", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return concat("one", "-", "two", "-", "three")
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("one-two-three");
  });

  it("concat with 2 list args", async () => {
    const src = `
      pipeline test(x: text) -> list {
        return concat([1, 2], [3, 4])
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toEqual([1, 2, 3, 4]);
  });

  it("concat with 3 list args", async () => {
    const src = `
      pipeline test(x: text) -> list {
        return concat([1], [2], [3])
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toEqual([1, 2, 3]);
  });

  it("concat with list and single item", async () => {
    const src = `
      pipeline test(x: text) -> list {
        let items = []
        let items = concat(items, ["a"])
        let items = concat(items, ["b"])
        let items = concat(items, ["c"])
        return items
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toEqual(["a", "b", "c"]);
  });
});
