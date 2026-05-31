# Suede Language Reference

Suede is a language for building AI pipelines and agents where cost is visible in the syntax.

## Core Concepts

### The `=` vs `~=` Split

Every binding in Suede uses one of two assignment operators:

- `=` — **free, deterministic, instant**. String ops, math, branching, lookups. No model call.
- `~=` — **costs tokens**. Calls a model. Can fail, gets retried. The cost is visible at a glance.

The interpreter enforces this both ways: you cannot use `=` on a model verb, and you cannot use `~=` on a plain function.

```suede
let domain = raw |> after("@")          # free
let details ~= extract(raw, fields: [name])  # costs tokens
```

### All Model Responses Are JSON

Every `~=` call returns a JSON object — never a bare string or number. Access fields explicitly:

```suede
let category ~= classify(text, into: [bug, feature])
# category is { label: "bug" }, not "bug"
if category.label == "bug" { ... }

let summary ~= compress(text, max: 100)
# summary is { text: "short version" }, not "short version"
log summary.text

let info ~= extract(text, fields: [name, age])
# info is { name: "Alice", age: 30 }
log info.name

let reply ~= generate(text, format: [greeting, body])
# reply is { greeting: "Hi", body: "..." }
log reply.greeting
```

## Types

Define schemas that are enforced at runtime. Types check three things: record construction, parameter passing, and return values.

```suede
type Analysis {
  mood: text
  score: num
  tags: list
}

pipeline analyze(text: text) -> Analysis {
  let result ~= extract(text, fields: [mood, score, tags])
  return @Analysis {
    mood: result.mood,
    score: result.score,
    tags: result.tags
  }
}
```

### Field Types

`text`, `num`, `bool`, `list`, `obj`, `any`

### What Gets Checked

**Record construction** — `@Analysis { ... }` validates missing fields, extra fields, and wrong types:

```suede
return @Analysis { mood: "happy" }
# error: @Analysis is missing required field 'score'

return @Analysis { mood: "happy", score: "high", tags: [] }
# error: @Analysis.score expected type 'num', got string

return @Analysis { mood: "happy", score: 9, tags: [], extra: true }
# error: @Analysis has unexpected field 'extra'
```

**Return types** — if a pipeline/agent/function declares `-> Analysis`, the return value is checked against the schema:

```suede
pipeline go(x: text) -> Analysis {
  return 42
  # error: return from 'go': expected Analysis (object), got number
}
```

**Parameter types** — if a parameter is typed with a custom type, the passed value is validated:

```suede
pipeline process(data: Analysis) -> text {
  return data.mood
}
# passing { mood: "happy" } errors: missing required field 'score'
```

**Return type existence** — if a return type is a custom name (capitalized, not `text`/`num`/etc.), a matching `type` block must exist or you get a parse error.

**Untyped records** — `@Foo { ... }` with no `type Foo` block works with no enforcement.

## Errors

Define typed errors with structured fields. Errors can be thrown from anywhere and bypass return type checks — every pipeline is implicitly `-> ReturnType | Error`.

```suede
error NotFound {
  query: text
}

error RateLimited {
  retry_after: num
}
```

### throw

Throw a typed error or a bare string. Typed throws validate fields against the error schema.

```suede
# typed — fields are checked against the error definition
throw NotFound("user not found", query: search_term)

# bare — no type needed, just a message
throw "something went wrong"
```

### try / catch

Catch blocks match by error type. Multiple typed catches stack top-to-bottom, first match wins. An untyped `catch err` is a catch-all fallback.

```suede
try {
  let result = find(query)
  return result
} catch NotFound as err {
  # err.message = "user not found", err.query = search_term
  return @Fallback { query: err.query }
} catch RateLimited as err {
  log "retry after ${err.retry_after}s"
  return @Fallback { message: "rate limited" }
} catch err {
  # catches everything else
  return @Fallback { message: err.message }
}
```

### Built-in Runtime Errors

Four runtime conditions are thrown as typed errors, catchable in Suede code:

