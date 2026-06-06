import { TT, lex } from "./lexer.js";

export class ParseError extends Error {
  constructor(msg, line, col) {
    super(`${msg} (line ${line}:${col})`);
    this.name = "ParseError";
    this.line = line;
    this.col = col;
  }
}

const PREC = {
  or: 0,
  and: 1,
  "==": 2,
  "!=": 2,
  ">": 3,
  "<": 3,
  ">=": 3,
  "<=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
};

export function parse(toks) {
  let pos = 0;
  const peek = () => toks[pos];
  const at = (t) => peek().type === t;
  const next = () => toks[pos++];
  const eat = (t, what) => {
    if (!at(t)) {
      const p = peek();
      throw new ParseError(
        `expected ${what}, got '${p.value || p.type}'`,
        p.line,
        p.col,
      );
    }
    return next();
  };
  // eat a token usable as a field/property name — IDENT or any keyword token
  const eatName = (what) => {
    const p = peek();
    if (p.type === TT.IDENT || (p.value && /^[a-z_]\w*$/i.test(p.value) && p.type !== TT.EOF)) return next();
    throw new ParseError(`expected ${what}, got '${p.value || p.type}'`, p.line, p.col);
  };

  function parseProgram() {
    const imports = [];
    while (at(TT.IMPORT)) imports.push(parseImport());
    let init = null;
    if (at(TT.INIT)) init = parseInit();
    const types = {};
    const errors = {};
    const pipelines = [];
    const agents = [];
    const prompts = [];
    const functions = [];
    let main = null;
    while (!at(TT.EOF)) {
      if (at(TT.TYPE)) {
        const td = parseTypeDef();
        types[td.name] = td.fields;
        continue;
      }
      if (at(TT.ERROR)) {
        const ed = parseErrorDef();
        errors[ed.name] = ed.fields;
        continue;
      }
      if (at(TT.INIT)) {
        if (init) {
          const p = peek();
          throw new ParseError("only one init block allowed", p.line, p.col);
        }
        init = parseInit();
        continue;
      }
      if (at(TT.MAIN)) {
        if (main) {
          const p = peek();
          throw new ParseError("only one main allowed", p.line, p.col);
        }
        main = parseMain();
      } else if (at(TT.AGENT)) agents.push(parseAgent());
      else if (at(TT.PROMPT)) prompts.push(parsePromptDef());
      else if (at(TT.FUNCTION)) functions.push(parseFunctionDef());
      else pipelines.push(parsePipeline());
    }
    // validate return types: if a return type matches a type name, great.
    // if it looks like a custom type (capitalized) but no type block exists, error.
    // skip this check if the file has imports — types may come from imported files
    // and will be validated after import resolution in check.js
    if (imports.length === 0) {
      const builtinTypes = new Set(["text", "num", "bool", "list", "obj", "any"]);
      const allBlocks = [...pipelines, ...agents, ...functions];
      if (main && main.returnType) allBlocks.push(main);
      for (const block of allBlocks) {
        const rt = block.returnType;
        if (rt && !builtinTypes.has(rt) && !types[rt]) {
          throw new ParseError(
            `return type '${rt}' is not defined — add a 'type ${rt} { ... }' block`,
            block.body?.[0]?.line || 1, 1,
          );
        }
      }
    }

    return { imports, init, types, errors, pipelines, agents, prompts, functions, main };
  }

  // import { triage_lead, score } from "./triage.suede"
  // import helpers from "./helpers.suede"
  function parseImport() {
    const line = eat(TT.IMPORT, "'import'").line;
    const names = [];
    if (at(TT.LBRACE)) {
      next();
      while (!at(TT.RBRACE) && !at(TT.EOF)) {
        const name = eat(TT.IDENT, "import name").value;
        let alias = name;
        if (at(TT.AS)) {
          next();
          alias = eat(TT.IDENT, "alias").value;
        }
        names.push({ name, alias });
        if (at(TT.COMMA)) next();
      }
      eat(TT.RBRACE, "'}'");
    } else {
      // import foo from "..."  — imports everything, namespaced as foo
      const name = eat(TT.IDENT, "module name").value;
      names.push({ name, alias: name, isNamespace: true });
    }
    eat(TT.FROM, "'from'");
    const path = eat(TT.STRING, "module path").value;
    return { kind: "Import", names, path, line };
  }

  function parseTypeDef() {
    eat(TT.TYPE, "'type'");
    const name = eat(TT.IDENT, "type name").value;
    eat(TT.LBRACE, "'{'");
    const fields = {};
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      const fn = eatName("field name").value;
      eat(TT.COLON, "':'");
      const ft = eatName("field type").value;
      fields[fn] = ft;
      if (at(TT.COMMA)) next();
    }
    eat(TT.RBRACE, "'}'");
    return { name, fields };
  }

  function parseErrorDef() {
    eat(TT.ERROR, "'error'");
    const name = eat(TT.IDENT, "error name").value;
    eat(TT.LBRACE, "'{'");
    const fields = {};
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      const fn = eatName("field name").value;
      eat(TT.COLON, "':'");
      const ft = eatName("field type").value;
      fields[fn] = ft;
      if (at(TT.COMMA)) next();
    }
    eat(TT.RBRACE, "'}'");
    return { name, fields };
  }

  function parseParams() {
    eat(TT.LPAREN, "'('");
    const params = [];
    let seenDefault = false;
    while (!at(TT.RPAREN)) {
      const pn = eat(TT.IDENT, "param name").value;
      eat(TT.COLON, "':'");
      const pt = eat(TT.IDENT, "param type").value;
      let defaultValue = null;
      if (at(TT.ASSIGN)) {
        next();
        defaultValue = parseExpr();
        seenDefault = true;
      } else if (seenDefault) {
        const p = peek();
        throw new ParseError(
          `parameter '${pn}' must have a default value — required params cannot follow params with defaults`,
          p.line, p.col,
        );
      }
      params.push({ name: pn, type: pt, default: defaultValue });
      if (at(TT.COMMA)) next();
    }
    eat(TT.RPAREN, "')'");
    return params;
  }

  function parseMain() {
    eat(TT.MAIN, "'main'");
    const params = parseParams();
    let returnType = null;
    if (at(TT.ARROW)) {
      next();
      returnType = eat(TT.IDENT, "return type").value;
    }
    const body = parseBlock();
    return { kind: "Main", params, returnType, body };
  }

  function parsePromptDef() {
    eat(TT.PROMPT, "'prompt'");
    const name = eat(TT.IDENT, "prompt name").value;
    const params = parseParams();
    let returnType = "text";
    if (at(TT.ARROW)) {
      next();
      returnType = eat(TT.IDENT, "return type").value;
    }
    eat(TT.LBRACE, "'{'");
    // body is a single string expression (the template)
    const template = parseExpr();
    eat(TT.RBRACE, "'}'");
    return { kind: "PromptDef", name, params, returnType, template };
  }

  function parseFunctionDef() {
    eat(TT.FUNCTION, "'function'");
    const name = eat(TT.IDENT, "function name").value;
    const params = parseParams();
    let returnType = null;
    if (at(TT.ARROW)) {
      next();
      returnType = eat(TT.IDENT, "return type").value;
    }
    const body = parseBlock();
    return { kind: "FunctionDef", name, params, returnType, body };
  }

  // parse a { key = value ... } config block
  function parseConfigBlock() {
    eat(TT.LBRACE, "'{'");
    const opts = {};
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      const k = eat(TT.IDENT, "option name").value;
      eat(TT.ASSIGN, "'='");
      if (at(TT.NUMBER)) {
        opts[k] = Number(next().value);
      } else if (at(TT.STRING)) {
        opts[k] = next().value;
      } else if (at(TT.TRUE)) {
        next();
        opts[k] = true;
      } else if (at(TT.FALSE)) {
        next();
        opts[k] = false;
      } else {
        throw new ParseError("expected value", peek().line, peek().col);
      }
    }
    eat(TT.RBRACE, "'}'");
    return opts;
  }

  function parseInit() {
    eat(TT.INIT, "'init'");
    eat(TT.LBRACE, "'{'");
    const settings = {};
    const models = {};
    let apiKeys = null;
    let cacheConfig = null;
    let budget = null;
    while (!at(TT.RBRACE) && !at(TT.EOF)) {
      if (at(TT.MODEL)) {
        next();
        const name = eat(TT.IDENT, "model alias name").value;
        eat(TT.ASSIGN, "'='");
        const id = eat(TT.STRING, "model identifier").value;
        const opts = at(TT.LBRACE) ? parseConfigBlock() : {};
        models[name] = { id, ...opts };
      } else if (at(TT.IDENT) && peek().value === "api_keys") {
        next();
        eat(TT.LBRACE, "'{'");
        apiKeys = {};
        while (!at(TT.RBRACE) && !at(TT.EOF)) {
          const k = eat(TT.IDENT, "provider name").value;
          eat(TT.ASSIGN, "'='");
          if (at(TT.STRING)) {
            apiKeys[k] = { kind: "Str", value: next().value };
          } else if (at(TT.IDENT)) {
            apiKeys[k] = parsePrimary();
          } else {
            throw new ParseError("expected string or call", peek().line, peek().col);
          }
        }
        eat(TT.RBRACE, "'}'");
      } else if (at(TT.CACHE)) {
        next();
        cacheConfig = parseConfigBlock();
      } else if (at(TT.IDENT) && peek().value === "budget") {
        next();
        budget = parseConfigBlock();
      } else if (at(TT.SYSTEM)) {
        next();
        eat(TT.ASSIGN, "'='");
        const value = at(TT.STRING)
          ? { kind: "Str", value: next().value }
          : parsePrimary();
        settings.system = value;
      } else {
        const key = eat(TT.IDENT, "setting name").value;
        eat(TT.ASSIGN, "'='");
        let value;
        if (at(TT.STRING)) {
          value = { kind: "Str", value: next().value };
        } else if (at(TT.IDENT)) {
          value = parsePrimary();
        } else {
          throw new ParseError(
            "expected string or call",
            peek().line,
            peek().col,
          );
        }
        settings[key] = value;
      }
    }
    eat(TT.RBRACE, "'}'");
    return {
      kind: "Init",
      settings,
      models,
      apiKeys,
      cacheConfig,
      budget,
    };
  }

  let currentPipeline = null; // track current pipeline for recurse validation
  let insideIf = 0; // depth counter — recurse must be > 0

  function parsePipeline() {
    eat(TT.PIPELINE, "'pipeline'");
    const name = eat(TT.IDENT, "pipeline name").value;
    const params = parseParams();
    let returnType = null;
    if (at(TT.ARROW)) {
      next();
      returnType = eat(TT.IDENT, "return type").value;
    }
    currentPipeline = { name, params };
    const body = parseBlock();
    // if body contains recurse, check that there's an if with a return (base case)
    if (bodyHasRecurse(body) && !bodyHasIfWithReturn(body)) {
      const p = peek();
      throw new ParseError(
        "recurse requires a base case — add an if block with a return",
        p.line,
        p.col,
      );
    }
    currentPipeline = null;
    return { kind: "Pipeline", name, params, returnType, body };
  }

  function bodyHasRecurse(stmts) {
    for (const s of stmts) {
      if (s.kind === "Let" && s.value.kind === "Recurse") return true;
      if (s.kind === "If") {
        if (bodyHasRecurse(s.then) || bodyHasRecurse(s.else)) return true;
      }
      if (s.kind === "For" && bodyHasRecurse(s.body)) return true;
    }
    return false;
  }

  function bodyHasIfWithReturn(stmts) {
    for (const s of stmts) {
      if (s.kind === "If") {
        const thenReturns = s.then.some((st) => st.kind === "Return");
        const elseReturns = s.else.some((st) => st.kind === "Return");
        if (thenReturns || elseReturns) return true;
      }
    }
    return false;
  }

  function parseAgent() {
    eat(TT.AGENT, "'agent'");
    const name = eat(TT.IDENT, "agent name").value;
    const params = parseParams();
    let returnType = null;
    if (at(TT.ARROW)) {
      next();
      returnType = eat(TT.IDENT, "return type").value;
    }
    eat(TT.MAX, "'max'");
    const maxIter = Number(eat(TT.NUMBER, "max iterations").value);
    eat(TT.LBRACE, "'{'");

    // optional tools block — typed signatures required
    let tools = [];
    if (at(TT.TOOLS)) {
      next();
      eat(TT.LBRACE, "'{'");
      while (!at(TT.RBRACE) && !at(TT.EOF)) {
        const toolTok = peek();
        const toolName = eat(TT.IDENT, "tool name").value;
        eat(TT.LPAREN, `'(' after tool name '${toolName}' — tools require typed signatures`);
        const params = [];
        while (!at(TT.RPAREN) && !at(TT.EOF)) {
          const pn = eat(TT.IDENT, "param name").value;
          eat(TT.COLON, "':'");
          const pt = eat(TT.IDENT, "param type").value;
          params.push({ name: pn, type: pt });
          if (at(TT.COMMA)) next();
        }
        eat(TT.RPAREN, "')'");
        eat(TT.ARROW, "'->' — tools require a return type");
        const returnType = eat(TT.IDENT, "return type").value;
        tools.push({ name: toolName, params, returnType, line: toolTok.line });
        if (at(TT.COMMA)) next();
      }
      eat(TT.RBRACE, "'}'");
    }

    // optional memory block — persistent state across loop iterations
    let memory = [];
    if (at(TT.MEMORY)) {
      next();
      eat(TT.LBRACE, "'{'");
      while (!at(TT.RBRACE) && !at(TT.EOF)) {
        const mn = eat(TT.IDENT, "memory variable name").value;
        eat(TT.COLON, "':'");
        const mt = eat(TT.IDENT, "memory variable type").value;
        eat(TT.ASSIGN, "'='");
        const mdefault = parseExpr();
        memory.push({ name: mn, type: mt, default: mdefault });
        if (at(TT.COMMA)) next();
      }
      eat(TT.RBRACE, "'}'");
    }

    // loop block (required)
    eat(TT.LOOP, "'loop'");
    const loopBody = parseBlock();

    eat(TT.RBRACE, "'}'");
    return {
      kind: "Agent",
      name,
      params,
      returnType,
      maxIter,
      tools,
      memory,
      loopBody,
    };
  }

  function parseBlock() {
    eat(TT.LBRACE, "'{'");
    const stmts = [];
    while (!at(TT.RBRACE) && !at(TT.EOF)) stmts.push(parseStmt());
    eat(TT.RBRACE, "'}'");
    return stmts;
  }

  function parseStmt() {
    if (at(TT.LET) || at(TT.CONST)) {
      const isConst = at(TT.CONST);
      const lineTok = next();
      const name = eat(TT.IDENT, "variable name").value;
      let fuzzy = false;
      if (at(TT.FUZZY_ASSIGN)) {
        next();
        fuzzy = true;
      } else eat(TT.ASSIGN, "'=' or '~='");
      const value = parseExpr();
      let withModel = null;
      let retryCount = 0;
      let useCache = false;
      let expect = null;
      let systemPrompt = null;
      let guard = null;
      if (fuzzy && at(TT.WITH)) {
        next();
        withModel = eat(TT.IDENT, "model alias").value;
      }
      if (fuzzy && at(TT.RETRY)) {
        next();
        retryCount = Number(eat(TT.NUMBER, "retry count").value);
      }
      if (fuzzy && at(TT.CACHE)) {
        next();
        useCache = true;
      }
      let timeout = null;
      if (fuzzy && at(TT.TIMEOUT)) {
        next();
        timeout = Number(eat(TT.NUMBER, "timeout in ms").value);
      }
      if (fuzzy && at(TT.SYSTEM)) {
        next();
        systemPrompt = parseExpr();
      }
      if (fuzzy && at(TT.EXPECT)) {
        next();
        eat(TT.LBRACE, "'{'");
        expect = {};
        while (!at(TT.RBRACE) && !at(TT.EOF)) {
          const fn = eat(TT.IDENT, "field name").value;
          eat(TT.COLON, "':'");
          const ft = eat(TT.IDENT, "field type").value;
          expect[fn] = ft;
          if (at(TT.COMMA)) next();
        }
        eat(TT.RBRACE, "'}'");
      }
      if (fuzzy && at(TT.GUARD)) {
        next();
        eat(TT.LBRACE, "'{'");
        guard = parseExpr();
        eat(TT.RBRACE, "'}'");
      }
      return {
        kind: "Let",
        name,
        value,
        fuzzy,
        mutable: !isConst,
        withModel,
        retryCount,
        useCache,
        timeout,
        systemPrompt,
        expect,
        guard,
        line: lineTok.line,
      };
    }
    if (at(TT.IF)) {
      next();
      insideIf++;
      const cond = parseExpr();
      const then = parseBlock();
      let elseB = [];
      if (at(TT.ELSE)) {
        next();
        elseB = at(TT.IF) ? [parseStmt()] : parseBlock();
      }
      insideIf--;
      return { kind: "If", cond, then, else: elseB };
    }
    if (at(TT.FOR)) {
      next();
      const varName = eat(TT.IDENT, "loop variable").value;
      eat(TT.IN, "'in'");
      const iter = parseExpr();
      let collectAs = null;
      if (at(TT.INTO)) {
        next();
        collectAs = eat(TT.IDENT, "collection variable").value;
      }
      const body = parseBlock();
      return { kind: "For", varName, iter, collectAs, body };
    }
    if (at(TT.PARALLEL)) {
      next();
      // parallel for — run loop iterations concurrently
      if (at(TT.FOR)) {
        next();
        const varName = eat(TT.IDENT, "loop variable").value;
        eat(TT.IN, "'in'");
        const iter = parseExpr();
        let collectAs = null;
        if (at(TT.INTO)) {
          next();
          collectAs = eat(TT.IDENT, "collection variable").value;
        }
        const body = parseBlock();
        return { kind: "For", varName, iter, collectAs, body, parallel: true };
      }
      eat(TT.LBRACE, "'{'");
      const stmts = [];
      while (!at(TT.RBRACE) && !at(TT.EOF)) {
        stmts.push(parseStmt());
      }
      eat(TT.RBRACE, "'}'");
      return { kind: "Parallel", stmts };
    }
    if (at(TT.TRY)) {
      next();
      const tryBody = parseBlock();
      const catches = [];
      while (at(TT.CATCH)) {
        next();
        const nameTok = eat(TT.IDENT, "error type or variable name");
        // catch ErrorType as err { }  — typed catch
        if (at(TT.AS)) {
          next();
          const errName = eat(TT.IDENT, "error variable name").value;
          const body = parseBlock();
          catches.push({ errorType: nameTok.value, errName, body });
        } else {
          // catch err { }  — untyped catch-all
          const body = parseBlock();
          catches.push({ errorType: null, errName: nameTok.value, body });
        }
      }
      if (catches.length === 0) {
        const p = peek();
        throw new ParseError("try requires at least one catch block", p.line, p.col);
      }
      return { kind: "Try", tryBody, catches };
    }
    if (at(TT.RETURN)) {
      next();
      return { kind: "Return", value: parseExpr() };
    }
    if (at(TT.THROW)) {
      const lineTok = next();
      // throw "message" — bare string throw
      if (at(TT.STRING)) {
        const message = parseExpr();
        // optional named fields: throw "msg" { key: val, ... }
        let fields = null;
        if (at(TT.LBRACE)) {
          next();
          fields = {};
          while (!at(TT.RBRACE) && !at(TT.EOF)) {
            const fn = eatName("field name").value;
            eat(TT.COLON, "':'");
            fields[fn] = parseExpr();
            if (at(TT.COMMA)) next();
          }
          eat(TT.RBRACE, "'}'");
        }
        return { kind: "Throw", errorType: null, message, fields, line: lineTok.line };
      }
      // throw ErrorType("message") or throw ErrorType("message", key: val)
      const errorType = eat(TT.IDENT, "error type name").value;
      eat(TT.LPAREN, "'('");
      const message = parseExpr();
      const fields = {};
      while (at(TT.COMMA)) {
        next();
        const key = eatName("field name").value;
        eat(TT.COLON, "':'");
        fields[key] = parseExpr();
      }
      eat(TT.RPAREN, "')'");
      return { kind: "Throw", errorType, message, fields, line: lineTok.line };
    }
    if (at(TT.EMIT)) {
      next();
      return { kind: "Emit", value: parseExpr() };
    }
    if (at(TT.LOG)) {
      next();
      return { kind: "Log", value: parseExpr() };
    }
    if (at(TT.MATCH)) {
      next();
      const expr = parseExpr();
      eat(TT.LBRACE, "'{'");
      const cases = [];
      let fallback = null;
      while (!at(TT.RBRACE) && !at(TT.EOF)) {
        if (at(TT.ELSE)) {
          next();
          fallback = parseBlock();
        } else {
          eat(TT.CASE, "'case'");
          const pattern = parseExpr();
          const body = parseBlock();
          cases.push({ pattern, body });
        }
      }
      eat(TT.RBRACE, "'}'");
      return { kind: "Match", expr, cases, fallback };
    }
    return { kind: "ExprStmt", expr: parseExpr() };
  }

  function parseExpr() {
    return parsePipe();
  }

  function parsePipe() {
    let left = parseBinary(0);
    while (at(TT.PIPE)) {
      next();
      const right = parseBinary(0);
      left = { kind: "Pipe", left, right };
    }
    return left;
  }

  function parseBinary(minPrec) {
    let left = parseUnary();
    while (true) {
      let op;
      if (at(TT.AND)) op = "and";
      else if (at(TT.OR)) op = "or";
      else op = peek().value;
      const prec = PREC[op];
      if (prec === undefined || prec < minPrec) break;
      next();
      const right = parseBinary(prec + 1);
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (at(TT.NOT)) {
      next();
      const expr = parseUnary();
      return { kind: "Unary", op: "not", expr };
    }
    if (at(TT.MINUS)) {
      next();
      const expr = parseUnary();
      return { kind: "Unary", op: "-", expr };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let e = parsePrimary();
    while (true) {
      if (at(TT.DOT)) {
        next();
        const prop = eatName("property name").value;
        e = { kind: "Member", obj: e, prop };
      } else break;
    }
    return e;
  }

  function parsePrimary() {
    const t = peek();
    if (at(TT.NUMBER)) {
      next();
      return { kind: "Num", value: Number(t.value) };
    }
    if (at(TT.STRING)) {
      next();
      if (t.interp) {
        const parts = t.interp.map((part) => {
          if (part.type === "lit") return { kind: "Str", value: part.value };
          // mini-parse the embedded expression: supports var, var.prop.prop
          const subToks = lex(part.value);
          let si = 0;
          let expr = { kind: "Var", name: subToks[si++].value };
          while (si < subToks.length - 1 && subToks[si].type === TT.DOT) {
            si++; // skip dot
            expr = { kind: "Member", obj: expr, prop: subToks[si++].value };
          }
          return expr;
        });
        return { kind: "Interp", parts };
      }
      return { kind: "Str", value: t.value };
    }
    if (at(TT.TRUE)) {
      next();
      return { kind: "Bool", value: true };
    }
    if (at(TT.FALSE)) {
      next();
      return { kind: "Bool", value: false };
    }
    if (at(TT.NULL)) {
      next();
      return { kind: "Null" };
    }
    if (at(TT.LBRACKET)) {
      next();
      const items = [];
      while (!at(TT.RBRACKET)) {
        if (
          at(TT.IDENT) &&
          (toks[pos + 1]?.type === TT.COMMA ||
            toks[pos + 1]?.type === TT.RBRACKET)
        ) {
          items.push({ kind: "Sym", name: next().value });
        } else {
          items.push(parseExpr());
        }
        if (at(TT.COMMA)) next();
      }
      eat(TT.RBRACKET, "']'");
      return { kind: "List", items };
    }
    if (at(TT.AT)) {
      next();
      const typeName = eat(TT.IDENT, "record name").value;
      eat(TT.LBRACE, "'{'");
      const fields = {};
      while (!at(TT.RBRACE)) {
        const fn = eatName("field name").value;
        if (at(TT.COLON)) {
          next();
          fields[fn] = parseExpr();
        } else fields[fn] = { kind: "Var", name: fn };
        if (at(TT.COMMA)) next();
      }
      eat(TT.RBRACE, "'}'");
      return { kind: "Record", typeName, fields };
    }
    // keywords that can also be used as function calls
    if ((at(TT.CACHE) || at(TT.MAX) || at(TT.MATCH) || at(TT.CASE) || at(TT.TIMEOUT)) && toks[pos + 1]?.type === TT.LPAREN) {
      const name = next().value;
      next(); // skip (
      const args = [];
      const named = {};
      while (!at(TT.RPAREN)) {
        const isNamedArg =
          toks[pos + 1]?.type === TT.COLON &&
          (at(TT.IDENT) ||
            (typeof peek().value === "string" &&
              peek().value.match(/^[a-z_]/i)));
        if (isNamedArg) {
          const key = next().value;
          next();
          named[key] = parseExpr();
        } else {
          args.push(parseExpr());
        }
        if (at(TT.COMMA)) next();
      }
      eat(TT.RPAREN, "')'");
      return { kind: "Call", callee: name, args, named };
    }
    if (at(TT.USE)) {
      const tok = next();
      eat(TT.LPAREN, "'('");
      const args = [];
      while (!at(TT.RPAREN)) {
        args.push(parseExpr());
        if (at(TT.COMMA)) next();
      }
      eat(TT.RPAREN, "')'");
      return { kind: "Use", args };
    }
    if (at(TT.RECURSE)) {
      const tok = next();
      if (!currentPipeline)
        throw new ParseError(
          "recurse can only be used inside a pipeline",
          tok.line,
          tok.col,
        );
      if (insideIf === 0)
        throw new ParseError(
          "recurse must be inside an if block (need a base case)",
          tok.line,
          tok.col,
        );
      eat(TT.LPAREN, "'('");
      const args = [];
      while (!at(TT.RPAREN)) {
        args.push(parseExpr());
        if (at(TT.COMMA)) next();
      }
      eat(TT.RPAREN, "')'");
      if (args.length !== currentPipeline.params.length) {
        throw new ParseError(
          `recurse expects ${currentPipeline.params.length} arg(s), got ${args.length}`,
          tok.line,
          tok.col,
        );
      }
      return { kind: "Recurse", args, pipeline: currentPipeline.name };
    }
    if (at(TT.LPAREN)) {
      next();
      const e = parseExpr();
      eat(TT.RPAREN, "')'");
      return e;
    }
    if (at(TT.JS)) {
      next(); // consume 'js'
      const body = eat(TT.STRING, "js block body").value;
      return { kind: "JsBlock", body };
    }
    if (at(TT.IDENT)) {
      const name = next().value;
      if (at(TT.LPAREN)) {
        next();
        const args = [];
        const named = {};
        while (!at(TT.RPAREN)) {
          // named args: any token that looks like an identifier followed by ':'
          const isNamedArg =
            toks[pos + 1]?.type === TT.COLON &&
            (at(TT.IDENT) ||
              (typeof peek().value === "string" &&
                peek().value.match(/^[a-z_]/i)));
          if (isNamedArg) {
            const key = next().value;
            next();
            named[key] = parseExpr();
          } else {
            args.push(parseExpr());
          }
          if (at(TT.COMMA)) next();
        }
        eat(TT.RPAREN, "')'");
        return { kind: "Call", callee: name, args, named };
      }
      return { kind: "Var", name };
    }
    throw new ParseError(`unexpected '${t.value || t.type}'`, t.line, t.col);
  }

  return parseProgram();
}
