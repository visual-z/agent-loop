#!/usr/bin/env bun

import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

async function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

async function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

function isOrchestrator(agentType) {
  return (
    agentType === "agent-loop-orchestrator" ||
    agentType === "agent-loop:agent-loop-orchestrator"
  );
}

/**
 * Resolve the active loop's boulder.json and loop-state.json paths.
 * Returns { boulder, boulderPath, runtime, runtimePath, loopId } or null.
 */
async function resolveActiveLoop(cwd) {
  // Try new multi-instance layout first
  const pointerPath = join(cwd, ".agent-loop", "active-loop.json");
  const pointer = await readJson(pointerPath);
  if (pointer?.loop_id) {
    const loopDir = join(cwd, ".agent-loop", "loops", pointer.loop_id);
    const bPath = join(loopDir, "boulder.json");
    const rPath = join(loopDir, "loop-state.json");
    return {
      loopId: pointer.loop_id,
      boulderPath: bPath,
      runtimePath: rPath,
      boulder: await readJson(bPath),
      runtime: await readJson(rPath),
    };
  }

  // Fall back to old single-instance layout
  const bPath = join(cwd, ".agent-loop", "boulder.json");
  const rPath = join(cwd, ".agent-loop", "loop-state.json");
  const boulder = await readJson(bPath);
  if (boulder) {
    return {
      loopId: boulder.plan_name || null,
      boulderPath: bPath,
      runtimePath: rPath,
      boulder,
      runtime: await readJson(rPath),
    };
  }

  return null;
}

async function shouldInject(input) {
  if (isOrchestrator(input.agent_type)) return true;
  const cwd = input.cwd || process.cwd();
  const loop = await resolveActiveLoop(cwd);
  if (!loop?.boulder || loop.boulder.status !== "running") return false;

  const sessionId = input.session_id || null;
  if (!sessionId) return false;
  return loop.boulder.orchestrator_session_id === sessionId;
}

function toText(payload) {
  return JSON.stringify(payload);
}

const input = parseJson(await readStdin());
if (!(await shouldInject(input))) {
  process.exit(0);
}

const cwd = input.cwd || process.cwd();
const loop = await resolveActiveLoop(cwd);

if (!loop?.boulder) {
  process.exit(0);
}

const { boulder, runtime, runtimePath } = loop;

if (runtime && boulder.status === "running") {
  const updatedRuntime = {
    ...runtime,
    active: true,
    pending_save_progress: false,
    iteration: 0,
    stall_count: 0,
    last_state_hash: null,
    session_id: input.session_id || runtime.session_id || null,
  };
  try {
    await writeFile(runtimePath, JSON.stringify(updatedRuntime, null, 2), "utf-8");
  } catch {
    // best effort runtime sync
  }
}

const done = boulder?.stats?.done ?? 0;
const total = boulder?.stats?.total_tasks ?? 0;
const nextTasks = Object.values(boulder.task_sessions || {})
  .filter((task) => task.status === "pending" || task.status === "failed")
  .slice(0, 3)
  .map((task) => `- ${task.task_key}: ${task.task_title} (${task.status})`)
  .join("\n");

const lines = [
  "## Agent Loop Runtime Context",
  `Loop ID: ${loop.loopId || "(unknown)"}`,
  `Plan: ${boulder.plan_name}`,
  `Status: ${boulder.status}`,
  `Progress: ${done}/${total}`,
  `Current Task: ${boulder.current_task || "(none)"}`,
];

if (runtime) {
  lines.push(
    `Runtime: active=${runtime.active} session_id=${runtime.session_id || "(none)"} pending_save_progress=${runtime.pending_save_progress}`
  );
}

if (runtime?.pending_save_progress) {
  lines.push(
    "Session recycle is required. Do not dispatch worker tasks in this session. Open a fresh session and call mcp__agent-loop__agent_loop_resume."
  );
} else if (boulder.status === "running") {
  lines.push(
    "If continuing loop execution, call mcp__agent-loop__agent_loop_runtime_tick with trigger session_start or resume first, then continue normal dispatch/process cycle."
  );
}

if (nextTasks) {
  lines.push("Next candidate tasks:");
  lines.push(nextTasks);
}

process.stdout.write(
  toText({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  })
);