| Error Type            | When                                           | Fields                          |
| --------------------- | ---------------------------------------------- | ------------------------------- |
| `TimedOut`            | A `~=` call exceeds its `timeout`              | `timeout` (ms), `line`          |
| `BudgetExceeded`      | Cumulative tokens exceed `budget.max_tokens`   | `used` (tokens), `max` (tokens) |
| `AgentMaxIterations`  | An agent hits its `max N` without returning    | `agent` (name), `max` (count)   |
| `RateLimited`         | Provider returns 429 after all retries exhausted | `model` (id), `retries` (count) |

```suede
pipeline go(text: text) -> obj {
  try {
    let result = risky_agent(text)
    return result
  } catch AgentMaxIterations as err {
    return @Partial { agent: err.agent, note: "gave up after ${err.max} iterations" }
  } catch TimedOut as err {
    return @Partial { note: "timed out after ${err.timeout}ms" }
  }
}
```

### Static Enforcement

The static checker (`suede check`) warns when you call a pipeline that can throw without catching the error:

```
line 12: 'find' can throw 'NotFound' but it is not caught — add catch NotFound as err { }
```

A catch-all `catch err` silences all warnings for that try block.

## Init Block

Configures API keys, models, rate limits, caching, and budgets. Each model declares its own provider, so you can mix providers in a single program.

```suede
init {
  api_keys {
    gemini = env("GEMINI_API_KEY")
    anthropic = env("ANTHROPIC_API_KEY")
  }

  system = "You are a helpful assistant"   # default system prompt for all ~= calls

  model fast = "gemini-3.5-flash" {
    provider = "gemini"
    temperature = 0.2
    max_tokens = 256
  }

  model smart = "claude-sonnet-4-6" {
    provider = "anthropic"
    temperature = 0.7
    max_tokens = 4096
  }

  cache {                   # model call caching
    enabled = true
    ttl = 3600
  }

  budget {                  # cost cap per run
    max_tokens = 100000
    on_exceed = "stop"      # or "warn"
  }
}
```

**Multi-provider:** each model block has a `provider` field (`"gemini"`, `"anthropic"`, or `"openai"`). Keys are declared once in `api_keys`, matched by provider name. Models on different providers get independent rate limiting queues.

## Imports

Suede supports multi-file programs with selective or namespace imports.

```suede
# selective — pull specific pipelines/functions by name
import { triage_lead, score } from "./triage.suede"

# namespace — import everything, accessed as helpers.foo
import helpers from "./helpers.suede"
```

Imports are resolved recursively with cycle detection. Imported items (pipelines, agents, functions, prompts, types) merge into the current program.

## Pipelines

Linear processing — runs once, top to bottom, returns a value. Parameters can have default values — required params must come first.

```suede
type Result {
  info: obj
  summary: obj
}

pipeline process(input: text, max_len: num = 100, style: text = "formal") -> Result {
  let info ~= extract(input, fields: [name, email]) with fast
  let summary ~= compress(input, max: max_len) with fast
  return @Result { info, summary }
}
```

Callers can omit args that have defaults:

```suede
let result = process(raw_text)                      # max_len=100, style="formal"
let result = process(raw_text, 200)                 # style="formal"
let result = process(raw_text, 200, "casual")       # all explicit
```

Default values work on pipelines, agents, functions, and custom prompts.

## Agents

Goal-seeking loops — run until resolved or max iterations hit. Agents can use tools, including other agents.

```suede
type Resolution {
  answer: text
  attempts: num
}

agent support_bot(ticket: text) -> Resolution max 8 {
  tools {
    search_kb(query: text) -> text
    escalate(reason: text) -> bool
  }

  memory {
    attempts: num = 0
    context: text = ""
  }

  loop {
    let attempts = attempts + 1
    let plan ~= generate(ticket, format: [thought, action]) with smart
    let result = use("search_kb", plan.action)
    let context = concat(context, result)
    let status ~= classify(result, into: [resolved, stuck]) with fast

    if status.label == "resolved" {
      return @Resolution { answer: result, attempts }
    }
  }
}
```

**Key rules:**

