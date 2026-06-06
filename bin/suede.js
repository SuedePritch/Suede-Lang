#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { run, compile, compileWithFiles, check } from "../src/index.js";

const args = process.argv.slice(2);

function usage() {
  console.log(`suede v0.1

Usage:
  suede run [file] [pipeline|agent] [--arg key=value ...]
  suede analyze [file] [pipeline|agent]
  suede check [file]

Defaults to main.suede if no file is given.
Uses the main() block as entry point if present.
Config is loaded from config.suede (walks up the directory tree).

Options:
  --arg key=value    Pass arguments
  --quiet            Suppress trace output
  --json             Output result as JSON

Examples:
  suede run --arg text="input here"
  suede check
  suede analyze
  suede run other.suede my_pipeline --arg raw="data"`);
  process.exit(0);
}

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") usage();

const cmd = args[0];

// figure out if args[1] is a file, an entry name, or a flag
let file = "main.suede";
let argStart = 2;
if (args[1] && !args[1].startsWith("--") && args[1].endsWith(".suede")) {
  file = args[1];
} else if (args[1] && !args[1].startsWith("--")) {
  // could be an entry name — keep file as main.suede
  argStart = 1; // re-parse from args[1]
} else if (args[1] && args[1].startsWith("--")) {
  argStart = 1; // no file, no entry — flags start at args[1]
}

if (!existsSync(file)) {
  console.error(`error: file not found: ${file}`);
  process.exit(1);
}

const filePath = resolve(file);
const src = readFileSync(filePath, "utf-8");
const basePath = dirname(filePath);

// parse entry name and flags
let entryArg = null;
if (args[argStart] && !args[argStart].startsWith("--") && !args[argStart].endsWith(".suede")) {
  entryArg = args[argStart];
  argStart++;
}
const flags = { quiet: false, json: false };
const entryArgs = {};

