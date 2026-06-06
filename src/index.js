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

function findConfig(startDir) {
  if (!readFileSync || !resolve) return null;
  let dir = startDir;
  while (true) {
    try {
      const configPath = resolve(dir, "config.suede");
      const configSrc = readFileSync(configPath, "utf-8");
      return { src: configSrc, path: configPath };
    } catch { /* not here, keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

export function compile(src, basePath) {
  const prog = parse(lex(src));
  if (prog.imports?.length && basePath) {
    resolveImports(prog, basePath, new Set());
  }
  // convention: config.suede holds the init block
  // walks up from basePath like package.json / tsconfig.json
  if (!prog.init && basePath) {
    const config = findConfig(basePath);
    if (config) {
      try {
        const configProg = parse(lex(config.src));
        if (configProg.init) prog.init = configProg.init;
        if (configProg.types) {
          prog.types = prog.types || {};
          Object.assign(prog.types, configProg.types);
        }
        if (configProg.errors) {
          prog.errors = prog.errors || {};
          Object.assign(prog.errors, configProg.errors);
        }
      } catch (e) {
        throw new Error(`${config.path}: ${e.message}`);
      }
    }
  }
  return prog;
}

// Browser-friendly compile: resolves imports from a Map of filename → source.
export function compileWithFiles(src, files) {
  const prog = parse(lex(src));
  if (prog.imports?.length && files) {
    resolveImportsFromMap(prog, files, new Set());
  }
  // look for config.suede in the file map
  if (!prog.init && files) {
    const configSrc = files.get("config.suede") || files.get("./config.suede");
    if (configSrc) {
      try {
        const configProg = parse(lex(configSrc));
        if (configProg.init) prog.init = configProg.init;
        if (configProg.types) {
          prog.types = prog.types || {};
          Object.assign(prog.types, configProg.types);
        }
        if (configProg.errors) {
          prog.errors = prog.errors || {};
          Object.assign(prog.errors, configProg.errors);
        }
      } catch (e) {
        throw new Error(`config.suede: ${e.message}`);
      }
    }
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

    // always merge types, errors, and init — they're project-global
    if (dep.types) {
      prog.types = prog.types || {};
      Object.assign(prog.types, dep.types);
    }
    if (dep.errors) {
      prog.errors = prog.errors || {};
      Object.assign(prog.errors, dep.errors);
    }
    if (dep.init && !prog.init) {
      prog.init = dep.init;
    }

    // merge all callables — see resolveImports for rationale
    for (const p of dep.pipelines) prog.pipelines.push(p);
    for (const a of dep.agents || []) prog.agents.push(a);
    for (const f of dep.functions || []) prog.functions.push(f);
    for (const p of dep.prompts || []) prog.prompts.push(p);
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

    // always merge types, errors, and init — they're project-global
    if (dep.types) {
      prog.types = prog.types || {};
      Object.assign(prog.types, dep.types);
    }
    if (dep.errors) {
      prog.errors = prog.errors || {};
      Object.assign(prog.errors, dep.errors);
    }
    if (dep.init && !prog.init) {
      prog.init = dep.init;
    }

    // merge all callables — selective imports control what names are
    // public, but internally merged bodies may reference helpers from
    // the same source file, so the full set must be available
    for (const p of dep.pipelines) prog.pipelines.push(p);
    for (const a of dep.agents || []) prog.agents.push(a);
    for (const f of dep.functions || []) prog.functions.push(f);
    for (const p of dep.prompts || []) prog.prompts.push(p);
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