- `max N` is mandatory — caps iterations, makes cost bounded
- `tools { }` declares available tools with typed signatures
- `memory { }` declares state that persists across loop iterations (with typed defaults)
- `loop { }` is the agent turn cycle — runs until `return` or max hit
- `use(tool_name, args...)` dispatches to a declared tool
- Tools resolve to: functions, pipelines, agents in the same program, or host-provided implementations
- If max iterations hit without return, throws `AgentMaxIterations` (catchable with `try/catch`)

### Agents as Tools

An agent can declare another agent as a tool:

```suede
agent researcher(topic: text) -> obj max 5 {
  loop {
    let summary ~= compress(topic, max: 100)
    return @Result { answer: summary.text }
  }
}

agent coordinator(question: text) -> obj max 3 {
  tools {
    researcher(topic: text) -> obj
  }
  loop {
    let result = use("researcher", question)
    return @Answer { result }
  }
}
```

## Model Verbs

Six built-in verbs that require `~=`. All return JSON objects.

| Verb       | Purpose                          | Returns                    |
| ---------- | -------------------------------- | -------------------------- |
| `extract`  | Pull structured fields from text | `{ field: value, ... }`    |
| `classify` | Categorize into one of N labels  | `{ label: "category" }`    |
| `compress` | Summarize/shorten text           | `{ text: "summary" }`      |
| `rewrite`  | Transform text style/format      | `{ text: "rewritten" }`    |
| `expand`   | Elaborate on text                | `{ text: "expanded" }`     |
| `generate` | Create new content from a prompt | `{ field: value, ... }`    |

```suede
let info ~= extract(message, fields: [name, email, issue]) with fast
log info.name                          # "Alice"

let category ~= classify(message, into: [bug, feature, question]) with fast
log category.label                     # "bug"

let summary ~= compress(message, max: 100) with fast
log summary.text                       # "short version"

let summary ~= compress(message, max: 100, preserve: [budget, timeline]) with fast
# preserve: ensures these details survive the compression

let formal ~= rewrite(message, style: "professional") with smart
log formal.text                        # "rewritten text"

let detail ~= expand(summary.text, max: 500) with smart
log detail.text                        # "expanded text"

let reply ~= generate(summary.text, format: [greeting, solution, closing]) with smart
log reply.greeting                     # "Hello"
```

### Modifiers on `~=` Calls

Modifiers chain after the model verb call:

```suede
let x ~= extract(text, fields: [name, age]) with fast retry 3 cache timeout 5000
  system "Extract precisely, no extra fields"
  expect { name: text, age: num }
  guard { x.name != "" and x.age > 0 }
```

| Modifier                   | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `with <alias>`             | Route to a named model                         |
| `retry N`                  | Auto-retry on failure up to N times            |
| `cache`                    | Cache result (requires cache config in init)   |
| `timeout N`                | Fail if model call takes longer than N ms      |
| `system <expr>`            | Set the system prompt for this call            |
| `expect { field: type }`   | Validate output schema (type check)            |
| `guard { expr }`           | Validate output semantics (auto-retries)       |

**`expect` types:** `text`, `num`, `bool`, `list`, `obj`

**`timeout`** works with `retry` — if a call times out, it counts as a failure and triggers the next retry attempt:

```suede
let x ~= compress(text, max: 100) with slow retry 2 timeout 3000
# if the call takes > 3 seconds, retry up to 2 times
```

### System Prompts

Set a default system prompt in the init block. Override per-call with `system`.

```suede
init {
  system = "You are a precise data extraction engine"
}

pipeline go(text: text) -> obj {
  # uses the init-level system prompt
  let info ~= extract(text, fields: [name]) with fast

  # overrides with a per-call system prompt
  let summary ~= compress(text, max: 100) with fast
    system "Summarize in a formal academic tone"

  return @Result { info, summary }
}
```

### Guard

Guard validates the *meaning* of model output, not just its shape. If the guard expression returns false, the call retries (up to the `retry` count). The result is bound to the variable name inside the guard expression.

```suede
let info ~= extract(text, fields: [name, email]) with fast retry 3
  guard { has(info, "name") and info.name != "" }
```

If retries are exhausted and the guard still fails, throws a runtime error.

