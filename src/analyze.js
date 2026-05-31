// Static analyzer. Walks every branch without calling any model.
// Uses the actual baked-in prompt templates to estimate input tokens.
// Output estimates: best case from verb semantics, worst case from max_tokens.

import { buildPrompt } from "./verbs.js";

function tokensFromChars(n) {
  return Math.ceil(n / 4);
}

function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  return tokensFromChars(s.length);
}

// Best-case output: minimum the verb realistically needs to return.
function bestCaseOutput(verb, namedOpts) {
  switch (verb) {
    case "classify": {
      const cats = namedOpts.into;
      if (Array.isArray(cats) && cats.length > 0) {
        const shortest = cats.reduce(
          (a, b) => (String(a).length < String(b).length ? a : b),
          cats[0],
        );
        return Math.max(1, tokensFromChars(String(shortest).length));
      }
      return 1;
    }
    case "extract": {
      // realistic: {"field":"short value"} per field
      const fields = namedOpts.fields;
      const names = Array.isArray(fields) ? fields : ["field"];
      const sim =
        "{" + names.map((f) => `"${f}":"a short value"`).join(",") + "}";
      return tokensFromChars(sim.length);
    }
    case "compress": {
      // best case: a tight summary, maybe half the max
      const max = namedOpts.max;
      return max
        ? Math.max(3, Math.ceil(tokensFromChars(Number(max)) * 0.5))
        : 5;
    }
    case "rewrite":
      return 15;
    case "expand":
      return 30;
    case "generate": {
      const format = namedOpts.format;
      if (Array.isArray(format)) {
        const sim =
          "{" + format.map((f) => `"${f}":"brief content"`).join(",") + "}";
        return tokensFromChars(sim.length);
      }
      return 20;
    }
    default:
      return 5;
  }
}

function resolveNamedOpts(named) {
  const out = {};
  for (const [k, v] of Object.entries(named || {})) {
    if (v.kind === "Num") out[k] = v.value;
    else if (v.kind === "Str") out[k] = v.value;
    else if (v.kind === "List")
      out[k] = v.items.map((i) => (i.kind === "Sym" ? i.name : i.value));
  }
  return out;
}

function estimateModelCall(stmt, inputText, models, defaultModel) {
  const verb = stmt.value.callee;
  const alias = stmt.withModel || defaultModel;
  const model = alias && models[alias] ? models[alias] : null;
  const modelId = model?.id || alias || "default";
  const maxTokens = model?.max_tokens || 256;
  const namedOpts = resolveNamedOpts(stmt.value.named);

  // use the ACTUAL baked-in prompt template to measure input tokens
  const prompt = buildPrompt(verb, inputText, namedOpts);
  const inputTokens = estimateTokens(prompt);

  const outputBest = bestCaseOutput(verb, namedOpts);
  const outputWorst = maxTokens;

  return {
    verb,
    alias,
    modelId,
    inputTokens,
    outputBest,
    outputWorst,
    line: stmt.line,
    name: stmt.name,
  };
}

