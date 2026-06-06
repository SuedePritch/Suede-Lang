import { describe, it, expect } from "vitest";
import { run, stubModel } from "../src/index.js";

describe("string escape sequences", () => {
  it("\\n produces a real newline", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return concat("hello", "\\n", "world")
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("hello\nworld");
  });

  it("\\n\\n produces double newline", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return concat("a", "\\n\\n", "b")
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("a\n\nb");
  });

  it("\\t produces a tab", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return concat("col1", "\\t", "col2")
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("col1\tcol2");
  });

  it("escaped quote inside string", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return "she said \\"hello\\""
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe('she said "hello"');
  });

  it("escaped backslash", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return "path\\\\to\\\\file"
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("path\\to\\file");
  });

  it("newlines work in concat with multiple args", async () => {
    const src = `
      pipeline test(x: text) -> text {
        return concat("hook", "\\n\\n", "body", "\\n\\n", "cta")
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe("hook\n\nbody\n\ncta");
  });

  it("split on newline works", async () => {
    const src = `
      pipeline test(x: text) -> num {
        let text = concat("line1", "\\n", "line2", "\\n", "line3")
        let lines = split(text, "\\n")
        return len(lines)
      }`;
    const { value } = await run(src, "test", { x: "" }, stubModel());
    expect(value).toBe(3);
  });
});