## Custom Prompts

Define your own model verbs with typed returns. Useful when the six built-in verbs don't fit your use case.

```suede
prompt score(text: text, criteria: list) -> num {
  "Rate this text 1-10 based on: ${criteria}. Text: ${text}. Return ONLY the number."
}

prompt is_spam(text: text) -> bool {
  "Is this text spam? ${text}. Return true or false."
}

prompt analyze_tone(text: text) -> obj {
  "Analyze the tone of: ${text}. Return JSON with mood and confidence fields."
}

pipeline review(doc: text) -> obj {
  let quality ~= score(doc, criteria: ["clarity", "depth"])
  let spam ~= is_spam(doc)
  let tone ~= analyze_tone(doc)
  return @Review { quality, spam, tone }
}
```

Custom prompts:
- Require `~=` (they call a model, just like built-in verbs)
- Support return types: `text`, `num`, `bool`, `obj`, `list`
- The body is a single string expression (the template) with interpolation
- Parameters are available inside the template via `${param}`
- Support all modifiers: `with`, `retry`, `cache`, `timeout`, `system`, `expect`, `guard`

## Control Flow

### if / else

```suede
if score > 0.8 and not is_flagged {
  return "approved"
} else if score > 0.5 {
  return "review"
} else {
  return "rejected"
}
```

### match

Pattern matching for clean multi-way branching. Compares the expression against each case using `==`. Falls through to `else` if no case matches.

```suede
let action ~= classify(input, into: [search, escalate, close])

match action.label {
  case "search" {
    let results = use("search_kb", input)
    return results
  }
  case "escalate" {
    use("escalate", input)
    return "escalated"
  }
  case "close" {
    return "closed"
  }
  else {
    return "unknown action"
  }
}
```

Works with any value type — strings, numbers, booleans:

```suede
match priority {
  case 1 { return "critical" }
  case 2 { return "high" }
  case 3 { return "normal" }
  else { return "low" }
}
```

### for / in / into / emit

```suede
# simple loop
for item in items {
  log item
}

# collecting loop
for item in items into summaries {
  let s ~= compress(item, max: 50) with fast
  emit s
}
return summaries
```

### parallel for

Run all loop iterations concurrently. Same as `for`, just add `parallel` in front.

```suede
parallel for resume in resumes into results {
  let candidate = screen_one(resume, job)
  emit candidate
}
```

Order of results matches the input order, but iterations run as `Promise.all` under the hood.

### map

Two forms — field pluck with a string, or function/pipeline call per item:

```suede
# pluck a field from each item
let names = map(items, "name")

# call a function on each item
function double(n: num) -> num {
  return n * 2
}
let doubled = map(nums, double())

# call a pipeline on each item
let processed = map(items, process())

# pass extra args to the function
function scale(n: num, factor: num) -> num {
  return n * factor
}
let scaled = map(nums, scale(10))
```

The two forms are syntactically distinct: a string literal always plucks a field, a function call always invokes per item with the item as the first argument.

### par (parallel)

```suede
parallel {
  let summary ~= compress(text, max: 100) with fast
  let sentiment ~= classify(text, into: [positive, negative]) with fast
  let entities ~= extract(text, fields: [people, places]) with fast
}
```

### try / catch

