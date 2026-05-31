// Browser bundle entry point — exports everything needed for the playground
// We re-export only the browser-safe parts. The Node.js fs/path imports
// in index.js are handled by esbuild's external + define.

import { lex } from "./src/lexer.js";
import { parse } from "./src/parser.js";
import { Interpreter } from "./src/interpreter.js";
import { analyze } from "./src/analyze.js";
import { check } from "./src/check.js";

// Browser-only compileWithFiles (no fs needed)
function compileWithFiles(src, files) {
  const prog = parse(lex(src));
  if (prog.imports?.length && files) {
    resolveImportsFromMap(prog, files, new Set());
  }
  return prog;
}

// Browser-friendly run — compile + interpret in one call
async function run(src, entry, args, modelFn, onStep, options) {
  const files = options?.files || new Map();
  const prog = compileWithFiles(src, files);
  const interp = new Interpreter(modelFn || null, onStep, options || {});
  const value = await interp.run(prog, entry, args);
  return { value, stats: interp.stats };
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

window.Suede = { compileWithFiles, Interpreter, analyze, check, run };
