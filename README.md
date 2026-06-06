# suede-lang

A language for AI workflows where cost is visible in the syntax.

Every step that calls a model is marked with `~=`. Every step that doesn't is plain code. You can read the price of a workflow by scanning for the squiggles.

```suede
type Lead {
  domain: text
  priority: text
  note: obj
}

pipeline triage(raw: text) -> Lead {
  let domain  = raw |> after("@") |> before(" ")        # free
  let details ~= extract(raw, fields: [name, budget])   # costs tokens

  if details.budget > 15000 {
    let priority = "hot"
    let note ~= compress(raw, max: 60)
    return @Lead { domain, priority, note }
  } else {
    let priority ~= classify(raw, into: [warm, cold])
    return @Lead { domain, priority, note }
  }
}
```

## Install

```bash
npm install suede-lang
```

## Project structure

A Suede project uses two conventions:

- **`config.suede`** — holds the `init` block (API keys, models, cache, budget). The compiler finds it automatically by walking up from whatever file you run — like `tsconfig.json`. You never import it. Every file in the project can use `with fast` or `with smart` without importing config.

- **`main.suede`** — the entry point. Should contain a `main()` block. All CLI commands (`run`, `check`, `analyze`) default to `main.suede` if no file is specified.

```
my-project/
  config.suede      # init block — models, keys, cache, budget
  main.suede        # entry point with main() block
  helpers.suede     # free functions
  types.suede       # type definitions
```

### config.suede

```suede
init {
  api_keys {
    gemini = env("GEMINI_API_KEY")
  }

  model fast = "gemini-3.5-flash" {
    provider = "gemini"
    temperature = 0.2
    max_tokens = 1024
  }

  model smart = "gemini-3.1-pro-preview" {
    provider = "gemini"
    temperature = 0.7
    max_tokens = 4096
  }

  cache { enabled = true, ttl = 3600 }
  budget { max_tokens = 100000, on_exceed = "stop" }
}
```

### main block

The `main` block is the default entry point. If a file has one, `suede run` uses it automatically:

```suede
main(raw: text) -> Lead {
  let domain  = raw |> after("@") |> before(" ")
  let details ~= extract(raw, fields: [name, budget])
  return @Lead { domain, priority: "new", details }
}
```

If there's no `main`, specify which pipeline or agent to run:

```bash
suede run app.suede my_pipeline --arg raw="data"
```

## Usage

### CLI

```bash
# all commands default to main.suede
suede run --arg raw="email text here"
suede check
suede analyze

# or specify a file
suede run app.suede --arg raw="email text here"

# run a specific pipeline or agent instead of main()
suede run app.suede triage_lead --arg raw="email text here"
```

### Node.js

```js
import { run, stubModel } from "suede-lang";

// with a real provider (config.suede is found from basePath)
const { value, stats } = await run(
  src,
  null,
  { raw: "email text" },
  null,
  null,
  "./",
);

// run a specific pipeline
const { value, stats } = await run(
  src,
  "triage",
  { raw: "email text" },
  null,
  null,
  "./",
);

// with a stub for testing (no API calls)
const { value, stats } = await run(
  src,
  "triage",
  { raw: "email text" },
  stubModel(),
);

stats.modelCalls; // number of ~= calls
stats.codeSteps; // number of = bindings
stats.inputTokens; // total input tokens
stats.outputTokens; // total output tokens
```

### Static analysis

```js
import { compile } from "suede-lang";
import { analyze } from "suede-lang/analyze";

const prog = compile(src, basePath); // basePath needed to find config.suede
const paths = analyze(prog, { raw: "input" }, () => {});

// paths[0].bestTokens, paths[0].worstTokens, paths[0].modelCalls
// paths[0].byModel — per-model breakdown
```

### Browser

A pre-built browser bundle is included at `dist/suede.browser.js`. It exposes `window.Suede` with `run`, `compileWithFiles`, `Interpreter`, `analyze`, and `check`.

```html
<script src="https://unpkg.com/suede-lang/dist/suede.browser.js"></script>
<script>
  const { run, compileWithFiles, Interpreter, analyze, check } = window.Suede;

  // include config.suede in the file map — it's found automatically
  const files = new Map([
    ["config.suede", configSrc],
    ["app.suede", appSrc],
  ]);

  // quick — run a program directly
  const { value, stats } = await run(src, null, { raw: "text" }, modelFn);

  // or compile + run separately
  const prog = compileWithFiles(src, files);
  const interp = new Interpreter(modelFn, onStep);
  const result = await interp.run(prog, null, { raw: "text" });
</script>
```

## The `=` vs `~=` split