Supports typed catches (match a specific error type) and untyped catch-all. See the [Errors](#errors) section for full details.

```suede
try {
  let result ~= extract(text, fields: [name]) with fast retry 2
  return result
} catch TimedOut as err {
  return @Fallback { error: "timed out after ${err.timeout}ms" }
} catch err {
  return @Fallback { error: err.message }
}
```

### recurse

```suede
pipeline summarize(chunks: list) -> text {
  if len(chunks) <= 1 {
    return chunks |> join(", ")
  } else {
    let half = len(chunks) / 2
    let left = recurse(slice(chunks, 0, half))
    let right = recurse(slice(chunks, half, len(chunks)))
    let merged ~= compress(concat(left, right), max: 200) with fast
    return merged
  }
}
```

Parser enforces: must be inside `if` (base case required), arg count must match.

## JavaScript Escape

`js { }` blocks let you run raw JavaScript for I/O — HTTP calls, file access, anything the host runtime supports. All Suede variables in scope are available inside the block.

```suede
pipeline fetch_and_analyze(url: text) -> obj {
  let html = js {
    const res = await fetch(url);
    return await res.text();
  }
  let summary ~= compress(html, max: 200) with fast
  return summary
}
```

The block runs as an async function. Use `return` to pass a value back to Suede. The `js` block uses `=` (not `~=`) — it's free code, not a model call.

## Expressions

### Pipe Operator `|>`

```suede
let domain = raw |> after("@") |> before(" ") |> lower()
```

### String Interpolation

```suede
let greeting = "Hello ${name}, your ticket is ${ticket.id}"
```

### Record Literals

```suede
return @Lead { domain, priority, note }
# shorthand for: @Lead { domain: domain, priority: priority, note: note }
```

### Operators

| Operator             | Description    |
| -------------------- | -------------- |
| `+`, `-`, `*`, `/`   | Arithmetic     |
| `>`, `<`, `>=`, `<=` | Comparison     |
| `==`, `!=`           | Equality       |
| `and`, `or`          | Logical        |
| `not`                | Unary negation |
| `-`                  | Unary minus    |
| `\|>`                | Pipe           |

### Literals

`42`, `3.14`, `"hello"`, `true`, `false`, `null`, `[1, 2, 3]`, `@Name { ... }`

## Built-in Functions (Free)

### String

| Function                 | Description                   |
| ------------------------ | ----------------------------- |
| `after(s, sep)`          | Everything after first `sep`  |
| `before(s, sep)`         | Everything before first `sep` |
| `trim(s)`                | Strip whitespace              |
| `lower(s)` / `upper(s)`  | Case conversion               |
| `contains(s, sub)`       | Returns bool                  |
| `starts_with(s, prefix)` | Returns bool                  |
| `ends_with(s, suffix)`   | Returns bool                  |
| `split(s, sep)`          | Split into list               |
| `replace(s, from, to)`   | Replace all                   |
| `len(s)`                 | Length                        |

### List

| Function                       | Description                              |
| ------------------------------ | ---------------------------------------- |
| `len(list)`                    | Length                                   |
| `slice(list, start, end)`      | Sublist                                  |
| `join(list, sep)`              | Join into string                         |
| `concat(a, b)`                 | Concatenate                              |
| `filter_in(list, allowed)`     | Keep matching                            |
| `first(list)` / `last(list)`   | First/last element                       |
| `unique(list)`                 | Deduplicate                              |
| `sort(list)` / `reverse(list)` | Reorder                                  |
| `flat(list)`                   | Flatten nested                           |
| `range(n)`                     | 0 to n-1                                |
| `map(list, "field")`           | Pluck a field from each item             |
| `map(list, func())`            | Call a function/pipeline on each item    |

### Math

| Function    | Description              |
| ----------- | ------------------------ |
| `min(a, b)` | Minimum (also takes a list: `min([1, 2, 3])`) |
| `max(a, b)` | Maximum (also takes a list: `max([1, 2, 3])`) |
| `abs(n)`    | Absolute value           |
| `round(n)`  | Round to nearest integer |
| `floor(n)`  | Round down               |
| `ceil(n)`   | Round up                 |

### Object

`keys(obj)`, `values(obj)`, `has(obj, key)`

### Filtering

| Function | Description |
| --- | --- |
| `filter(list, key, value)` | Keep items where `item[key] == value` |
| `filter_gt(list, key, value)` | Keep items where `item[key] > value` |
| `filter_gte(list, key, value)` | Keep items where `item[key] >= value` |
| `filter_lt(list, key, value)` | Keep items where `item[key] < value` |
| `filter_lte(list, key, value)` | Keep items where `item[key] <= value` |

```suede
let hot_leads = filter_gte(leads, "score", 8)
let cold_leads = filter_lt(leads, "score", 3)
let bugs = filter(tickets, "type", "bug")
```

### Parsing

| Function | Description |
| --- | --- |
| `parse_json(s)` | Parse a JSON string into an object/list |
| `to_json(x)` | Serialize a value to a JSON string |

### Utility

`default(val, fallback)`, `to_num(s)`, `to_text(x)`, `is_empty(x)`, `not(x)`

### I/O

These are free (`=`), async under the hood, but feel synchronous in Suede.

| Function | Description |
| --- | --- |
| `fetch(url)` | HTTP GET, returns `{ status, body }` |
| `fetch(url, method: "POST", body: data)` | HTTP with method/body |
| `fetch(url, auth: "Bearer ...")` | Shorthand for Authorization header |
| `fetch(url, headers: obj)` | Full header control (build obj via `js { }`) |
| `read(path)` | Read a file, returns text (Node.js only) |
| `env(key)` | Read an environment variable, returns text or `null` |

`fetch` returns an object with `status` (number) and `body` (text). Branch on status before using the body:

```suede
let res = fetch("https://api.example.com/leads")
if res.status != 200 {
  throw "API returned ${res.status}"
}
let parsed ~= extract(res.body, fields: [name, budget])
```

POST with a string body:

```suede
let res = fetch("https://api.example.com/submit", method: "POST", body: payload)
```

Object bodies are auto-serialized as JSON with `Content-Type: application/json`:

```suede
let data = js { return { name: "Alice", amount: 5000 } }
let res = fetch("https://api.example.com/leads", method: "POST", body: data)
```

Auth shorthand sets the `Authorization` header:

```suede
let key = env("API_KEY")
let res = fetch("https://api.example.com/data", auth: "Bearer ${key}")
```

Read a config file:

```suede
let rules = read("./rules.json")
```

Read an environment variable:

```suede
let key = env("OPENAI_API_KEY")
```

### Debugging

`log expr` — prints to the debugger trace

## Rate Limiting

Rate limiting is fully automatic. You don't configure anything — the runtime learns your provider's limits from 429 responses and adapts.

When a model call hits a 429:
1. The runtime parses the provider's response headers to learn the actual limit (RPM, TPM, retry-after)
2. The failed request is re-queued — no requests are lost
3. Exponential backoff is applied, or the provider's `retry-after` value is used
4. Once the limit is learned, subsequent requests are spaced to stay under it

Each model has its own queue and rate state. A 429 on `smart` doesn't slow down `fast`.

All three providers are handled:
- **OpenAI**: `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-reset-requests`
- **Anthropic**: `retry-after`, `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-input-tokens-limit`, `anthropic-ratelimit-output-tokens-limit`
- **Gemini**: `retry-after`, `x-ratelimit-limit-requests`, plus `quota_metric` from the error body

Pipeline authors never see 429 errors — the runtime queues, throttles, and retries automatically.

## Caching

Opt-in per `~=` call with the `cache` keyword:

```suede
let summary ~= compress(text, max: 100) with fast cache
```

Same input + verb + model → cached result. Configured in init with TTL.

## Cost Budgets

```suede
init {
  budget {
    max_tokens = 100000
    on_exceed = "stop"   # throws BudgetExceeded, catchable with try/catch
  }
}
```

Runtime checks cumulative tokens before each model call.

## Runtime API

```javascript
import { run, compile, stubModel } from "suede-lang";

// basic pipeline
const { value, stats } = await run(
  src,
  "pipeline_name",
  { arg: "value" },
  modelFn,
);

// with all options — last arg is an options object
const { value, stats } = await run(
  src,
  "agent_name",
  args,
  modelFn,
  onStepCallback,
  {
    basePath: "./",           // for resolving imports
    tools: {                  // host-provided tool implementations
      search_kb: async (query) => {
        /* ... */
      },
      escalate: async (reason) => {
        /* ... */
      },
    },
  },
);

// stats object
stats.modelCalls; // number of ~= calls
stats.codeSteps; // number of = bindings
stats.inputTokens; // total input tokens
stats.outputTokens; // total output tokens
stats.toolCalls; // number of use() calls (agents)
stats.agentIterations; // number of loop iterations (agents)
stats.cacheHits; // number of cache hits
stats.trace; // per-step trace array
```
