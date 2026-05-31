import {
  MODEL_VERBS,
  buildPrompt,
  parseResponse,
  asJson,
  validateVerbContract,
  validateExpect,
} from "./verbs.js";
import { BUILTINS, IO_BUILTINS } from "./builtins.js";
import { callModel } from "./providers.js";
import { CallCache } from "./runtime.js";
import { AdaptiveThrottle } from "./throttle.js";

const RETURN = Symbol("return");
const EMIT = Symbol("emit");

export class RuntimeError extends Error {}

export class SuedeError extends Error {
  constructor(message, errorType, fields) {
    super(message);
    this.name = "SuedeError";
    this.errorType = errorType; // null for bare throws
    this.fields = fields || {};
  }
}

export class Interpreter {
  constructor(modelFn, onStep, options) {
    this.modelFn = modelFn; // optional override — if null, uses baked-in providers
    this.onStep = onStep || (() => {});
    this.hostTools = (options && options.tools) || {}; // host-provided tool implementations
    this.config = {
      settings: {},
      models: {},
      apiKeys: {},
      cacheConfig: null,
      budget: null,
    };
    this.stats = {
      modelCalls: 0,
      codeSteps: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      agentIterations: 0,
      cacheHits: 0,
      trace: [],
    };
    this.cache = null;
    this.throttle = new AdaptiveThrottle();
  }

  _checkType(prog, value, typeName, context) {
    if (!typeName) return;
    const BUILTIN = { text: "string", num: "number", bool: "boolean" };
    if (typeName === "any") return;
    if (typeName === "list") {
      if (!Array.isArray(value))
        throw new RuntimeError(`${context}: expected list, got ${typeof value}`);
      return;
    }
    if (typeName === "obj") {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new RuntimeError(`${context}: expected obj, got ${Array.isArray(value) ? "list" : typeof value}`);
      return;
    }
    if (BUILTIN[typeName]) {
      if (typeof value !== BUILTIN[typeName])
        throw new RuntimeError(`${context}: expected ${typeName}, got ${typeof value}`);
      return;
    }
    // custom type — validate against schema
    const schema = prog.types ? prog.types[typeName] : null;
    if (!schema) return; // no schema found, skip
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new RuntimeError(`${context}: expected ${typeName} (object), got ${Array.isArray(value) ? "list" : typeof value}`);
    for (const [field, type] of Object.entries(schema)) {
      if (!(field in value))
        throw new RuntimeError(`${context}: ${typeName} is missing required field '${field}'`);
      this._checkType(prog, value[field], type, `${context}.${field}`);
    }
    for (const k of Object.keys(value)) {
      if (!(k in schema))
        throw new RuntimeError(`${context}: ${typeName} has unexpected field '${k}'`);
    }
  }

  async run(prog, entry, args) {
    if (prog.init) {
      this.config.models = { ...prog.init.models };
      this.config.apiKeys = {};
      if (prog.init.apiKeys) {
        for (const [k, v] of Object.entries(prog.init.apiKeys)) {
          if (v.kind === "Call" && v.callee === "env") {
            const key = v.args[0]?.value;
            this.config.apiKeys[k] =
              (typeof process !== "undefined" && process.env?.[key]) ||
              `\${${key}}`;
          } else if (v.kind === "Str") {
            this.config.apiKeys[k] = v.value;
          }
        }
      }
      this.config.cacheConfig = prog.init.cacheConfig;
      this.config.budget = prog.init.budget;
      for (const [k, v] of Object.entries(prog.init.settings)) {
        if (v.kind === "Call" && v.callee === "env") {
          const key = v.args[0]?.value;
          this.config.settings[k] =
            (typeof process !== "undefined" && process.env?.[key]) ||
            `\${${key}}`;
        } else if (v.kind === "Str") {
          this.config.settings[k] = v.value;
        }
      }
      if (this.config.cacheConfig?.enabled) {
        this.cache = new CallCache(this.config.cacheConfig.ttl || 3600);
      }
    }

    // if entry is "main" or null, use the main block
    if ((!entry || entry === "main") && prog.main) {
      return this._runPipeline(
        prog,
        { params: prog.main.params, body: prog.main.body },
        args,
      );
    }

    const pipe = prog.pipelines.find((p) => p.name === entry);
    if (pipe) return this._runPipeline(prog, pipe, args);

    const agent = (prog.agents || []).find((a) => a.name === entry);
    if (agent) return this._runAgent(prog, agent, args);

    throw new RuntimeError(
      `no pipeline, agent, or main found for '${entry || "main"}'`,
    );
  }

