// Static checker. Catches common mistakes without running anything.
// Runs after parsing — operates on the AST.

import { MODEL_VERBS } from "./verbs.js";
import { BUILTINS, IO_BUILTINS } from "./builtins.js";

const ALL_BUILTINS = new Set([...Object.keys(BUILTINS), ...Object.keys(IO_BUILTINS)]);

export function check(prog) {
  const errors = [];
  const warn = (line, msg) => errors.push({ line, message: msg });

  const modelAliases = prog.init ? new Set(Object.keys(prog.init.models)) : new Set();
  const pipelineNames = new Set(prog.pipelines.map(p => p.name));
  const agentNames = new Set((prog.agents || []).map(a => a.name));
  const functionNames = new Set((prog.functions || []).map(f => f.name));
  const promptNames = new Set((prog.prompts || []).map(p => p.name));
  const allCallables = new Set([...pipelineNames, ...agentNames, ...functionNames, ...promptNames, ...ALL_BUILTINS, ...MODEL_VERBS]);

  // required named args per verb
  const VERB_REQUIRED = {
    extract: ["fields"],
    classify: ["into"],
  };

  function checkBlock(body, scope, context) {
    for (const stmt of body) checkStmt(stmt, scope, context);
  }

  function checkExpr(expr, scope, context) {
    if (!expr) return;
    switch (expr.kind) {
      case "Var":
        if (!scope.has(expr.name)) {
          warn(expr.line || 0, `undefined variable '${expr.name}'`);
        }
        break;
      case "Call": {
        // check callee exists
        if (!allCallables.has(expr.callee) && expr.callee !== "map") {
          warn(expr.line || 0, `unknown function '${expr.callee}'`);
        }
        for (const a of expr.args) checkExpr(a, scope, context);
        for (const v of Object.values(expr.named || {})) checkExpr(v, scope, context);
        break;
      }
      case "Binary":
        checkExpr(expr.left, scope, context);
        checkExpr(expr.right, scope, context);
        break;
      case "Unary":
        checkExpr(expr.expr, scope, context);
        break;
      case "Pipe":
        checkExpr(expr.left, scope, context);
        checkExpr(expr.right, scope, context);
        break;
      case "Member":
        checkExpr(expr.obj, scope, context);
        break;
      case "Interp":
        for (const p of expr.parts) checkExpr(p, scope, context);
        break;
      case "Record":
        for (const v of Object.values(expr.fields)) checkExpr(v, scope, context);
        break;
      case "List":
        for (const i of expr.items) checkExpr(i, scope, context);
        break;
      case "Use":
        if (context.kind !== "agent") {
          warn(expr.line || 0, "use() can only be called inside an agent");
        }
        for (const a of expr.args) checkExpr(a, scope, context);
        break;
      case "Recurse":
        if (context.kind !== "pipeline") {
          warn(expr.line || 0, "recurse() can only be called inside a pipeline");
        }
        for (const a of expr.args) checkExpr(a, scope, context);
        break;
    }
  }

  function checkStmt(stmt, scope, context) {
    switch (stmt.kind) {
      case "Let": {
        if (stmt.fuzzy) {
          // ~= must call a model verb or custom prompt
          if (stmt.value.kind === "Call") {
            const verb = stmt.value.callee;
            if (!MODEL_VERBS.has(verb) && !promptNames.has(verb)) {
              warn(stmt.line, `'${verb}' is not a model verb — use '=' instead of '~='`);
            }
            // check required named args
            const required = VERB_REQUIRED[verb];
            if (required) {
              for (const r of required) {
                if (!stmt.value.named || !(r in stmt.value.named)) {
                  warn(stmt.line, `${verb}() requires '${r}:' — e.g. ${verb}(text, ${r}: [...])`);
                }
              }
            }
          }
          // check model alias
          if (stmt.withModel && !modelAliases.has(stmt.withModel)) {
            warn(stmt.line, `model '${stmt.withModel}' is not defined in init — available: ${[...modelAliases].join(", ") || "(none)"}`);
          }
        } else {
          // = must NOT call a model verb
          if (stmt.value.kind === "Call") {
            const callee = stmt.value.callee;
            if (MODEL_VERBS.has(callee) || promptNames.has(callee)) {
              warn(stmt.line, `'${callee}' is a model verb — use '~=' so its cost is visible`);
            }
          }
          checkExpr(stmt.value, scope, context);
        }
        // check fuzzy expr args too
        if (stmt.fuzzy && stmt.value.kind === "Call") {
          for (const a of stmt.value.args) checkExpr(a, scope, context);
          for (const v of Object.values(stmt.value.named || {})) checkExpr(v, scope, context);
        }
        if (stmt.guard) {
          const guardScope = new Set(scope);
          guardScope.add(stmt.name);
          checkExpr(stmt.guard, guardScope, context);
        }
        if (stmt.systemPrompt) checkExpr(stmt.systemPrompt, scope, context);
        scope.add(stmt.name);
        break;
      }
      case "If":
        checkExpr(stmt.cond, scope, context);
        checkBlock(stmt.then, new Set(scope), context);
        if (stmt.else.length) checkBlock(stmt.else, new Set(scope), context);
        break;
      case "For":
        checkExpr(stmt.iter, scope, context);
        const forScope = new Set(scope);
        forScope.add(stmt.varName);
        checkBlock(stmt.body, forScope, context);
        if (stmt.collectAs) scope.add(stmt.collectAs);
        break;
      case "Parallel":
        for (const s of stmt.stmts) checkStmt(s, scope, context);
        break;
      case "Return":
        checkExpr(stmt.value, scope, context);
        break;
      case "Emit":
        checkExpr(stmt.value, scope, context);
        break;
      case "Log":
        checkExpr(stmt.value, scope, context);
        break;
      case "Throw":
        checkExpr(stmt.message, scope, context);
        if (stmt.fields) {
          for (const v of Object.values(stmt.fields)) checkExpr(v, scope, context);
        }
        // check error type exists if typed
        if (stmt.errorType && prog.errors && !prog.errors[stmt.errorType]) {
          warn(stmt.line, `error type '${stmt.errorType}' is not defined — add an 'error ${stmt.errorType} { }' block`);
        }
        // track that this block can throw (for unhandled throw detection)
        if (!context._throws) context._throws = new Set();
        context._throws.add(stmt.errorType || "__bare__");
        break;
      case "Try":
        checkBlock(stmt.tryBody, new Set(scope), context);
        for (const c of stmt.catches) {
          const catchScope = new Set(scope);
          catchScope.add(c.errName);
          checkBlock(c.body, catchScope, context);
        }
        break;
      case "Match":
        checkExpr(stmt.expr, scope, context);
        for (const c of stmt.cases) {
          checkExpr(c.pattern, scope, context);
          checkBlock(c.body, new Set(scope), context);
        }
        if (stmt.fallback) checkBlock(stmt.fallback, new Set(scope), context);
        break;
      case "ExprStmt":
        checkExpr(stmt.expr, scope, context);
        break;
    }
  }

  // check pipelines
  const blockContexts = new Map(); // name -> context (with _throws)
  for (const pipe of prog.pipelines) {
    const scope = new Set(pipe.params.map(p => p.name));
    const ctx = { kind: "pipeline", name: pipe.name };
    checkBlock(pipe.body, scope, ctx);
    blockContexts.set(pipe.name, ctx);
  }

  // check main
  if (prog.main) {
    const scope = new Set(prog.main.params.map(p => p.name));
    const ctx = { kind: "pipeline", name: "main" };
    checkBlock(prog.main.body, scope, ctx);
    blockContexts.set("main", ctx);
  }

  // check agents
  for (const agent of (prog.agents || [])) {
    const scope = new Set(agent.params.map(p => p.name));
    // memory vars are in scope during loop
    for (const m of (agent.memory || [])) scope.add(m.name);
    // tools are available via use()
    scope.add("__tools__");
    const ctx = { kind: "agent", name: agent.name };
    checkBlock(agent.loopBody, scope, ctx);
    blockContexts.set(agent.name, ctx);
  }

  // check functions
  for (const func of (prog.functions || [])) {
    const scope = new Set(func.params.map(p => p.name));
    const ctx = { kind: "function", name: func.name };
    checkBlock(func.body, scope, ctx);
    blockContexts.set(func.name, ctx);
  }

  // ── Unhandled throw detection ──────────────────────────────────────
  // For each callable that throws, find call sites that don't catch.
  const throwsMap = new Map(); // callable name -> Set of error types it throws
  for (const [name, ctx] of blockContexts) {
    if (ctx._throws && ctx._throws.size > 0) throwsMap.set(name, ctx._throws);
  }

  if (throwsMap.size > 0) {
    // collect which error types a try/catch handles
    function getCaughtTypes(stmt) {
      if (stmt.kind !== "Try") return new Set();
      const caught = new Set();
      for (const c of stmt.catches) {
        if (c.errorType) caught.add(c.errorType);
        else caught.add("__all__"); // untyped catch catches everything
      }
      return caught;
    }

    // scan blocks for calls to throwing callables that aren't inside a try/catch
    function checkUnhandled(body, insideTryCaught) {
      for (const stmt of body) {
        switch (stmt.kind) {
          case "Let": {
            // check if the value is a call to a throwing callable
            const expr = stmt.value;
            if (expr && expr.kind === "Call" && throwsMap.has(expr.callee)) {
              const thrown = throwsMap.get(expr.callee);
              for (const errType of thrown) {
                if (errType === "__bare__") {
                  if (!insideTryCaught.has("__all__")) {
                    warn(stmt.line, `'${expr.callee}' can throw an error but is not inside a try/catch`);
                  }
                } else {
                  if (!insideTryCaught.has("__all__") && !insideTryCaught.has(errType)) {
                    warn(stmt.line, `'${expr.callee}' can throw '${errType}' but it is not caught — add catch ${errType} as err { }`);
                  }
                }
              }
            }
            break;
          }
          case "Try": {
            const caught = getCaughtTypes(stmt);
            checkUnhandled(stmt.tryBody, caught);
            for (const c of stmt.catches) checkUnhandled(c.body, insideTryCaught);
            break;
          }
          case "If":
            checkUnhandled(stmt.then, insideTryCaught);
            if (stmt.else.length) checkUnhandled(stmt.else, insideTryCaught);
            break;
          case "For":
            checkUnhandled(stmt.body, insideTryCaught);
            break;
          case "Parallel":
            for (const s of stmt.stmts) checkUnhandled([s], insideTryCaught);
            break;
          case "Match":
            for (const c of stmt.cases) checkUnhandled(c.body, insideTryCaught);
            if (stmt.fallback) checkUnhandled(stmt.fallback, insideTryCaught);
            break;
        }
      }
    }

    for (const pipe of prog.pipelines) checkUnhandled(pipe.body, new Set());
    if (prog.main) checkUnhandled(prog.main.body, new Set());
    for (const agent of (prog.agents || [])) checkUnhandled(agent.loopBody, new Set());
    for (const func of (prog.functions || [])) checkUnhandled(func.body, new Set());
  }

  // validate return types (post-import — types from imported files are now merged)
  const builtinTypes = new Set(["text", "num", "bool", "list", "obj", "any"]);
  const allBlocks = [...prog.pipelines, ...(prog.agents || []), ...(prog.functions || [])];
  if (prog.main && prog.main.returnType) allBlocks.push(prog.main);
  for (const block of allBlocks) {
    const rt = block.returnType;
    if (rt && !builtinTypes.has(rt) && !(prog.types && prog.types[rt])) {
      warn(block.body?.[0]?.line || 1, `return type '${rt}' is not defined — add a 'type ${rt} { ... }' block`);
    }
  }

  return errors;
}
