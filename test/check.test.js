import { describe, it, expect } from "vitest";
import { compile, check } from "../src/index.js";

function checkSrc(src) {
  const prog = compile(src);
  return check(prog);
}

describe("suede check", () => {
  it("passes clean code", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> obj {
        let domain = raw |> after("@")
        let info ~= extract(raw, fields: [name])
        return info
      }
    `);
    expect(issues).toHaveLength(0);
  });

  it("catches = on a model verb", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> obj {
        let info = extract(raw, fields: [name])
        return info
      }
    `);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain("model verb");
    expect(issues[0].message).toContain("~=");
  });

  it("catches ~= on a non-model function", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> text {
        let x ~= trim(raw)
        return x
      }
    `);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain("not a model verb");
  });

  it("catches missing 'fields:' on extract", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> obj {
        let info ~= extract(raw)
        return info
      }
    `);
    expect(issues.some(i => i.message.includes("fields:"))).toBe(true);
  });

  it("catches missing 'into:' on classify", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> obj {
        let cat ~= classify(raw)
        return cat
      }
    `);
    expect(issues.some(i => i.message.includes("into:"))).toBe(true);
  });

  it("catches undefined model alias in 'with'", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> obj {
        let info ~= extract(raw, fields: [name]) with nonexistent
        return info
      }
    `);
    expect(issues.some(i => i.message.includes("nonexistent"))).toBe(true);
  });

  it("accepts defined model alias", () => {
    const issues = checkSrc(`
      init {
        model fast = "claude-haiku-4-5-20251001" {
          provider = "anthropic"
        }
      }
      pipeline go(raw: text) -> obj {
        let info ~= extract(raw, fields: [name]) with fast
        return info
      }
    `);
    expect(issues).toHaveLength(0);
  });

  it("catches use() outside an agent", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> obj {
        let r = use("tool", raw)
        return r
      }
    `);
    expect(issues.some(i => i.message.includes("use()"))).toBe(true);
  });

  it("allows use() inside an agent", () => {
    const issues = checkSrc(`
      function search_kb(query: text) -> text {
        return query
      }
      agent bot(q: text) -> text max 3 {
        tools {
          search_kb(query: text) -> text
        }
        loop {
          let r = use("search_kb", q)
          return r
        }
      }
    `);
    expect(issues).toHaveLength(0);
  });

  it("catches multiple issues at once", () => {
    const issues = checkSrc(`
      pipeline go(raw: text) -> obj {
        let a = classify(raw, into: [x, y])
        let b ~= trim(raw)
        let c ~= extract(raw)
        return c
      }
    `);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  // ── throw / catch checks ──────────────────────────────────────────
  it("warns when calling a pipeline that throws without catching", () => {
    const issues = checkSrc(`
      error NotFound {
        query: text
      }
      pipeline find(q: text) -> obj {
        throw NotFound("nope", query: q)
      }
      pipeline go(text: text) -> obj {
        let result = find(text)
        return result
      }
    `);
    expect(issues.some(i => i.message.includes("NotFound") && i.message.includes("not caught"))).toBe(true);
  });

  it("no warning when throw is caught", () => {
    const issues = checkSrc(`
      error NotFound {
        query: text
      }
      pipeline find(q: text) -> obj {
        throw NotFound("nope", query: q)
      }
      pipeline go(text: text) -> obj {
        try {
          let result = find(text)
          return result
        } catch NotFound as err {
          return err
        }
      }
    `);
    expect(issues.filter(i => i.message.includes("NotFound") && i.message.includes("not caught"))).toHaveLength(0);
  });

  it("no warning when catch-all covers throwing pipeline", () => {
    const issues = checkSrc(`
      pipeline find(q: text) -> obj {
        throw "not found"
      }
      pipeline go(text: text) -> obj {
        try {
          let result = find(text)
          return result
        } catch err {
          return err
        }
      }
    `);
    expect(issues.filter(i => i.message.includes("not inside a try/catch"))).toHaveLength(0);
  });

  it("warns on undefined error type in throw", () => {
    const issues = checkSrc(`
      pipeline go(text: text) -> obj {
        throw Oops("bad")
      }
    `);
    expect(issues.some(i => i.message.includes("Oops") && i.message.includes("not defined"))).toBe(true);
  });
});