  // ── Agent ─────────────────────────────────────────────────────────
  async _runAgent(prog, agent, args) {
    const scope = new Map();
    for (const p of agent.params) {
      if (p.name in args) {
        scope.set(p.name, args[p.name]);
        this._checkType(prog, args[p.name], p.type, `param '${p.name}'`);
      } else if (p.default) {
        scope.set(p.name, await this._evalExpr(prog, p.default, scope));
      } else {
        throw new RuntimeError(`missing argument '${p.name}'`);
      }
    }
    // tools are functions/pipelines defined in the same program
    const toolNames = agent.tools.map((t) => t.name);
    for (const name of toolNames) {
      const found =
        prog.pipelines.find((p) => p.name === name) ||
        (prog.functions || []).find((f) => f.name === name) ||
        (prog.agents || []).find((a) => a.name === name) ||
        this.hostTools[name];
      if (!found)
        throw new RuntimeError(
          `tool '${name}' is not a defined function, pipeline, agent, or host-provided tool`,
        );
    }
    scope.set("__tools__", toolNames);
    scope.set("__prog__", prog);

    // initialize memory — persistent state across loop iterations
    const memoryVars = agent.memory || [];
    const memoryStore = new Map();
    for (const m of memoryVars) {
      memoryStore.set(m.name, await this._evalExpr(prog, m.default, scope));
    }

    this.onStep({
      type: "agent:start",
      name: agent.name,
      maxIter: agent.maxIter,
    });
    for (let i = 0; i < agent.maxIter; i++) {
      this.stats.agentIterations++;
      this.onStep({
        type: "agent:iteration",
        iteration: i + 1,
        max: agent.maxIter,
      });
      const iterScope = new Map(scope);
      // inject memory into this iteration's scope
      for (const [k, v] of memoryStore) iterScope.set(k, v);

      const flow = await this._execBlock(prog, agent.loopBody, iterScope);

      // read back memory values (they may have been mutated)
      for (const m of memoryVars) {
        if (iterScope.has(m.name)) memoryStore.set(m.name, iterScope.get(m.name));
      }

      if (flow && flow[RETURN] !== undefined) {
        if (agent.returnType) {
          this._checkType(prog, flow[RETURN], agent.returnType, `return from agent '${agent.name}'`);
        }
        this.onStep({ type: "agent:end", name: agent.name, iterations: i + 1 });
        return flow[RETURN];
      }
    }
    throw new SuedeError(
      `agent '${agent.name}' hit max iterations (${agent.maxIter}) without returning`,
      "AgentMaxIterations",
      { agent: agent.name, max: agent.maxIter },
    );
  }

  // ── Pipeline ──────────────────────────────────────────────────────
  async _runPipeline(prog, pipe, args) {
    const scope = new Map();
    for (const p of pipe.params) {
      if (p.name in args) {
        scope.set(p.name, args[p.name]);
        this._checkType(prog, args[p.name], p.type, `param '${p.name}'`);
      } else if (p.default) {
        scope.set(p.name, await this._evalExpr(prog, p.default, scope));
      } else {
        throw new RuntimeError(`missing argument '${p.name}'`);
      }
    }
    const flow = await this._execBlock(prog, pipe.body, scope);
    const result = flow ? flow[RETURN] : undefined;
    if (pipe.returnType) {
      this._checkType(prog, result, pipe.returnType, `return from '${pipe.name || "pipeline"}'`);
    }
    return result;
  }

  async _execBlock(prog, body, scope) {
    for (const stmt of body) {
      const flow = await this._execStmt(prog, stmt, scope);
      if (flow) return flow;
    }
    return undefined;
  }

  _checkBudget() {
    if (!this.config.budget) return;
    const totalTokens = this.stats.inputTokens + this.stats.outputTokens;
    const maxTokens = this.config.budget.max_tokens;
    if (maxTokens && totalTokens >= maxTokens) {
      if (this.config.budget.on_exceed === "warn") {
        this.onStep({ type: "budget:warn", totalTokens, maxTokens });
      } else {
        throw new SuedeError(
          `budget exceeded: ${totalTokens} tokens used (max: ${maxTokens})`,
          "BudgetExceeded",
          { used: totalTokens, max: maxTokens },
        );
      }
    }
  }

