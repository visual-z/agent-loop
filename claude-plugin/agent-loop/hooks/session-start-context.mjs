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

async function shouldInject(input) {
  if (isOrchestrator(input.agent_type)) return true;
  const cwd = input.cwd || process.cwd();
  const boulder = await readJson(join(cwd, ".agent-loop", "boulder.json"));
  if (!boulder || boulder.status !== "running") return false;

  const sessionId = input.session_id || null;
  if (!sessionId) return false;
  return boulder.orchestrator_session_id === sessionId;
}

function toText(payload) {
  return JSON.stringify(payload);
}

const input = parseJson(await readStdin());
if (!(await shouldInject(input))) {
  process.exit(0);
}

const cwd = input.cwd || process.cwd();
const boulder = await readJson(join(cwd, ".agent-loop", "boulder.json"));
const runtimePath = join(cwd, ".agent-loop", "loop-state.json");
const runtime = await readJson(runtimePath);

if (!boulder) {
  process.exit(0);
}

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