export function analyze(prog, args, onStep, entry) {
  if (!onStep) onStep = () => {};
  const init = prog.init || { models: {}, settings: {} };
  const models = { ...init.models };
  const defaultModel = Object.keys(models)[0] || null;
  const budget = init.budget || prog.init?.budget || null;

  let pipe;
  let entryAgent = null;
  if (!entry || entry === "main") {
    if (prog.main) {
      pipe = { name: "main", params: prog.main.params, body: prog.main.body };
    } else {
      pipe = prog.pipelines[prog.pipelines.length - 1];
    }
  } else {
    pipe = prog.pipelines.find((p) => p.name === entry);
    if (!pipe) {
      entryAgent = (prog.agents || []).find((a) => a.name === entry);
    }
  }
  if (!pipe && !entryAgent) {
    onStep({ type: "error", message: "no pipeline, agent, or main found" });
    return [];
  }

  // use the actual input text for prompt estimation
  const inputText = typeof args === "string" ? args : JSON.stringify(args);

  // if entry is an agent, wrap it as a synthetic pipeline that calls the agent
  if (entryAgent && !pipe) {
    pipe = {
      name: entryAgent.name,
      params: entryAgent.params,
      body: entryAgent.loopBody,
      _isAgent: true,
      _maxIter: entryAgent.maxIter,
    };
  }

  onStep({
    type: "analyze:start",
    pipeline: pipe.name,
    inputSize: estimateTokens(inputText),
  });

  function walkBlock(body, path, depth) {
    for (const stmt of body) walkStmt(stmt, path, depth);
  }

  function addModelStep(stmt, path, depth) {
    const est = estimateModelCall(stmt, inputText, models, defaultModel);
    const step = {
      type: "model",
      line: est.line,
      name: est.name,
      verb: est.verb,
      model: est.alias,
      modelId: est.modelId,
      inputTokens: est.inputTokens,
      outputBest: est.outputBest,
      outputWorst: est.outputWorst,
      depth,
    };
    path.steps.push(step);
  }

  // track visited callables to prevent infinite recursion
  const visiting = new Set();

  // walk into a call expression — if it's a pipeline/function/agent, walk its body
  function walkCallExpr(expr, path, depth) {
    if (!expr || expr.kind !== "Call") return;
    const name = expr.callee;
    if (visiting.has(name)) return; // prevent cycles
    visiting.add(name);
    // pipeline call
    const calledPipe = prog.pipelines.find((p) => p.name === name);
    if (calledPipe) {
      walkBlock(calledPipe.body, path, depth);
      visiting.delete(name);
      return;
    }
    // function call
    const calledFunc = (prog.functions || []).find((f) => f.name === name);
    if (calledFunc) {
      walkBlock(calledFunc.body, path, depth);
      visiting.delete(name);
      return;
    }
    // agent call — best case: 1 iteration (cheapest branch), worst case: maxIter × costliest branch
    const calledAgent = (prog.agents || []).find((a) => a.name === name);
    if (calledAgent) {
      const agentRoot = { label: "agent-iter", steps: [], children: [] };
      walkBlock(calledAgent.loopBody, agentRoot, depth);

      // collect all single-iteration paths
      const iterPaths = [];
      (function collectIter(node, acc) {
        const cur = [...acc, ...node.steps];
        if (node.children.length === 0) iterPaths.push(cur);
        else node.children.forEach(ch => collectIter(ch, cur));
      })(agentRoot, []);

      const costOf = (steps) => {
        let t = 0;
        for (const s of steps) if (s.type === "model") t += s.inputTokens + s.outputWorst;
        return t;
      };
      iterPaths.sort((a, b) => costOf(a) - costOf(b));

      // best case: 1 iteration, cheapest branch
      const bestChild = { label: "agent-best", steps: [...iterPaths[0]], children: [] };
      path.children.push(bestChild);

      // worst case: maxIter iterations, costliest branch each time
      const worst = iterPaths[iterPaths.length - 1];
      const worstChild = { label: "agent-worst", steps: [], children: [] };
      for (let i = 0; i < calledAgent.maxIter; i++) {
        for (const s of worst) worstChild.steps.push({...s});
      }
      path.children.push(worstChild);
      visiting.delete(name);
      return;
    }
    visiting.delete(name);
  }

  function walkStmt(stmt, path, depth) {
    switch (stmt.kind) {
      case "Let":
        if (stmt.fuzzy) {
          // check if it's a custom prompt or builtin verb
          addModelStep(stmt, path, depth);
        } else {
          path.steps.push({
            type: "code",
            line: stmt.line,
            name: stmt.name,
            depth,
          });
          // if the value is a call to a pipeline/function/agent, walk into it
          walkCallExpr(stmt.value, path, depth);
        }
        break;
      case "Parallel":
        for (const s of stmt.stmts) addModelStep(s, path, depth);
        break;
      case "If": {
        const thenPath = { label: "then", steps: [], children: [] };
        path.children.push(thenPath);
        walkBlock(stmt.then, thenPath, depth + 1);
        if (stmt.else.length > 0) {
          const elsePath = { label: "else", steps: [], children: [] };
          path.children.push(elsePath);
          walkBlock(stmt.else, elsePath, depth + 1);
        }
        break;
      }
      case "Match": {
        for (const c of stmt.cases) {
          const casePath = { label: "case", steps: [], children: [] };
          path.children.push(casePath);
          walkBlock(c.body, casePath, depth + 1);
        }
        if (stmt.fallback) {
          const elsePath = { label: "else", steps: [], children: [] };
          path.children.push(elsePath);
          walkBlock(stmt.fallback, elsePath, depth + 1);
        }
        break;
      }
      case "For":
        walkBlock(stmt.body, path, depth);
        break;
      case "Try":
        walkBlock(stmt.tryBody, path, depth);
        break;
      case "Return":
        path.steps.push({ type: "return", depth });
        break;
      case "ExprStmt":
        // expression statements might be pipeline/function calls
        walkCallExpr(stmt.expr, path, depth);
        break;
      default:
        break;
    }
  }

  const root = { label: "root", steps: [], children: [] };
  walkBlock(pipe.body, root, 0);

  // if entry was an agent, expand the single-iteration paths into best/worst
  if (pipe._isAgent) {
    const iterResults = [];
    (function collectIter(node, acc) {
      const cur = [...acc, ...node.steps];
      if (node.children.length === 0) iterResults.push(cur);
      else node.children.forEach(ch => collectIter(ch, cur));
    })(root, []);

    const costOf = (steps) => {
      let t = 0;
      for (const s of steps) if (s.type === "model") t += s.inputTokens + s.outputWorst;
      return t;
    };
    iterResults.sort((a, b) => costOf(a) - costOf(b));

    // rebuild root with best (1 iter, cheapest) and worst (maxIter, costliest)
    root.steps = [];
    root.children = [];
    root.children.push({ label: "agent-best", steps: [...iterResults[0]], children: [] });
    const worst = iterResults[iterResults.length - 1];
    const worstChild = { label: "agent-worst", steps: [], children: [] };
    for (let i = 0; i < pipe._maxIter; i++) {
      for (const s of worst) worstChild.steps.push({...s});
    }
    root.children.push(worstChild);
  }

  // collect all paths
  const results = [];
  function collectPaths(node, accumulated) {
    const current = [...accumulated, ...node.steps];
    if (node.children.length === 0) {
      results.push({ steps: current });
    } else {
      for (const child of node.children) collectPaths(child, current);
    }
  }
  collectPaths(root, []);

  // summarize each path with per-model breakdown
  const summaries = results.map(({ steps }) => {
    let modelCalls = 0,
      codeSteps = 0;
    const byModel = {};
    for (const s of steps) {
      if (s.type === "model") {
        modelCalls++;
        const key = s.model || "default";
        if (!byModel[key])
          byModel[key] = { calls: 0, inputTokens: 0, bestOut: 0, worstOut: 0 };
        byModel[key].calls++;
        byModel[key].inputTokens += s.inputTokens;
        byModel[key].bestOut += s.outputBest;
        byModel[key].worstOut += s.outputWorst;
      } else if (s.type === "code") {
        codeSteps++;
      }
    }
    let bestTokens = 0,
      worstTokens = 0;
    for (const m of Object.values(byModel)) {
      bestTokens += m.inputTokens + m.bestOut;
      worstTokens += m.inputTokens + m.worstOut;
    }

    // budget check
    let budgetWarning = null;
    if (budget?.max_tokens && worstTokens > budget.max_tokens) {
      budgetWarning = `worst case ${worstTokens} exceeds budget of ${budget.max_tokens}`;
    }

    return {
      steps,
      modelCalls,
      codeSteps,
      byModel,
      bestTokens,
      worstTokens,
      budgetWarning,
    };
  });

  // deduplicate paths with identical model call sequences
  const seen = new Set();
  const deduped = summaries.filter((p) => {
    const key = p.steps
      .filter((s) => s.type === "model")
      .map((s) => s.verb + "@" + s.model + ":" + s.line)
      .join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  onStep({ type: "analyze:done", paths: deduped });
  return deduped;
}