  // ── Statement execution ───────────────────────────────────────────
  async _execStmt(prog, stmt, scope) {
    switch (stmt.kind) {
      case "Let": {
        if (stmt.fuzzy) {
          this._checkBudget();
          // resolve system prompt: per-call overrides init-level
          const systemPrompt = stmt.systemPrompt
            ? await this._evalExpr(prog, stmt.systemPrompt, scope)
            : this.config.settings.system || null;
          this.onStep({
            type: "model:start",
            line: stmt.line,
            name: stmt.name,
            verb: stmt.value.callee,
            withModel: stmt.withModel,
          });
          const start = Date.now();
          const maxRetries = stmt.retryCount || 0;
          const timeoutMs = stmt.timeout || null;
          let value, lastErr;
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              let fuzzyPromise = this._evalFuzzy(
                prog,
                stmt.value,
                scope,
                stmt.line,
                stmt.withModel,
                stmt.useCache,
                systemPrompt,
              );
              if (timeoutMs) {
                fuzzyPromise = Promise.race([
                  fuzzyPromise,
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new SuedeError(
                      `model call timed out after ${timeoutMs}ms (line ${stmt.line})`,
                      "TimedOut",
                      { timeout: timeoutMs, line: stmt.line },
                    )), timeoutMs)
                  ),
                ]);
              }
              value = await fuzzyPromise;
              // guard: validate the result semantically
              if (stmt.guard) {
                const guardScope = new Map(scope);
                guardScope.set(stmt.name, value);
                const ok = await this._evalExpr(prog, stmt.guard, guardScope);
                if (!ok) throw new RuntimeError(
                  `guard failed for '${stmt.name}' (line ${stmt.line})`,
                );
              }
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
              if (attempt < maxRetries) {
                this.onStep({
                  type: "retry",
                  line: stmt.line,
                  attempt: attempt + 1,
                  max: maxRetries,
                  error: e.message,
                });
              }
            }
          }
          if (lastErr) throw lastErr;
          if (stmt.expect) validateExpect(value, stmt.expect);
          scope.set(stmt.name, value);
          this.onStep({
            type: "model:end",
            line: stmt.line,
            name: stmt.name,
            verb: stmt.value.callee,
            withModel: stmt.withModel,
            value,
            ms: Date.now() - start,
          });
        } else {
          const value = await this._evalExpr(prog, stmt.value, scope);
          scope.set(stmt.name, value);
          this.stats.codeSteps++;
          this.stats.trace.push({ line: stmt.line, kind: "code" });
          this.onStep({
            type: "code",
            line: stmt.line,
            name: stmt.name,
            value,
          });
        }
        return undefined;
      }
      case "If": {
        const cond = await this._evalExpr(prog, stmt.cond, scope);
        this.onStep({
          type: "branch",
          line: stmt.cond.line,
          took: cond ? "then" : "else",
          cond,
        });
        return this._execBlock(
          prog,
          cond ? stmt.then : stmt.else,
          new Map(scope),
        );
      }
      case "For": {
        const iter = await this._evalExpr(prog, stmt.iter, scope);
        if (!Array.isArray(iter))
          throw new RuntimeError("for-loop target is not a list");
        this.onStep({
          type: "loop",
          varName: stmt.varName,
          count: iter.length,
          parallel: !!stmt.parallel,
        });
        if (stmt.parallel) {
          const promises = iter.map(async (item) => {
            const inner = new Map(scope);
            inner.set(stmt.varName, item);
            const flow = await this._execBlock(prog, stmt.body, inner);
            if (flow && flow[EMIT] !== undefined) return { emit: flow[EMIT] };
            if (flow && flow[RETURN] !== undefined) return { ret: flow[RETURN] };
            return {};
          });
          const results = await Promise.all(promises);
          const collected = [];
          for (const r of results) {
            if (r.emit !== undefined) collected.push(r.emit);
            if (r.ret !== undefined) return { [RETURN]: r.ret };
          }
          if (collected.length > 0 && stmt.collectAs)
            scope.set(stmt.collectAs, collected);
        } else {
          const collected = [];
          for (const item of iter) {
            const inner = new Map(scope);
            inner.set(stmt.varName, item);
            const flow = await this._execBlock(prog, stmt.body, inner);
            if (flow && flow[EMIT] !== undefined) collected.push(flow[EMIT]);
            else if (flow && flow[RETURN] !== undefined) return flow;
          }
          if (collected.length > 0 && stmt.collectAs)
            scope.set(stmt.collectAs, collected);
        }
        return undefined;
      }
      case "Return": {
        const value = await this._evalExpr(prog, stmt.value, scope);
        this.onStep({ type: "return", value });
        return { [RETURN]: value };
      }
      case "Parallel": {
        this.onStep({ type: "parallel:start", count: stmt.stmts.length });
        const promises = stmt.stmts.map(async (s) => {
          const inner = new Map(scope);
          const flow = await this._execStmt(prog, s, inner);
          // copy any new bindings back
          for (const [k, v] of inner) {
            if (!k.startsWith("__")) scope.set(k, v);
          }
          return flow;
        });
        const results = await Promise.all(promises);
        this.onStep({ type: "parallel:end", count: stmt.stmts.length });
        // if any statement returned, propagate it
        for (const flow of results) {
          if (flow && flow[RETURN] !== undefined) return flow;
        }
        return undefined;
      }
      case "Emit": {
        const value = await this._evalExpr(prog, stmt.value, scope);
        return { [EMIT]: value };
      }
      case "Throw": {
        const message = await this._evalExpr(prog, stmt.message, scope);
        const fields = {};
        if (stmt.fields) {
          for (const [k, v] of Object.entries(stmt.fields)) {
            fields[k] = await this._evalExpr(prog, v, scope);
          }
        }
        // validate fields against error schema if typed
        if (stmt.errorType && prog.errors && prog.errors[stmt.errorType]) {
          const schema = prog.errors[stmt.errorType];
          for (const [field, type] of Object.entries(schema)) {
            if (!(field in fields))
              throw new RuntimeError(`throw ${stmt.errorType}: missing required field '${field}'`);
            this._checkType(prog, fields[field], type, `throw ${stmt.errorType}.${field}`);
          }
          for (const k of Object.keys(fields)) {
            if (!(k in schema))
              throw new RuntimeError(`throw ${stmt.errorType}: unexpected field '${k}'`);
          }
        }
        throw new SuedeError(String(message), stmt.errorType || null, fields);
      }
      case "Try": {
        try {
          const flow = await this._execBlock(
            prog,
            stmt.tryBody,
            new Map(scope),
          );
          if (flow) return flow;
        } catch (e) {
          // walk catch blocks in order, first match wins
          for (const c of stmt.catches) {
            if (c.errorType) {
              // typed catch — only match SuedeErrors with matching errorType
              if (e instanceof SuedeError && e.errorType === c.errorType) {
                const catchScope = new Map(scope);
                catchScope.set(c.errName, { message: e.message, ...e.fields });
                this.onStep({ type: "catch", error: e.message, errorType: c.errorType });
                const flow = await this._execBlock(prog, c.body, catchScope);
                if (flow) return flow;
                return undefined;
              }
            } else {
              // untyped catch-all
              const catchScope = new Map(scope);
              if (e instanceof SuedeError) {
                catchScope.set(c.errName, { message: e.message, ...e.fields });
              } else {
                catchScope.set(c.errName, { message: e.message, name: e.name || "Error" });
              }
              this.onStep({ type: "catch", error: e.message });
              const flow = await this._execBlock(prog, c.body, catchScope);
              if (flow) return flow;
              return undefined;
            }
          }
          // no catch matched — rethrow
          throw e;
        }
        return undefined;
      }
      case "Match": {
        const val = await this._evalExpr(prog, stmt.expr, scope);
        this.onStep({ type: "match", value: val });
        for (const c of stmt.cases) {
          const pattern = await this._evalExpr(prog, c.pattern, scope);
          if (val === pattern) {
            return this._execBlock(prog, c.body, new Map(scope));
          }
        }
        if (stmt.fallback) {
          return this._execBlock(prog, stmt.fallback, new Map(scope));
        }
        return undefined;
      }
      case "Log": {
        const value = await this._evalExpr(prog, stmt.value, scope);
        this.onStep({ type: "log", value });
        return undefined;
      }
      case "ExprStmt":
        await this._evalExpr(prog, stmt.expr, scope);
        return undefined;
    }
  }

  // ── Model call ────────────────────────────────────────────────────
  async _evalFuzzy(prog, expr, scope, line, withModel, useCache, systemPrompt) {
    if (expr.kind !== "Call")
      throw new RuntimeError(`~= must call a model verb (line ${line})`);

    const verb = expr.callee;

    // check if it's a custom prompt
    const customPrompt = (prog.prompts || []).find((p) => p.name === verb);
    const isBuiltinVerb = MODEL_VERBS.has(verb);

    if (!isBuiltinVerb && !customPrompt) {
      throw new RuntimeError(
        `'${verb}' is not a model verb or custom prompt — use '=' for plain code (line ${line})`,
      );
    }

    // eval args
    const positionalArgs = [];
    for (const a of expr.args)
      positionalArgs.push(await this._evalExpr(prog, a, scope));
    const namedArgs = {};
    for (const [k, v] of Object.entries(expr.named))
      namedArgs[k] = await this._evalExpr(prog, v, scope);

    // resolve model
    if (withModel && !this.config.models[withModel]) {
      const available = Object.keys(this.config.models);
      throw new RuntimeError(
        available.length
          ? `model '${withModel}' is not defined in init — available: ${available.join(", ")}`
          : `model '${withModel}' is not defined — add an init block with model definitions`,
      );
    }
    const modelEntry = withModel
      ? this.config.models[withModel]
      : Object.values(this.config.models)[0] || null;
    const modelId = modelEntry?.id || modelEntry || null;
    const { id: _id, provider: _provider, ...modelOpts } =
      modelEntry && typeof modelEntry === "object" ? modelEntry : {};

    // cache check
    const cacheKey = customPrompt ? verb : verb;
    const cacheInput = customPrompt ? positionalArgs : positionalArgs[0];
    if (useCache && this.cache) {
      const cached = this.cache.get(cacheKey, cacheInput, namedArgs, modelId);
      if (cached) {
        this.stats.cacheHits++;
        this.onStep({ type: "cache:hit", line, verb });
        return cached.value;
      }
    }

    // build the prompt
    let prompt;
    let returnType = "text";
    if (customPrompt) {
      // custom prompt: eval the template with params bound
      const templateScope = new Map(scope);
      for (let i = 0; i < customPrompt.params.length; i++) {
        templateScope.set(
          customPrompt.params[i].name,
          positionalArgs[i] ?? namedArgs[customPrompt.params[i].name],
        );
      }
      const userPrompt = await this._evalExpr(prog, customPrompt.template, templateScope);
      returnType = customPrompt.returnType;
      // enforce JSON return for all custom prompts
      const jsonShape = {
        text: '{"value":"<your response>"}',
        num: '{"value":<number>}',
        bool: '{"value":true|false}',
        obj: "{...}",
        json: "{...}",
        list: "[...]",
      };
      prompt = userPrompt + `\n\nReturn ONLY valid JSON matching this shape: ${jsonShape[returnType] || jsonShape.text} (no markdown, no code fences, no explanation).`;
    } else {
      prompt = buildPrompt(verb, positionalArgs[0], namedArgs);
    }

    // call the model — use adaptive throttle for real providers, bypass for custom modelFn
    let res;
    const callObj = {
      prompt,
      verb,
      input: positionalArgs[0],
      model: modelId,
      modelOpts,
      systemPrompt: systemPrompt || null,
      config: this.config.settings,
    };
    // resolve provider from model entry, falling back to global setting
    const provider = modelEntry?.provider || this.config.settings.provider || "gemini";
    // resolve api key from api_keys block by provider name
    const apiKey = this.config.apiKeys[provider] || this.config.settings.api_key || null;

    if (this.modelFn) {
      callObj.config = { ...callObj.config, provider, api_key: apiKey };
      res = await this.modelFn(callObj);
    } else {
      const modelKey = modelId || withModel || "default";
      const providerConfig = { ...this.config.settings, provider, api_key: apiKey };
      try {
        res = await this.throttle.enqueue(modelKey, provider, () =>
          callModel(prompt, verb, positionalArgs[0], modelId, modelOpts, providerConfig, systemPrompt)
        );
      } catch (err) {
        if (err._suede_rate_limited) {
          throw new SuedeError(
            err.message,
            "RateLimited",
            { model: err._suede_model, retries: err._suede_retries },
          );
        }
        throw err;
      }
    }

    this.stats.modelCalls++;
    this.stats.inputTokens += res.inputTokens;
    this.stats.outputTokens += res.outputTokens;
    this.stats.trace.push({
      line,
      kind: "model",
      verb,
      model: withModel || null,
      tokens: res.inputTokens + res.outputTokens,
    });

    // parse the response
    let value;
    if (customPrompt) {
      const raw = typeof res.value === "string" ? res.value.trim() : res.value;

      // try JSON first, fall back to scraping the raw string for scalars
      let parsed;
      try {
        parsed = typeof raw === "object" && raw !== null ? raw : asJson(raw);
      } catch {
        parsed = null; // JSON failed — scalar fallback below
      }

      switch (returnType) {
        case "num": {
          if (parsed !== null) {
            const v = typeof parsed === "object" && parsed.value !== undefined ? parsed.value : parsed;
            value = Number(v);
          } else {
            // scrape the first number out of the raw text
            const m = String(raw).match(/-?\d+(\.\d+)?/);
            value = m ? Number(m[0]) : NaN;
          }
          if (Number.isNaN(value))
            throw new RuntimeError(`custom prompt '${verb}' expected num, got: ${JSON.stringify(raw)}`);
          break;
        }
        case "bool": {
          if (parsed !== null) {
            const v = typeof parsed === "object" && parsed.value !== undefined ? parsed.value : parsed;
            value = v === true || v === "true";
          } else {
            value = /true/i.test(String(raw));
          }
          break;
        }
        case "text": {
          if (parsed !== null) {
            value = typeof parsed === "object" && parsed.value !== undefined
              ? String(parsed.value)
              : typeof parsed === "string" ? parsed : JSON.stringify(parsed);
          } else {
            value = String(raw);
          }
          break;
        }
        case "list": {
          if (parsed === null)
            throw new RuntimeError(`custom prompt '${verb}' expected list, got: ${JSON.stringify(raw)}`);
          value = Array.isArray(parsed) ? parsed
            : typeof parsed === "object" && Array.isArray(parsed.value) ? parsed.value
            : parsed;
          break;
        }
        default:
          // obj, json — must be valid JSON
          if (parsed === null)
            throw new RuntimeError(`custom prompt '${verb}' expected ${returnType}, got: ${JSON.stringify(raw)}`);
          value = parsed;
      }
    } else {
      value = parseResponse(verb, res.value);
      validateVerbContract(verb, value, namedArgs);
    }

    if (useCache && this.cache) {
      this.cache.set(cacheKey, cacheInput, namedArgs, modelId, {
        value,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      });
    }

    return value;
  }

  // ── Expression evaluation ─────────────────────────────────────────
  async _evalExpr(prog, expr, scope) {
    switch (expr.kind) {
      case "Num":
        return expr.value;
      case "Str":
        return expr.value;
      case "Bool":
        return expr.value;
      case "Sym":
        return expr.name;
      case "Null":
        return null;
      case "Interp": {
        const parts = await Promise.all(
          expr.parts.map((p) => this._evalExpr(prog, p, scope)),
        );
        return parts.map((p) => (p == null ? "" : String(p))).join("");
      }
      case "Var": {
        if (!scope.has(expr.name))
          throw new RuntimeError(`undefined variable '${expr.name}'`);
        return scope.get(expr.name);
      }
      case "List":
        return Promise.all(
          expr.items.map((i) => this._evalExpr(prog, i, scope)),
        );
      case "Member": {
        const obj = await this._evalExpr(prog, expr.obj, scope);
        if (obj == null)
          throw new RuntimeError(`cannot read '${expr.prop}' of null`);
        return obj[expr.prop];
      }
      case "Record": {
        const out = {};
        for (const [k, v] of Object.entries(expr.fields))
          out[k] = await this._evalExpr(prog, v, scope);
        // enforce type schema if one is defined
        const schema = expr.typeName && prog.types ? prog.types[expr.typeName] : null;
        if (schema) {
          // check for missing fields
          for (const [field, type] of Object.entries(schema)) {
            if (!(field in out))
              throw new RuntimeError(`@${expr.typeName} is missing required field '${field}'`);
            const v = out[field];
            const ok =
              (type === "text" && typeof v === "string") ||
              (type === "num" && typeof v === "number") ||
              (type === "bool" && typeof v === "boolean") ||
              (type === "list" && Array.isArray(v)) ||
              (type === "obj" && typeof v === "object" && v !== null && !Array.isArray(v)) ||
              type === "any";
            if (!ok)
              throw new RuntimeError(`@${expr.typeName}.${field} expected type '${type}', got ${Array.isArray(v) ? "list" : typeof v}`);
          }
          // check for extra fields not in the schema
          for (const k of Object.keys(out)) {
            if (!(k in schema))
              throw new RuntimeError(`@${expr.typeName} has unexpected field '${k}' — not defined in type`);
          }
        }
        return out;
      }
      case "Unary": {
        const val = await this._evalExpr(prog, expr.expr, scope);
        if (expr.op === "not") return !val;
        if (expr.op === "-") return -val;
        throw new RuntimeError(`unknown unary operator '${expr.op}'`);
      }
      case "Binary":
        return this._evalBinary(
          expr.op,
          await this._evalExpr(prog, expr.left, scope),
          await this._evalExpr(prog, expr.right, scope),
        );
      case "Pipe": {
        const leftVal = await this._evalExpr(prog, expr.left, scope);
        if (expr.right.kind !== "Call")
          throw new RuntimeError("right side of |> must be a call");
        const piped = {
          ...expr.right,
          args: [{ kind: "__lit", value: leftVal }, ...expr.right.args],
        };
        return this._evalCall(prog, piped, scope, leftVal);
      }
      case "Call":
        return this._evalCall(prog, expr, scope);
      case "Use": {
        const toolArgs = [];
        for (const a of expr.args)
          toolArgs.push(await this._evalExpr(prog, a, scope));
        const toolName = typeof toolArgs[0] === "string" ? toolArgs[0] : null;
        const allowedTools = scope.get("__tools__");
        if (!allowedTools)
          throw new RuntimeError("use() can only be called inside an agent");
        if (!toolName || !allowedTools.includes(toolName))
          throw new RuntimeError(
            `'${toolName}' is not a declared tool for this agent`,
          );
        this.stats.toolCalls++;
        this.onStep({
          type: "agent:tool",
          tool: toolName,
          args: toolArgs.slice(1),
        });
        // call the function or pipeline
        const func = (prog.functions || []).find((f) => f.name === toolName);
        if (func) {
          const funcScope = new Map();
          for (let i = 0; i < func.params.length; i++)
            funcScope.set(func.params[i].name, toolArgs[i + 1]);
          const flow = await this._execBlock(prog, func.body, funcScope);
          return flow ? flow[RETURN] : undefined;
        }
        const pipe = prog.pipelines.find((p) => p.name === toolName);
        if (pipe) {
          const pipeArgs = {};
          for (let i = 0; i < pipe.params.length; i++)
            pipeArgs[pipe.params[i].name] = toolArgs[i + 1];
          return this._runPipeline(prog, pipe, pipeArgs);
        }
        const agentTool = (prog.agents || []).find((a) => a.name === toolName);
        if (agentTool) {
          const agentArgs = {};
          for (let i = 0; i < agentTool.params.length; i++)
            agentArgs[agentTool.params[i].name] = toolArgs[i + 1];
          return this._runAgent(prog, agentTool, agentArgs);
        }
        // host-provided tool
        const hostTool = this.hostTools[toolName];
        if (hostTool) {
          return hostTool(...toolArgs.slice(1));
        }
        throw new RuntimeError(`tool '${toolName}' not found`);
      }
      case "Recurse": {
        const pipe = prog.pipelines.find((p) => p.name === expr.pipeline);
        if (!pipe)
          throw new RuntimeError(
            `recurse: pipeline '${expr.pipeline}' not found`,
          );
        const args = {};
        for (let i = 0; i < pipe.params.length; i++) {
          args[pipe.params[i].name] = await this._evalExpr(
            prog,
            expr.args[i],
            scope,
          );
        }
        this.onStep({ type: "recurse", pipeline: expr.pipeline, args });
        return this._runPipeline(prog, pipe, args);
      }
      case "JsBlock": {
        // build a function that has all scope variables as locals
        const names = [...scope.keys()].filter(k => !k.startsWith("__"));
        const vals = names.map(k => scope.get(k));
        const fn = new Function(...names, `"use strict"; return (async () => {\n${expr.body}\n})();`);
        return fn(...vals);
      }
    }
  }

  async _evalCall(prog, expr, scope, pipedFirst) {
    // map — intercept before evaluating args so we can inspect AST of second arg
    if (expr.callee === "map") {
      const rawArgs = expr.args;
      // resolve which AST nodes are list vs mapper, accounting for pipe
      const listAst = pipedFirst !== undefined ? null : rawArgs[0];
      const mapperAst = pipedFirst !== undefined ? rawArgs[1] : rawArgs[1];
      const list = pipedFirst !== undefined ? pipedFirst : await this._evalExpr(prog, listAst, scope);

      // string → field pluck
      if (mapperAst.kind === "Str" || (mapperAst.kind === "__lit" && typeof mapperAst.value === "string")) {
        const key = mapperAst.kind === "__lit" ? mapperAst.value : mapperAst.value;
        return list.map((item) => item[key]);
      }
      // call → invoke function/pipeline per item, item becomes first arg
      if (mapperAst.kind === "Call") {
        const name = mapperAst.callee;
        const func = (prog.functions || []).find((f) => f.name === name);
        const pipe = prog.pipelines.find((p) => p.name === name);
        if (!func && !pipe)
          throw new RuntimeError(`map: '${name}' is not a defined function or pipeline`);
        const extraArgs = [];
        for (const a of mapperAst.args)
          extraArgs.push(await this._evalExpr(prog, a, scope));
        const results = [];
        for (const item of list) {
          if (func) {
            const funcScope = new Map();
            funcScope.set(func.params[0].name, item);
            for (let i = 0; i < extraArgs.length; i++)
              funcScope.set(func.params[i + 1].name, extraArgs[i]);
            for (let i = extraArgs.length + 1; i < func.params.length; i++) {
              if (func.params[i].default)
                funcScope.set(func.params[i].name, await this._evalExpr(prog, func.params[i].default, funcScope));
            }
            const flow = await this._execBlock(prog, func.body, funcScope);
            results.push(flow ? flow[RETURN] : undefined);
          } else {
            const pipeArgs = { [pipe.params[0].name]: item };
            for (let i = 0; i < extraArgs.length; i++)
              pipeArgs[pipe.params[i + 1].name] = extraArgs[i];
            results.push(await this._runPipeline(prog, pipe, pipeArgs));
          }
        }
        return results;
      }
      throw new RuntimeError("map requires a string key or a function call — e.g. map(items, \"name\") or map(items, process())");
    }

    // check if it's a custom prompt — those need ~=
    const isCustomPrompt = (prog.prompts || []).some(
      (p) => p.name === expr.callee,
    );
    if (MODEL_VERBS.has(expr.callee) || isCustomPrompt) {
      throw new RuntimeError(
        `'${expr.callee}' is a model verb — call it with '~=' so its cost is visible`,
      );
    }

    const args = [];
    if (pipedFirst !== undefined) args.push(pipedFirst);
    for (let k = pipedFirst !== undefined ? 1 : 0; k < expr.args.length; k++) {
      args.push(await this._evalExpr(prog, expr.args[k], scope));
    }

    // custom function call
    const func = (prog.functions || []).find((f) => f.name === expr.callee);
    if (func) {
      const funcScope = new Map();
      for (let i = 0; i < func.params.length; i++) {
        if (i < args.length) {
          funcScope.set(func.params[i].name, args[i]);
          this._checkType(prog, args[i], func.params[i].type, `param '${func.params[i].name}' of '${func.name}'`);
        } else if (func.params[i].default) {
          funcScope.set(func.params[i].name, await this._evalExpr(prog, func.params[i].default, funcScope));
        }
      }
      this.onStep({ type: "function:call", name: expr.callee });
      const flow = await this._execBlock(prog, func.body, funcScope);
      const result = flow ? flow[RETURN] : undefined;
      if (func.returnType) {
        this._checkType(prog, result, func.returnType, `return from '${func.name}'`);
      }
      return result;
    }

    // pipeline call
    const pipe = prog.pipelines.find((p) => p.name === expr.callee);
    if (pipe) {
      const pipeArgs = {};
      for (let i = 0; i < pipe.params.length; i++) {
        if (i < args.length) pipeArgs[pipe.params[i].name] = args[i];
      }
      this.onStep({
        type: "pipeline:call",
        pipeline: expr.callee,
        args: pipeArgs,
      });
      const result = await this._runPipeline(prog, pipe, pipeArgs);
      this.onStep({
        type: "pipeline:return",
        pipeline: expr.callee,
        value: result,
      });
      return result;
    }

    // agent call
    const agent = (prog.agents || []).find((a) => a.name === expr.callee);
    if (agent) {
      const agentArgs = {};
      for (let i = 0; i < agent.params.length; i++) {
        if (i < args.length) agentArgs[agent.params[i].name] = args[i];
      }
      return this._runAgent(prog, agent, agentArgs);
    }

    const ioFn = IO_BUILTINS[expr.callee];
    if (ioFn) {
      const namedArgs = {};
      for (const [k, v] of Object.entries(expr.named || {}))
        namedArgs[k] = await this._evalExpr(prog, v, scope);
      return ioFn(args, namedArgs);
    }

    const fn = BUILTINS[expr.callee];
    if (!fn) throw new RuntimeError(`unknown function '${expr.callee}'`);
    return fn(...args);
  }

  _evalBinary(op, l, r) {
    switch (op) {
      case "+":
        return l + r;
      case "-":
        return l - r;
      case "*":
        return l * r;
      case "/":
        return l / r;
      case ">":
        return l > r;
      case "<":
        return l < r;
      case ">=":
        return l >= r;
      case "<=":
        return l <= r;
      case "==":
        return l === r;
      case "!=":
        return l !== r;
      case "and":
        return l && r;
      case "or":
        return l || r;
      default:
        throw new RuntimeError(`unknown operator '${op}'`);
    }
  }
}
