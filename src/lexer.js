// suede lexer. turns source text into a flat token stream.
// the ~ sigil is tokenized on its own so every later layer can see
// the difference between a model call and plain code.

export const TT = {
  NUMBER: "NUMBER",
  STRING: "STRING",
  IDENT: "IDENT",
  PIPELINE: "PIPELINE",
  LET: "LET",
  CONST: "CONST",
  IF: "IF",
  ELSE: "ELSE",
  FOR: "FOR",
  IN: "IN",
  RETURN: "RETURN",
  TRUE: "TRUE",
  FALSE: "FALSE",
  INIT: "INIT",
  MODEL: "MODEL",
  WITH: "WITH",
  RECURSE: "RECURSE",
  EMIT: "EMIT",
  INTO: "INTO",
  RETRY: "RETRY",
  PARALLEL: "PARALLEL",
  LOG: "LOG",
  NULL: "NULL",
  AND: "AND",
  OR: "OR",
  NOT: "NOT",
  TRY: "TRY",
  CATCH: "CATCH",
  AGENT: "AGENT",
  TOOLS: "TOOLS",
  LOOP: "LOOP",
  USE: "USE",
  MAX: "MAX",
  STORE: "STORE",
  CACHE: "CACHE",
  EXPECT: "EXPECT",
  GUARD: "GUARD",
  SYSTEM: "SYSTEM",
  MEMORY: "MEMORY",
  PROMPT: "PROMPT",
  MATCH: "MATCH",
  CASE: "CASE",
  TIMEOUT: "TIMEOUT",
  FUNCTION: "FUNCTION",
  MAIN: "MAIN",
  IMPORT: "IMPORT",
  FROM: "FROM",
  AS: "AS",
  JS: "JS",
  TYPE: "TYPE",
  ERROR: "ERROR",
  THROW: "THROW",
  LBRACE: "LBRACE",
  RBRACE: "RBRACE",
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  LBRACKET: "LBRACKET",
  RBRACKET: "RBRACKET",
  COMMA: "COMMA",
  COLON: "COLON",
  ARROW: "ARROW",
  DOT: "DOT",
  ASSIGN: "ASSIGN",
  FUZZY_ASSIGN: "FUZZY_ASSIGN",
  PIPE: "PIPE",
  AT: "AT",
  GT: "GT",
  LT: "LT",
  GTE: "GTE",
  LTE: "LTE",
  EQ: "EQ",
  NEQ: "NEQ",
  PLUS: "PLUS",
  MINUS: "MINUS",
  STAR: "STAR",
  SLASH: "SLASH",
  EOF: "EOF",
};

const KEYWORDS = {
  pipeline: TT.PIPELINE,
  let: TT.LET,
  const: TT.CONST,
  if: TT.IF,
  else: TT.ELSE,
  for: TT.FOR,
  in: TT.IN,
  return: TT.RETURN,
  true: TT.TRUE,
  false: TT.FALSE,
  init: TT.INIT,
  model: TT.MODEL,
  with: TT.WITH,
  recurse: TT.RECURSE,
  emit: TT.EMIT,
  into: TT.INTO,
  retry: TT.RETRY,
  parallel: TT.PARALLEL,
  log: TT.LOG,
  null: TT.NULL,
  and: TT.AND,
  or: TT.OR,
  not: TT.NOT,
  try: TT.TRY,
  catch: TT.CATCH,
  agent: TT.AGENT,
  tools: TT.TOOLS,
  loop: TT.LOOP,
  use: TT.USE,
  max: TT.MAX,
  store: TT.STORE,
  cache: TT.CACHE,
  expect: TT.EXPECT,
  guard: TT.GUARD,
  system: TT.SYSTEM,
  memory: TT.MEMORY,
  prompt: TT.PROMPT,
  match: TT.MATCH,
  case: TT.CASE,
  timeout: TT.TIMEOUT,
  function: TT.FUNCTION,
  type: TT.TYPE,
  error: TT.ERROR,
  throw: TT.THROW,
  main: TT.MAIN,
  import: TT.IMPORT,
  from: TT.FROM,
  as: TT.AS,
  js: TT.JS,
};

