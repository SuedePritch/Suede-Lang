// Browser bundle entry point — exports everything needed for the playground
// We re-export only the browser-safe parts.

import { lex } from "./src/lexer.js";
import { parse } from "./src/parser.js";
import { Interpreter } from "./src/interpreter.js";
import { analyze } from "./src/analyze.js";
import { check } from "./src/check.js";

function resolveRelativePath(from, importPath) {
  const fromParts = from.split("/");
  fromParts.pop();
  const impParts = importPath.replace(/^\.\//, "").split("/");
  const resolved = [...fromParts];
  for (const part of impParts) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return resolved.join("/");
}

function resolveImportsFromMap(prog, files, seen, currentFile) {
  currentFile = currentFile || "";
  for (const imp of prog.imports) {
    const path = currentFile ? resolveRelativePath(currentFile, imp.path) : imp.path.replace(/^\.\//, "");
    if (seen.has(path)) continue;
    seen.add(path);
    const src = files.get(path) || files.get("./" + path);
    if (!src) {
      throw new Error(
        `import error: file '${imp.path}' not found (available: ${[...files.keys()].join(", ")}) at line ${imp.line}`,
      );
    }
    const dep = parse(lex(src));
    if (dep.imports?.length) resolveImportsFromMap(dep, files, seen, path);

    // always merge types, errors, and init
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

    // merge all callables
    for (const p of dep.pipelines) prog.pipelines.push(p);
    for (const a of dep.agents || []) prog.agents.push(a);
    for (const f of dep.functions || []) prog.functions.push(f);
    for (const p of dep.prompts || []) prog.prompts.push(p);
  }
}

function compileWithFiles(src, files, currentFile) {
  const prog = parse(lex(src));
  if (prog.imports?.length && files) {
    resolveImportsFromMap(prog, files, new Set(), currentFile || "");
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

// Browser-friendly run
async function run(src, entry, args, modelFn, onStep, options) {
  const files = options?.files || new Map();
  const prog = compileWithFiles(src, files, options?.currentFile || "");
  const interp = new Interpreter(modelFn || null, onStep, options || {});
  const value = await interp.run(prog, entry, args);
  return { value, stats: interp.stats };
}

window.Suede = { compileWithFiles, Interpreter, analyze, check, run };