for (let i = argStart; i < args.length; i++) {
  if (args[i] === "--quiet") {
    flags.quiet = true;
    continue;
  }
  if (args[i] === "--json") {
    flags.json = true;
    continue;
  }
  if (args[i] === "--arg" && args[i + 1]) {
    const eq = args[i + 1].indexOf("=");
    if (eq < 0) {
      console.error(`error: --arg requires key=value, got '${args[i + 1]}'`);
      process.exit(1);
    }
    entryArgs[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
    i++;
    continue;
  }
  // also accept --arg=key=value
  if (args[i].startsWith("--arg=")) {
    const rest = args[i].slice(6);
    const eq = rest.indexOf("=");
    if (eq < 0) {
      console.error(`error: --arg requires key=value`);
      process.exit(1);
    }
    entryArgs[rest.slice(0, eq)] = rest.slice(eq + 1);
    continue;
  }
}

if (cmd === "check") {
  try {
    const prog = compile(src, basePath);
    const issues = check(prog);
    if (issues.length === 0) {
      console.log("ok");
    } else {
      for (const issue of issues) {
        console.error(`  line ${issue.line}: ${issue.message}`);
      }
      console.error(`\n${issues.length} issue${issues.length === 1 ? "" : "s"} found`);
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else if (cmd === "analyze") {
  try {
    const prog = compile(src, basePath);
    const { analyze } = await import("../src/analyze.js");
    const paths = analyze(prog, entryArgs, null, entryArg || null);

    if (!paths || paths.length === 0) {
      console.error("error: no pipeline, agent, or main found to analyze");
      process.exit(1);
    }

    if (flags.json) {
      const summary = paths.map(p => ({
        modelCalls: p.modelCalls,
        codeSteps: p.codeSteps,
        bestTokens: p.bestTokens,
        worstTokens: p.worstTokens,
        byModel: p.byModel,
        budgetWarning: p.budgetWarning || null,
      }));
      console.log(JSON.stringify(summary, null, 2));
    } else {

    // summary
    const entry = entryArg || paths[0]?.steps?.[0]?.name || "main";
    console.log(`analyzing: ${entry}`);
    if (prog.init) {
      const models = Object.keys(prog.init.models);
      if (models.length) console.log(`models: ${models.join(", ")}`);
    }
    console.log(`${paths.length} cost path${paths.length === 1 ? "" : "s"} found\n`);

    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const modelSteps = p.steps.filter(s => s.type === "model");
      console.log(`--- path ${i + 1} ---`);
      console.log(`  model calls: ${p.modelCalls}    code steps: ${p.codeSteps}`);
      console.log(`  tokens: ${p.bestTokens} best / ${p.worstTokens} worst`);

      // per-model breakdown
      for (const [alias, m] of Object.entries(p.byModel)) {
        const best = m.inputTokens + m.bestOut;
        const worst = m.inputTokens + m.worstOut;
        // deduplicate repeated verb+line combos (agents repeat per iteration)
        const raw = modelSteps
          .filter(s => (s.model || "default") === alias)
          .map(s => `${s.verb} (line ${s.line})`);
        const counts = {};
        for (const v of raw) counts[v] = (counts[v] || 0) + 1;
        const verbs = Object.entries(counts)
          .map(([v, c]) => c > 1 ? `${v} x${c}` : v)
          .join(", ");
        console.log(`    ${alias}: ${m.calls} call${m.calls === 1 ? "" : "s"}, ${best}-${worst} tokens — ${verbs}`);
      }

      if (p.budgetWarning) {
        console.log(`  ⚠ ${p.budgetWarning}`);
      }
      console.log();
    }

    } // end if/else json
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
} else if (cmd === "run") {
  const perModel = {};
  const onStep = flags.quiet
    ? undefined
    : (step) => {
        if (step.type === "model:end") {
          process.stderr.write(
            `  ~= ${step.verb}${step.withModel ? ` [${step.withModel}]` : ""} ${step.ms}ms\n`,
          );
          const key = step.withModel || "default";
          if (!perModel[key]) perModel[key] = { calls: 0, ms: 0 };
          perModel[key].calls++;
          perModel[key].ms += step.ms;
        } else if (step.type === "agent:iteration") {
          process.stderr.write(`  loop ${step.iteration}/${step.max}\n`);
        } else if (step.type === "catch") {
          process.stderr.write(`  catch: ${step.error}\n`);
        } else if (step.type === "log") {
          process.stderr.write(
            `  log: ${typeof step.value === "object" ? JSON.stringify(step.value) : step.value}\n`,
          );
        }
      };

  try {
    const startTime = Date.now();
    const { value, stats } = await run(
      src,
      entryArg || null,
      entryArgs,
      null,
      onStep,
      basePath,
    );
    const wallMs = Date.now() - startTime;
    if (flags.json) {
      console.log(JSON.stringify({ value, stats }, null, 2));
    } else {
      if (typeof value === "object" && value !== null) {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(value);
      }
      if (!flags.quiet) {
        process.stderr.write(`\n--- stats ---\n`);
        const totalTokens = stats.inputTokens + stats.outputTokens;
        process.stderr.write(
          `total: ${stats.modelCalls} model calls, ${totalTokens} tokens (${stats.inputTokens} in + ${stats.outputTokens} out), ${(wallMs / 1000).toFixed(1)}s wall\n`,
        );
        // per-model breakdown from trace
        const byModel = {};
        for (const t of stats.trace) {
          if (t.kind !== "model") continue;
          const key = t.model || "default";
          if (!byModel[key]) byModel[key] = { calls: 0, tokens: 0 };
          byModel[key].calls++;
          byModel[key].tokens += t.tokens;
        }
        for (const [model, m] of Object.entries(byModel)) {
          const timing = perModel[model];
          const avgMs = timing ? Math.round(timing.ms / timing.calls) : 0;
          process.stderr.write(
            `  ${model}: ${m.calls} calls, ${m.tokens} tokens${timing ? `, ${(timing.ms / 1000).toFixed(1)}s total (${avgMs}ms avg)` : ""}\n`,
          );
        }
      }
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
} else {
  console.error(`unknown command: ${cmd}`);
  usage();
}