export class LexError extends Error {
  constructor(msg, line, col) {
    super(`${msg} (line ${line}:${col})`);
    this.name = "LexError";
    this.line = line;
    this.col = col;
  }
}

export function lex(src) {
  const toks = [];
  let i = 0,
    line = 1,
    col = 1;
  const peek = (o = 0) => src[i + o] ?? "";
  const adv = () => {
    const c = src[i++];
    if (c === "\n") {
      line++;
      col = 1;
    } else col++;
    return c;
  };
  const push = (type, value, l = line, c = col) =>
    toks.push({ type, value, line: l, col: c });

  while (i < src.length) {
    const c = peek();

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      adv();
      continue;
    }
    if (c === "#") {
      while (i < src.length && peek() !== "\n") adv();
      continue;
    }

    const startLine = line,
      startCol = col;

    if (/[0-9]/.test(c)) {
      let n = "";
      while (/[0-9.]/.test(peek())) n += adv();
      push(TT.NUMBER, n, startLine, startCol);
      continue;
    }

    if (c === '"') {
      adv();
      let parts = [];
      let current = "";
      let hasInterp = false;
      while (i < src.length && peek() !== '"') {
        if (peek() === "\\") {
          adv(); // skip backslash
          const esc = adv();
          if (esc === "n") current += "\n";
          else if (esc === "t") current += "\t";
          else if (esc === "r") current += "\r";
          else if (esc === "\\") current += "\\";
          else if (esc === '"') current += '"';
          else current += esc;
        } else if (peek() === "$" && peek(1) === "{") {
          hasInterp = true;
          if (current) parts.push({ type: "lit", value: current });
          current = "";
          adv();
          adv(); // skip ${
          let depth = 1;
          let expr = "";
          while (i < src.length && depth > 0) {
            if (peek() === "{") depth++;
            if (peek() === "}") {
              depth--;
              if (depth === 0) {
                adv();
                break;
              }
            }
            expr += adv();
          }
          parts.push({ type: "expr", value: expr });
        } else current += adv();
      }
      if (peek() !== '"')
        throw new LexError("unterminated string", startLine, startCol);
      adv();
      if (hasInterp) {
        if (current) parts.push({ type: "lit", value: current });
        push(TT.STRING, JSON.stringify(parts), startLine, startCol);
        // mark it as interpolated via a special prefix
        toks[toks.length - 1].interp = parts;
      } else {
        push(TT.STRING, current, startLine, startCol);
      }
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let id = "";
      while (/[A-Za-z0-9_]/.test(peek())) id += adv();
      const tt = KEYWORDS[id] ?? TT.IDENT;
      push(tt, id, startLine, startCol);

      // js keyword: grab everything between { } as a raw string
      // handles nested braces, strings, template literals, comments, regex
      if (tt === TT.JS) {
        while (i < src.length && (peek() === " " || peek() === "\t" || peek() === "\r" || peek() === "\n")) adv();
        if (peek() !== "{") throw new LexError("expected '{' after 'js'", line, col);
        adv(); // skip opening {
        let depth = 1;
        let body = "";
        while (i < src.length && depth > 0) {
          const ch = peek();

          // single/double quoted strings
          if (ch === '"' || ch === "'") {
            const q = ch;
            body += adv();
            while (i < src.length && peek() !== q) {
              if (peek() === "\\") body += adv();
              body += adv();
            }
            if (i < src.length) body += adv();
            continue;
          }

          // template literals (backticks) — handle ${} nesting
          if (ch === "`") {
            body += adv();
            while (i < src.length && peek() !== "`") {
              if (peek() === "\\" ) { body += adv(); body += adv(); continue; }
              if (peek() === "$" && src[i + 1] === "{") {
                body += adv(); body += adv(); // skip ${
                let tdepth = 1;
                while (i < src.length && tdepth > 0) {
                  if (peek() === "{") tdepth++;
                  else if (peek() === "}") tdepth--;
                  if (tdepth > 0) body += adv(); else adv();
                }
                body += "}";
                continue;
              }
              body += adv();
            }
            if (i < src.length) body += adv();
            continue;
          }

          // line comment
          if (ch === "/" && peek(1) === "/") {
            while (i < src.length && peek() !== "\n") body += adv();
            continue;
          }

          // block comment
          if (ch === "/" && peek(1) === "*") {
            body += adv(); body += adv(); // skip /*
            while (i < src.length && !(peek() === "*" && peek(1) === "/")) body += adv();
            if (i < src.length) { body += adv(); body += adv(); } // skip */
            continue;
          }

          // regex literal — heuristic: / after = ( , ; ! & | ? : [ { ~ + - return
          if (ch === "/" && i > 0) {
            // look back at last non-whitespace char in body
            let last = "";
            for (let bi = body.length - 1; bi >= 0; bi--) {
              if (body[bi] !== " " && body[bi] !== "\t" && body[bi] !== "\n") { last = body[bi]; break; }
            }
            if ("=(!,;:&|?[{~+-".includes(last) || body.trimEnd().endsWith("return")) {
              const q = ch;
              body += adv(); // opening /
              while (i < src.length && peek() !== q) {
                if (peek() === "\\") body += adv();
                if (peek() === "\n") break; // regex can't span lines
                body += adv();
              }
              if (i < src.length && peek() === q) body += adv(); // closing /
              while (i < src.length && /[gimsuy]/.test(peek())) body += adv(); // flags
              continue;
            }
          }

          // braces
          if (ch === "{") depth++;
          else if (ch === "}") { depth--; if (depth === 0) { adv(); break; } }

          body += adv();
        }
        if (depth > 0) throw new LexError("unterminated js block", startLine, startCol);
        push(TT.STRING, body.trim(), line, col);
      }

      continue;
    }

    const two = c + peek(1);
    if (two === "~=") {
      adv();
      adv();
      push(TT.FUZZY_ASSIGN, "~=", startLine, startCol);
      continue;
    }
    if (two === "|>") {
      adv();
      adv();
      push(TT.PIPE, "|>", startLine, startCol);
      continue;
    }
    if (two === "->") {
      adv();
      adv();
      push(TT.ARROW, "->", startLine, startCol);
      continue;
    }
    if (two === ">=") {
      adv();
      adv();
      push(TT.GTE, ">=", startLine, startCol);
      continue;
    }
    if (two === "<=") {
      adv();
      adv();
      push(TT.LTE, "<=", startLine, startCol);
      continue;
    }
    if (two === "==") {
      adv();
      adv();
      push(TT.EQ, "==", startLine, startCol);
      continue;
    }
    if (two === "!=") {
      adv();
      adv();
      push(TT.NEQ, "!=", startLine, startCol);
      continue;
    }

    const single = {
      "{": TT.LBRACE,
      "}": TT.RBRACE,
      "(": TT.LPAREN,
      ")": TT.RPAREN,
      "[": TT.LBRACKET,
      "]": TT.RBRACKET,
      ",": TT.COMMA,
      ":": TT.COLON,
      ".": TT.DOT,
      "=": TT.ASSIGN,
      ">": TT.GT,
      "<": TT.LT,
      "@": TT.AT,
      "+": TT.PLUS,
      "-": TT.MINUS,
      "*": TT.STAR,
      "/": TT.SLASH,
    };
    if (single[c]) {
      adv();
      push(single[c], c, startLine, startCol);
      continue;
    }

    throw new LexError(`unexpected character '${c}'`, startLine, startCol);
  }

  push(TT.EOF, "", line, col);
  return toks;
}
