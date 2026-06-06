# Changelog

## v0.1.2 (2026-06-06)

### Language

- **`const` keyword** — immutable bindings that don't propagate out of `for` loops or `if` blocks. `let` is now mutable and propagates, `const` stays local.
- **`let` scoping fix** — `let` rebindings inside `for` loops and `if/else` blocks now propagate back to the outer scope. Previously all blocks created isolated copies — accumulators like `let total = total + n` inside loops silently did nothing.
- **String escape sequences** — `\n`, `\t`, `\r`, `\\`, `\"` now produce actual escape characters. Previously `"\n"` produced the literal string `n`.
- **Variadic `concat`** — `concat(a, b, c, d)` now works with any number of arguments. Previously only 2 args were accepted and the rest were silently dropped.

### Project Structure

- **`config.suede`** — project-wide init block, auto-discovered by walking up the directory tree from whatever file you compile. Like `tsconfig.json` or `package.json`. One per project, never imported — always available.
- **`main` block** — the default entry point. `suede run`, `suede check`, and `suede analyze` all default to `main.suede` if no file is given.

### CLI

- **`suede check`** now resolves the full import tree from the root file. Types, errors, init, and all callables are merged before checking. Previously checked files in isolation, causing false positives on imported types.
- **`suede analyze`** follows `return` expressions into called pipelines/agents. Previously `return process(x)` was not walked, missing all model calls in the called pipeline.
- **`suede analyze`** follows `use()` tool calls inside agents, including nested agent-as-tool calls. Previously agent tool dispatch was not traced.
- **`suede analyze`** walks `catch` bodies for model calls. Previously only `try` bodies were analyzed.
- **`suede analyze`** handles `Parallel` blocks as regular statements (walks each one), not just model calls.
- All commands default to `main.suede` when no file is specified.
- Help text updated to reflect new conventions.

### Compiler

- **Import resolution** now merges types, errors, and init from imported files — not just pipelines, functions, agents, and prompts. Previously `suede check` couldn't find types defined in imported files.
- **All callables merged on import** — selective imports (`import { foo } from "./bar.suede"`) now also merge internal helpers from the source file, so the checker and runtime can resolve calls within merged pipeline bodies.
- **Parser defers return-type validation** for files with imports. The check moves to `check.js` post-merge, so imported types don't cause false parse errors.
- **`config.suede` discovery** added to both `compile()` (filesystem, walks up) and `compileWithFiles()` (browser, checks file map). Errors on malformed config.

### Tests

- 31 new tests covering: const/let scoping (7), escape sequences (7), variadic concat (6), config.suede discovery (5), import merging (6).
- All 338 tests passing (307 existing + 31 new).

## v0.1.1

- Fixed browser example script tag in README.