- `=` — free, deterministic, instant. String ops, math, branching.
- `~=` — costs tokens. Calls a model. Can fail, gets retried.

The interpreter enforces this both ways. You cannot use `=` on a model verb, and you cannot use `~=` on a plain function.

## Model verbs

Six built-in verbs that require `~=`:

| Verb       | Purpose                          | Returns                 |
| ---------- | -------------------------------- | ----------------------- |
| `extract`  | Pull structured fields from text | `{ field: value, ... }` |
| `classify` | Categorize into one of N labels  | `{ label: "category" }` |
| `compress` | Summarize/shorten text           | `{ text: "summary" }`   |
| `rewrite`  | Transform text style/format      | `{ text: "rewritten" }` |
| `expand`   | Elaborate on text                | `{ text: "expanded" }`  |
| `generate` | Create new content               | `{ field: value, ... }` |

## Rate limiting

You don't configure anything. The runtime learns your provider's rate limits from 429 response headers and adapts automatically — per model, per provider. Failed requests are never dropped; they're re-queued with exponential backoff or the provider's `retry-after` value. A 429 on your `smart` model doesn't slow down `fast`. Works out of the box with OpenAI, Anthropic, and Gemini.

## Types

Define schemas that are enforced at runtime — on record construction, parameter passing, and return values.

```suede
type Analysis {
  mood: text
  score: num
  tags: list
}

pipeline analyze(text: text) -> Analysis {
  let result ~= extract(text, fields: [mood, score, tags])
  return @Analysis { mood: result.mood, score: result.score, tags: result.tags }
}
```

Field types: `text`, `num`, `bool`, `list`, `obj`, `any`

**What gets checked:**

- `@Analysis { ... }` — missing fields, extra fields, wrong types
- `-> Analysis` on a pipeline/agent/function — return value must match the schema
- `(data: Analysis)` — parameter must match the schema when passed in
- If a return type is a custom name (not `text`, `num`, etc.), a matching `type` block must exist

Records without a matching `type` block (`@Foo { ... }` with no `type Foo`) are untyped — no enforcement.

## Errors

Define typed errors, throw them from anywhere (bypasses return type checks), catch them by type. The static checker warns when you call a pipeline that throws without catching.

```suede
error ApiFailed {
  status: num
  url: text
}

pipeline fetch_data(url: text) -> obj {
  let res = fetch(url)
  if res.status != 200 {
    throw ApiFailed("request failed", status: res.status, url: url)
  }
  let data ~= extract(res.body, fields: [name, value]) with fast
  return data
}

pipeline go(url: text) -> obj {
  try {
    return fetch_data(url)
  } catch ApiFailed as err {
    return @Fallback { error: "API ${err.url} returned ${err.status}" }
  }
}
```

Built-in runtime errors are also catchable: `TimedOut`, `BudgetExceeded`, `AgentMaxIterations`, `RateLimited`.

## Language features

- **Types** — schema declarations with runtime enforcement on records, params, and returns
- **Errors** — typed error definitions with `throw`/`catch`, static enforcement of error handling, built-in runtime errors (`TimedOut`, `BudgetExceeded`, `AgentMaxIterations`, `RateLimited`)
- **Pipelines** — linear processing, top to bottom, returns a value
- **Agents** — goal-seeking loops with tools (including other agents), memory, and max iteration caps
- **Custom prompts** — define your own model verbs with typed returns
- **Functions** — free helper functions, no model calls
- **config.suede** — project-wide init block, auto-discovered by walking up the directory tree
- **main block** — default entry point, runs automatically with `suede run`
- **Multi-file imports** — selective or namespace imports with cycle detection
- **Control flow** — `if`/`else`, `for`/`in`/`into`/`emit`, `match`/`case`, `try`/`catch`, `throw`, `recurse`
- **Parallel** — `parallel { }` for concurrent model calls, `parallel for` for concurrent loop iterations
- **Modifiers** — `with`, `retry`, `cache`, `timeout`, `system`, `expect`, `guard`
- **Built-ins** — 50+ free functions for strings, lists, math, objects, filtering, JSON parsing, plus `map`
- **I/O** — `fetch(url)`, `read(path)`, `env(key)` — free, no tokens, async under the hood
- **JavaScript escape** — `js { }` blocks for anything else
- **Multi-provider** — mix Gemini, OpenAI, and Anthropic models in the same program (or inject your own)
- **Adaptive rate limiting** — zero config, learns provider limits from 429 responses, per-model queuing
- **Cost controls** — caching, token budgets

## Try it

[Playground](https://james-pritchard.com/playground) — run Suede in the browser with the full static analyzer.

## License

MIT
