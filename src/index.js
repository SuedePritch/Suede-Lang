let readFileSync, resolve, dirname;
try {
  ({ readFileSync } = await import("fs"));
  ({ resolve, dirname } = await import("path"));
} catch {}
import { lex } from "./lexer.js";
import { parse } from "./parser.js";
import { Interpreter } from "./interpreter.js";

export { lex } from "./lexer.js";
export { parse } from "./parser.js";
export { Interpreter, RuntimeError, SuedeError } from "./interpreter.js";
export { asJson } from "./verbs.js";
export { check } from "./check.js";

export function compile(src, basePath) {
  const prog = parse(lex(src));
  if (prog.imports?.length && basePath) {
    resolveImports(prog, basePath, new Set());
  }
  return prog;
}

// Browser-friendly compile: resolves imports from a Map of filename → source.
export function compileWithFiles(src, files) {
  const prog = parse(lex(src));
  if (prog.imports?.length && files) {
    resolveImportsFromMap(prog, files, new Set());
  }
  return prog;
}

function resolveImportsFromMap(prog, files, seen) {
  for (const imp of prog.imports) {
    const path = imp.path.replace(/^\.\//, "");
    if (seen.has(path)) continue;
    seen.add(path);

    const src = files.get(path) || files.get("./" + path);
    if (!src) {
      throw new Error(
        `import error: file '${imp.path}' not found (available: ${[...files.keys()].join(", ")}) at line ${imp.line}`,
      );
    }

    const dep = parse(lex(src));
    if (dep.imports?.length) resolveImportsFromMap(dep, files, seen);

    const isNamespace = imp.names.length === 1 && imp.names[0].isNamespace;

    if (isNamespace) {
      for (const p of dep.pipelines) prog.pipelines.push(p);
      for (const a of dep.agents || []) prog.agents.push(a);
      for (const f of dep.functions || []) prog.functions.push(f);
      for (const p of dep.prompts || []) prog.prompts.push(p);
    } else {
      const wanted = new Set(imp.names.map((n) => n.name));
      for (const p of dep.pipelines) {
        if (wanted.has(p.name)) {
          const alias = imp.names.find((n) => n.name === p.name)?.alias || p.name;
          prog.pipelines.push(alias !== p.name ? { ...p, name: alias } : p);
        }
      }
      for (const a of dep.agents || []) {
        if (wanted.has(a.name)) {
          const alias = imp.names.find((n) => n.name === a.name)?.alias || a.name;
          prog.agents.push(alias !== a.name ? { ...a, name: alias } : a);
        }
      }
      for (const f of dep.functions || []) {
        if (wanted.has(f.name)) {
          const alias = imp.names.find((n) => n.name === f.name)?.alias || f.name;
          prog.functions.push(alias !== f.name ? { ...f, name: alias } : f);
        }
      }
      for (const p of dep.prompts || []) {
        if (wanted.has(p.name)) {
          const alias = imp.names.find((n) => n.name === p.name)?.alias || p.name;
          prog.prompts.push(alias !== p.name ? { ...p, name: alias } : p);
        }
      }
    }
  }
}

function resolveImports(prog, basePath, seen) {
  for (const imp of prog.imports) {
    const absPath = resolve(basePath, imp.path);
    if (seen.has(absPath)) continue;
    seen.add(absPath);

    let src;
    try {
      src = readFileSync(absPath, "utf-8");
    } catch {
      throw new Error(
        `import error: cannot read '${imp.path}' (resolved to ${absPath}) at line ${imp.line}`,
      );
    }

    const dep = parse(lex(src));
    // recursively resolve nested imports
    if (dep.imports?.length) resolveImports(dep, dirname(absPath), seen);

    const isNamespace = imp.names.length === 1 && imp.names[0].isNamespace;

    if (isNamespace) {
      // import everything — prefix names with namespace
      // but also make them available unprefixed for internal cross-references
      for (const p of dep.pipelines) prog.pipelines.push(p);
      for (const a of dep.agents || []) prog.agents.push(a);
      for (const f of dep.functions || []) prog.functions.push(f);
      for (const p of dep.prompts || []) prog.prompts.push(p);
    } else {
      // selective import — only pull in named items
      const wanted = new Set(imp.names.map((n) => n.name));
      for (const p of dep.pipelines) {
        if (wanted.has(p.name)) {
          const alias =
            imp.names.find((n) => n.name === p.name)?.alias || p.name;
          prog.pipelines.push(alias !== p.name ? { ...p, name: alias } : p);
        }
      }
      for (const a of dep.agents || []) {
        if (wanted.has(a.name)) {
          const alias =
            imp.names.find((n) => n.name === a.name)?.alias || a.name;
          prog.agents.push(alias !== a.name ? { ...a, name: alias } : a);
        }
      }
      for (const f of dep.functions || []) {
        if (wanted.has(f.name)) {
          const alias =
            imp.names.find((n) => n.name === f.name)?.alias || f.name;
          prog.functions.push(alias !== f.name ? { ...f, name: alias } : f);
        }
      }
      for (const p of dep.prompts || []) {
        if (wanted.has(p.name)) {
          const alias =
            imp.names.find((n) => n.name === p.name)?.alias || p.name;
          prog.prompts.push(alias !== p.name ? { ...p, name: alias } : p);
        }
      }
    }
  }
}

// Run a .suede program.
// - entry: pipeline/agent name, or "main"/null to use the main block
// - modelFn: optional — if null, uses baked-in Gemini/Anthropic/OpenAI providers
// - onStep: optional callback for debugger events
export async function run(src, entry, args, modelFn, onStep, basePath) {
  // basePath can be a string (path) or an options object with tools, etc.
  let resolvedBasePath, options;
  if (typeof basePath === "object" && basePath !== null && !Array.isArray(basePath)) {
    options = basePath;
    resolvedBasePath = options.basePath || null;
  } else {
    resolvedBasePath = basePath || null;
    options = {};
  }
  const prog = compile(src, resolvedBasePath);
  const interp = new Interpreter(modelFn || null, onStep, options);
  const value = await interp.run(prog, entry, args);
  return { value, stats: interp.stats };
}

// Deterministic stub for tests — no API calls.
// Returns JSON objects matching each verb's contract.
export function stubModel(handlers = {}) {
  const defaults = {
    extract: { field: "value" },
    classify: { label: "default" },
    compress: { text: "compressed" },
    rewrite: { text: "rewritten" },
    expand: { text: "expanded" },
    generate: { text: "generated" },
  };
  return ({ prompt, verb, input }) => {
    const est = (x) =>
      Math.max(1, Math.ceil(JSON.stringify(x ?? "").length / 4));
    if (handlers[verb]) {
      const value = handlers[verb](prompt || input);
      return {
        value,
        inputTokens: est(prompt || input),
        outputTokens: est(value),
      };
    }
    return {
      value: defaults[verb] || { text: "result" },
      inputTokens: est(prompt || input),
      outputTokens: 5,
    };
  };
}
