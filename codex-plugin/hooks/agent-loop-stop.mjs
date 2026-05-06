#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LEASE_FILE = ".stop-hook-lease.json";
const LEASE_WINDOW_MS = 5000;

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

function readyTasks(state) {
  const done = new Set(
    (state.tasks || [])
      .filter((task) => task.status === "done")
      .map((task) => task.key),
  );
  return (state.tasks || []).filter((task) => {
    if (!["pending", "failed"].includes(task.status)) return false;
    return (task.depends_on || []).every((dep) => done.has(dep));
  });
}

function inFlightTasks(state) {
  return (state.tasks || []).filter((task) => task.status === "in-progress");
}

function shouldContinue(state) {
  if (!state || state.status !== "running") return false;
  if (state.continue_on_stop !== true) return false;
  if (state.awaiting_user === true) return false;
  if (state.stop_hook_active === true) return false;
  return readyTasks(state).length > 0 || inFlightTasks(state).length > 0;
}

async function leaseAllowsContinuation(loopDir, state) {
  const leasePath = join(loopDir, LEASE_FILE);
  const signature = JSON.stringify({
    status: state.status,
    updated_at: state.updated_at || null,
    next_action: state.next_action || null,
    tasks: (state.tasks || []).map((task) => [task.key, task.status, task.attempts || 0]),
  });

  if (existsSync(leasePath)) {
    try {
      const lease = await readJson(leasePath);
      const sameState = lease.signature === signature;
      const tooSoon = Date.now() - Number(lease.created_at_ms || 0) < LEASE_WINDOW_MS;
      if (sameState && tooSoon) return false;
    } catch {
      // Ignore malformed leases; the next write repairs them.
    }
  }

  await writeFile(
    leasePath,
    JSON.stringify({ signature, created_at_ms: Date.now() }, null, 2),
  );
  return true;
}

function continuationContext({ loopId, state, ready, inFlight }) {
  const taskLines = ready
    .slice(0, 6)
    .map((task) => `- ${task.key}: ${task.title}`)
    .join("\n");
  const inFlightLines = inFlight
    .slice(0, 6)
    .map((task) => `- ${task.key}: ${task.title}`)
    .join("\n");

  return [
    "Agent Loop continuation requested by the Stop hook.",
    "",
    `Loop: ${loopId}`,
    `Objective: ${state.objective || "(not recorded)"}`,
    `Next action: ${state.next_action || "Read state, process handoffs, and continue the next safe step."}`,
    "",
    "Before doing work:",
    "1. Read `.agent-loop/codex/active-loop.json` and the active loop `state.json`.",
    "2. Process any new worker handoff files and update state before dispatching more work.",
    "3. Choose the smallest safe ready batch. Prefer subagents for task execution.",
    "4. Stop and set `awaiting_user: true` if user input is needed, verification fails in a way you cannot fix, or all tasks are blocked.",
    "5. Mark `status: completed` only after a completion audit maps the objective and every task to concrete evidence.",
    "",
    ready.length ? `Ready tasks:\n${taskLines}` : "Ready tasks: none",
    inFlight.length ? `In-flight tasks:\n${inFlightLines}` : "In-flight tasks: none",
  ].join("\n");
}

async function main() {
  const stateRoot = findCodexStateRoot(process.cwd());
  if (!stateRoot) return writeJson({});

  let active;
  try {
    active = await readJson(join(stateRoot, "active-loop.json"));
  } catch {
    return writeJson({});
  }

  const loopId = active.loop_id;
  if (!loopId) return writeJson({});

  const loopDir = join(stateRoot, "loops", loopId);
  let state;
  try {
    state = await readJson(join(loopDir, "state.json"));
  } catch {
    return writeJson({});
  }

  if (!shouldContinue(state)) return writeJson({});
  if (!(await leaseAllowsContinuation(loopDir, state))) return writeJson({});

  const ready = readyTasks(state);
  const inFlight = inFlightTasks(state);
  const context = continuationContext({ loopId, state, ready, inFlight });

  writeJson({
    decision: "block",
    reason: `Continue Agent Loop ${loopId}`,
    additionalContext: context,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: context,
    },
  });
}

main().catch((error) => {
  writeJson({
    decision: "block",
    reason: `Agent Loop Stop hook failed safely: ${error.message}`,
  });
});
