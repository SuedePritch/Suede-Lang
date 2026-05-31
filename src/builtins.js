// Built-in functions — all free, deterministic, no model calls.
// These use = (never ~=). They cost nothing.

// I/O builtins — still free (=), but async. Receive (positionalArgs, namedArgs).
export const IO_BUILTINS = {
  fetch: async (args, named) => {
    const url = args[0];
    if (!url) throw new Error("fetch(url) — missing url");
    const method = (named.method || "GET").toUpperCase();
    const headers = named.headers || {};
    if (named.auth) headers["Authorization"] = named.auth;
    const opts = { method, headers };
    if (named.body != null) {
      if (typeof named.body === "object") {
        opts.body = JSON.stringify(named.body);
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      } else {
        opts.body = String(named.body);
      }
    }
    let res;
    try {
      res = await globalThis.fetch(url, opts);
    } catch (e) {
      throw new Error(`fetch("${url}") failed: ${e.message}`);
    }
    const body = await res.text();
    return { status: res.status, body };
  },

  read: async (args) => {
    const path = args[0];
    if (!path) throw new Error("read(path) — missing file path");
    let readFile;
    try {
      ({ readFile } = await import("fs/promises"));
    } catch {
      throw new Error("read() is not available in the browser — use fetch() or js { } instead");
    }
    try {
      return await readFile(path, "utf-8");
    } catch (e) {
      throw new Error(`read("${path}") failed: ${e.code === "ENOENT" ? "file not found" : e.message}`);
    }
  },

  env: (args) => {
    const key = args[0];
    if (!key) throw new Error("env(key) — missing key name");
    return (typeof process !== "undefined" && process.env?.[key]) || null;
  },
};

export const BUILTINS = {
  // string ops
  after: (s, sep) => s.slice(s.indexOf(sep) + sep.length),
  before: (s, sep) => {
    const i = s.indexOf(sep);
    return i < 0 ? s : s.slice(0, i);
  },
  trim: (s) => s.trim(),
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  contains: (s, sub) => s.includes(sub),
  starts_with: (s, prefix) => s.startsWith(prefix),
  ends_with: (s, suffix) => s.endsWith(suffix),
  split: (s, sep) => s.split(sep),
  replace: (s, from, to) => s.replaceAll(from, to),

  // list ops
  len: (x) => x.length,
  slice: (list, start, end) => list.slice(start, end),
  join: (list, sep) => list.join(sep || ", "),
  concat: (a, b) => (typeof a === "string" ? a + b : [...a, ...b]),
  filter_in: (list, allowed) => list.filter((x) => allowed.includes(x)),
  first: (list) => list[0],
  last: (list) => list[list.length - 1],
  unique: (list) => [...new Set(list)],
  sort: (list) => [...list].sort(),
  reverse: (list) => [...list].reverse(),
  flat: (list) => list.flat(),
  range: (n) => Array.from({ length: n }, (_, i) => i),
  count: (list) => list.length,

  // object ops
  keys: (obj) => Object.keys(obj),
  values: (obj) => Object.values(obj),
  has: (obj, key) => obj != null && key in obj,

  // math
  min: (...args) => args.length === 1 && Array.isArray(args[0]) ? Math.min(...args[0]) : Math.min(...args),
  max: (...args) => args.length === 1 && Array.isArray(args[0]) ? Math.max(...args[0]) : Math.max(...args),
  abs: (n) => Math.abs(n),
  round: (n) => Math.round(n),
  floor: (n) => Math.floor(n),
  ceil: (n) => Math.ceil(n),

  // filtering
  filter: (list, key, value) => list.filter((item) => item[key] === value),
  filter_gt: (list, key, value) => list.filter((item) => item[key] > value),
  filter_gte: (list, key, value) => list.filter((item) => item[key] >= value),
  filter_lt: (list, key, value) => list.filter((item) => item[key] < value),
  filter_lte: (list, key, value) => list.filter((item) => item[key] <= value),

  // parsing
  parse_json: (s) => JSON.parse(s),
  to_json: (x) => JSON.stringify(x),

  // utility
  default: (val, fallback) => (val == null ? fallback : val),
  to_num: (s) => Number(s),
  to_text: (x) => String(x),
  is_empty: (x) =>
    x == null ||
    (typeof x === "string" && x.length === 0) ||
    (Array.isArray(x) && x.length === 0),
  not: (x) => !x,
};
