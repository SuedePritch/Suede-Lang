import { describe, it, expect } from "vitest";
import { compile, compileWithFiles } from "../src/index.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config.suede discovery", () => {
  const tmpBase = join(tmpdir(), "suede-config-test-" + Date.now());

  // set up temp directories
  function setup() {
    mkdirSync(join(tmpBase, "sub"), { recursive: true });
  }

  function cleanup() {
    try { rmSync(tmpBase, { recursive: true }); } catch {}
  }

  it("finds config.suede in the same directory", () => {
    setup();
    try {
      writeFileSync(join(tmpBase, "config.suede"), `
        init {
          api_keys { gemini = "test-key" }
          model fast = "test-model" {
            provider = "gemini"
            temperature = 0.5
            max_tokens = 100
          }
        }
      `);
      writeFileSync(join(tmpBase, "app.suede"), `
        pipeline hello(x: text) -> text {
          return x
        }
      `);
      const src = `pipeline hello(x: text) -> text { return x }`;
      const prog = compile(src, tmpBase);
      expect(prog.init).toBeTruthy();
      expect(prog.init.models.fast).toBeTruthy();
      expect(prog.init.models.fast.id).toBe("test-model");
    } finally {
      cleanup();
    }
  });

  it("walks up to find config.suede in parent directory", () => {
    setup();
    try {
      writeFileSync(join(tmpBase, "config.suede"), `
        init {
          api_keys { gemini = "test-key" }
          model smart = "parent-model" {
            provider = "gemini"
            temperature = 0.7
            max_tokens = 4096
          }
        }
      `);
      const src = `pipeline hello(x: text) -> text { return x }`;
      const prog = compile(src, join(tmpBase, "sub"));
      expect(prog.init).toBeTruthy();
      expect(prog.init.models.smart).toBeTruthy();
      expect(prog.init.models.smart.id).toBe("parent-model");
    } finally {
      cleanup();
    }
  });

  it("does not pick up config if file already has init", () => {
    setup();
    try {
      writeFileSync(join(tmpBase, "config.suede"), `
        init {
          api_keys { gemini = "config-key" }
          model fast = "config-model" {
            provider = "gemini"
            temperature = 0.2
            max_tokens = 100
          }
        }
      `);
      const src = `
        init {
          api_keys { gemini = "inline-key" }
          model fast = "inline-model" {
            provider = "gemini"
            temperature = 0.9
            max_tokens = 200
          }
        }
        pipeline hello(x: text) -> text { return x }
      `;
      const prog = compile(src, tmpBase);
      expect(prog.init.models.fast.id).toBe("inline-model");
    } finally {
      cleanup();
    }
  });

  it("compileWithFiles finds config.suede in file map", () => {
    const files = new Map([
      ["config.suede", `
        init {
          api_keys { gemini = "map-key" }
          model fast = "map-model" {
            provider = "gemini"
            temperature = 0.3
            max_tokens = 512
          }
        }
      `],
      ["app.suede", `
        pipeline hello(x: text) -> text { return x }
      `],
    ]);
    const prog = compileWithFiles(files.get("app.suede"), files);
    expect(prog.init).toBeTruthy();
    expect(prog.init.models.fast.id).toBe("map-model");
  });

  it("errors on malformed config.suede", () => {
    setup();
    try {
      writeFileSync(join(tmpBase, "config.suede"), `init { this is broken`);
      const src = `pipeline hello(x: text) -> text { return x }`;
      expect(() => compile(src, tmpBase)).toThrow("config.suede");
    } finally {
      cleanup();
    }
  });
});
