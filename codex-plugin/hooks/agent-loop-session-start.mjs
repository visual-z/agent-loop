#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function findCodexStateRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".agent-loop", "codex");
    if (existsSync(join(candidate, "active-loop.json"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function main() {
  const stateRoot = findCodexStateRoot(process.cwd());
  if (!stateRoot) return writeJson({});

  const active = await readJson(join(stateRoot, "active-loop.json"));
  const loopId = active.loop_id;
  if (!loopId) return writeJson({});

  const state = await readJson(join(stateRoot, "loops", loopId, "state.json"));
  if (!["running", "paused", "blocked", "planning"].includes(state.status)) {
    return writeJson({});
  }

  const tasks = state.tasks || [];
  const done = tasks.filter((task) => task.status === "done").length;
  const context = [
    "Agent Loop state found in this workspace.",
    "",
    `Loop: ${loopId}`,
    `Status: ${state.status}`,
    `Progress: ${done}/${tasks.length}`,
    `Objective: ${state.objective || "(not recorded)"}`,
    "",
    "Use `$agent-loop resume` to continue from `.agent-loop/codex/` rather than relying on chat history.",
  ].join("\n");

  writeJson({
    additionalContext: context,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

main().catch(() => writeJson({}));
