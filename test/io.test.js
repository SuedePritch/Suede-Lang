import { describe, it, expect, vi } from "vitest";
import { run, stubModel } from "../src/index.js";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("I/O builtins", () => {
  // ── env ────────────────────────────────────────────────────────────
  it("env() reads an environment variable", async () => {
    process.env.__SUEDE_TEST_KEY = "hello123";
    const src = `
      pipeline check(x: text) -> text {
        let val = env("__SUEDE_TEST_KEY")
        return val
      }`;
    const { value } = await run(src, "check", { x: "" }, stubModel());
    expect(value).toBe("hello123");
    delete process.env.__SUEDE_TEST_KEY;
  });

  it("env() returns null for missing keys", async () => {
    const src = `
      pipeline check(x: text) -> any {
        let val = env("__SUEDE_NONEXISTENT_KEY")
        return val
      }`;
    const { value } = await run(src, "check", { x: "" }, stubModel());
    expect(value).toBe(null);
  });

  // ── read ───────────────────────────────────────────────────────────
  it("read() reads a file to text", async () => {
    const tmp = join(tmpdir(), "suede-test-read.txt");
    writeFileSync(tmp, "file contents here");
    const src = `
      pipeline check(path: text) -> text {
        let data = read(path)
        return data
      }`;
    const { value } = await run(src, "check", { path: tmp }, stubModel());
    expect(value).toBe("file contents here");
    unlinkSync(tmp);
  });

  // ── fetch ──────────────────────────────────────────────────────────
  it("fetch() makes a GET request", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('{"items":[1,2,3]}'),
    });
    const src = `
      pipeline check(url: text) -> obj {
        let res = fetch(url)
        return res
      }`;
    const { value } = await run(src, "check", { url: "https://example.com/api" }, stubModel());
    expect(value.status).toBe(200);
    expect(value.body).toBe('{"items":[1,2,3]}');
    expect(globalThis.fetch).toHaveBeenCalledWith("https://example.com/api", {
      method: "GET",
      headers: {},
    });
    globalThis.fetch = original;
  });

  it("fetch() supports POST with body and method", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 201,
      text: () => Promise.resolve('{"id":42}'),
    });
    const src = `
      pipeline check(url: text) -> obj {
        let res = fetch(url, method: "POST", body: "hello")
        return res
      }`;
    const { value } = await run(src, "check", { url: "https://example.com/api" }, stubModel());
    expect(value.status).toBe(201);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://example.com/api", {
      method: "POST",
      headers: {},
      body: "hello",
    });
    globalThis.fetch = original;
  });

  it("fetch() supports auth shorthand", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve("ok"),
    });
    const src = `
      pipeline check(url: text) -> obj {
        let res = fetch(url, auth: "Bearer tok123")
        return res
      }`;
    await run(src, "check", { url: "https://example.com/api" }, stubModel());
    expect(globalThis.fetch).toHaveBeenCalledWith("https://example.com/api", {
      method: "GET",
      headers: { Authorization: "Bearer tok123" },
    });
    globalThis.fetch = original;
  });

  // ── fetch piped into model verb ────────────────────────────────────
  it("fetch result pipes into a model verb naturally", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve("James applied for a $50k loan"),
    });
    const model = stubModel({
      extract: () => ({ name: "James", amount: 50000 }),
    });
    const src = `
      pipeline check(url: text) -> obj {
        let res = fetch(url)
        let parsed ~= extract(res.body, fields: [name, amount])
        return parsed
      }`;
    const { value } = await run(src, "check", { url: "https://example.com" }, model);
    expect(value.name).toBe("James");
    expect(value.amount).toBe(50000);
    globalThis.fetch = original;
  });
});
