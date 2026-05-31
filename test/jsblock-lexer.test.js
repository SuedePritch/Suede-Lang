import { describe, it, expect } from "vitest";
import { lex, TT } from "../src/lexer.js";

// helper: extract the JS body string from tokens
function jsBody(src) {
  const toks = lex(src);
  const jsIdx = toks.findIndex(t => t.type === TT.JS);
  if (jsIdx === -1) throw new Error("no JS token found");
  const bodyTok = toks[jsIdx + 1];
  if (bodyTok.type !== TT.STRING) throw new Error("expected STRING after JS, got " + bodyTok.type);
  return bodyTok.value;
}

// helper: wraps in a main so the lexer doesn't complain about bare js
function wrap(jsCode) {
  return `main(x: num) -> num {\n  let r = js {\n${jsCode}\n  }\n  return r\n}`;
}

describe("js block lexer — adversarial", () => {
  // ── strings ──────────────────────────────────────────────────────────

  describe("strings with braces", () => {
    it("double-quoted string with {}", () => {
      const body = jsBody(wrap('    return "{ } { }"'));
      expect(body).toContain('return "{ } { }"');
    });

    it("single-quoted string with {}", () => {
      const body = jsBody(wrap("    return '{ } { }'"));
      expect(body).toContain("return '{ } { }'");
    });

    it("escaped quote inside string before brace", () => {
      const body = jsBody(wrap('    return "say \\"}\\" ok"'));
      expect(body).toContain('return "say \\"}\\" ok"');
    });

    it("escaped backslash before closing quote", () => {
      // "test\\" — the \\ is an escaped backslash, then " closes the string
      const body = jsBody(wrap('    return "test\\\\"'));
      expect(body).toContain('return "test\\\\"');
    });

    it("empty string", () => {
      const body = jsBody(wrap('    return ""'));
      expect(body).toContain('return ""');
    });

    it("string with only a closing brace", () => {
      const body = jsBody(wrap('    return "}"'));
      expect(body).toContain('return "}"');
    });

    it("string with only an opening brace", () => {
      const body = jsBody(wrap('    return "{"'));
      expect(body).toContain('return "{"');
    });

    it("string with nested quotes", () => {
      const body = jsBody(wrap(`    return "he said 'hello { there }' ok"`));
      expect(body).toContain("he said 'hello { there }' ok");
    });
  });

  // ── template literals ────────────────────────────────────────────────

  describe("template literals", () => {
    it("basic template literal with expression", () => {
      const body = jsBody(wrap("    return `value: ${1 + 2}`"));
      expect(body).toContain("return `value: ${1 + 2}`");
    });

    it("template literal with object in expression", () => {
      const body = jsBody(wrap("    return `${JSON.stringify({ a: 1 })}`"));
      expect(body).toContain("JSON.stringify({ a: 1 })");
    });

    it("template literal with nested template literal", () => {
      const body = jsBody(wrap("    return `outer ${`inner ${x}`}`"));
      // this is genuinely hard — nested backticks in template expressions
      // the body should contain the full expression
      expect(body).toContain("outer");
      expect(body).toContain("inner");
    });

    it("template literal with braces outside expressions", () => {
      const body = jsBody(wrap("    return `{ not an expression }`"));
      expect(body).toContain("return `{ not an expression }`");
    });

    it("template literal spanning multiple lines", () => {
      const body = jsBody(wrap("    return `line1\n    line2\n    line3`"));
      expect(body).toContain("line1");
      expect(body).toContain("line3");
    });

    it("escaped backtick in template literal", () => {
      const body = jsBody(wrap("    return `hello \\` world`"));
      expect(body).toContain("return `hello \\` world`");
    });
  });

  // ── comments ─────────────────────────────────────────────────────────

  describe("comments", () => {
    it("line comment with closing brace", () => {
      const body = jsBody(wrap("    // }\n    return 1"));
      expect(body).toContain("return 1");
    });

    it("line comment with opening brace", () => {
      const body = jsBody(wrap("    // {\n    return 1"));
      expect(body).toContain("return 1");
    });

    it("block comment with closing brace", () => {
      const body = jsBody(wrap("    /* } */ return 1"));
      expect(body).toContain("return 1");
    });

    it("block comment with opening brace", () => {
      const body = jsBody(wrap("    /* { */ return 1"));
      expect(body).toContain("return 1");
    });

    it("block comment with multiple braces", () => {
      const body = jsBody(wrap("    /* { { } } } { */ return 1"));
      expect(body).toContain("return 1");
    });

    it("block comment spanning lines", () => {
      const body = jsBody(wrap("    /*\n    }\n    {\n    */\n    return 1"));
      expect(body).toContain("return 1");
    });

    it("line comment at end of block (no trailing newline)", () => {
      // this was a bug — comment at end eats the wrapper
      const body = jsBody(wrap("    return 1 // done }"));
      expect(body).toContain("return 1");
    });

    it("consecutive line comments", () => {
      const body = jsBody(wrap("    // }\n    // {\n    // }}}\n    return 1"));
      expect(body).toContain("return 1");
    });
  });

  // ── regex ────────────────────────────────────────────────────────────

  describe("regex literals", () => {
    it("regex with braces", () => {
      const body = jsBody(wrap("    const re = /\\{[^}]+\\}/\n    return re"));
      expect(body).toContain("/\\{[^}]+\\}/");
    });

    it("regex with quantifier braces", () => {
      const body = jsBody(wrap("    const re = /a{2,3}/\n    return re"));
      expect(body).toContain("/a{2,3}/");
    });

    it("division is not treated as regex", () => {
      const body = jsBody(wrap("    const a = 10\n    const b = a / 2\n    return b"));
      expect(body).toContain("a / 2");
    });

    it("regex after return", () => {
      const body = jsBody(wrap("    return /test{1}/"));
      expect(body).toContain("return /test{1}/");
    });

    it("regex after assignment", () => {
      const body = jsBody(wrap("    const r = /}{/\n    return r"));
      expect(body).toContain("const r = /}{/");
    });

    it("regex with flags", () => {
      const body = jsBody(wrap("    const r = /test{}/gi\n    return r"));
      expect(body).toContain("/test{}/gi");
    });
  });

  // ── nested structures ────────────────────────────────────────────────

  describe("nested structures", () => {
    it("deeply nested objects", () => {
      const body = jsBody(wrap("    return { a: { b: { c: { d: 1 } } } }"));
      expect(body).toContain("{ a: { b: { c: { d: 1 } } } }");
    });

    it("arrow function with block body", () => {
      const body = jsBody(wrap("    const fn = (x) => { return { v: x } }\n    return fn(1)"));
      expect(body).toContain("=> { return { v: x } }");
    });

    it("if/else with braces", () => {
      const body = jsBody(wrap("    if (x > 0) { return 1 } else { return -1 }"));
      expect(body).toContain("if (x > 0) { return 1 } else { return -1 }");
    });

    it("try/catch with braces", () => {
      const body = jsBody(wrap("    try { return JSON.parse('{') } catch(e) { return null }"));
      expect(body).toContain("try { return JSON.parse('{') } catch(e) { return null }");
    });

    it("for loop with braces", () => {
      const body = jsBody(wrap("    let s = 0\n    for (let i = 0; i < 3; i++) { s += i }\n    return s"));
      expect(body).toContain("for (let i = 0; i < 3; i++) { s += i }");
    });

    it("class with methods", () => {
      const body = jsBody(wrap("    class Foo { bar() { return 1 } }\n    return new Foo().bar()"));
      expect(body).toContain("class Foo { bar() { return 1 } }");
    });
  });

  // ── evil combinations ────────────────────────────────────────────────

  describe("evil combinations", () => {
    it("string with escaped backslash then brace", () => {
      // "\\" is an escaped backslash, then } should close... but it's outside the string
      const body = jsBody(wrap('    const s = "\\\\"\n    return s'));
      expect(body).toContain('const s = "\\\\"');
    });

    it("comment inside string is not a comment", () => {
      const body = jsBody(wrap('    return "// not a } comment"'));
      expect(body).toContain('"// not a } comment"');
    });

    it("string inside comment is not a string", () => {
      const body = jsBody(wrap('    // "}\n    return 1'));
      expect(body).toContain("return 1");
    });

    it("template literal with nested object destructuring", () => {
      const body = jsBody(wrap("    const { a, b } = { a: 1, b: 2 }\n    return `${a}${b}`"));
      expect(body).toContain("const { a, b } = { a: 1, b: 2 }");
    });

    it("regex followed by object literal", () => {
      const body = jsBody(wrap("    const match = /}/.test('}')\n    return { match }"));
      expect(body).toContain("return { match }");
    });

    it("all the tricky things at once", () => {
      const code = [
        '    // comment with }',
        '    /* block { comment } */',
        '    const s1 = "string with }"',
        "    const s2 = 'string with {'",
        "    const s3 = `template ${'{}'}`",
        '    const obj = { a: { b: 1 } }',
        '    const fn = () => { return {} }',
        '    return { s1, s2, s3, obj, fn: fn() }',
      ].join("\n");
      const body = jsBody(wrap(code));
      expect(body).toContain("return { s1, s2, s3, obj, fn: fn() }");
    });
  });

  // ── error cases ──────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws on unterminated js block", () => {
      expect(() => lex("main(x: num) -> num { let r = js { return 1")).toThrow(/unterminated/);
    });

    it("throws when missing opening brace", () => {
      expect(() => lex("main(x: num) -> num { let r = js return 1 }")).toThrow(/expected '\{' after 'js'/);
    });
  });
});
