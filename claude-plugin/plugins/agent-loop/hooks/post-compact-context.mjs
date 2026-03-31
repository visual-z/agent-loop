#!/usr/bin/env bun

import { existsSync } from "fs";
import { readFile } from "fs/promises";
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
 * Resolve the active loop's boulder.json path.
 */
async function resolveActiveLoop(cwd) {
  // Try new multi-instance layout first
  const pointerPath = join(cwd, ".agent-loop", "active-loop.json");
  const pointer = await readJson(pointerPath);
  if (pointer?.loop_id) {
    const loopDir = join(cwd, ".agent-loop", "loops", pointer.loop_id);
    return {
      loopId: pointer.loop_id,
      boulder: await readJson(join(loopDir, "boulder.json")),
    };
  }

  // Fall back to old single-instance layout
  const boulder = await readJson(join(cwd, ".agent-loop", "boulder.json"));
  if (boulder) {
    return {
      loopId: boulder.plan_name || null,
      boulder,
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

function toHookOutput(additionalContext) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostCompact",
      additionalContext,
    },
  });
}

const input = parseJson(await readStdin());
if (!(await shouldInject(input))) {
  process.exit(0);
}

const cwd = input.cwd || process.cwd();
const loop = await resolveActiveLoop(cwd);
if (!loop?.boulder || loop.boulder.status !== "running") {
  process.exit(0);
}

const { boulder, loopId } = loop;

const doneTasks = Object.values(boulder.task_sessions || {})
  .filter((task) => task.status === "done")
  .slice(-5)
  .map((task) => `- done ${task.task_key}: ${task.task_title}`)
  .join("\n");

const pendingTasks = Object.values(boulder.task_sessions || {})
  .filter((task) => task.status === "pending" || task.status === "failed")
  .slice(0, 5)
  .map((task) => `- todo ${task.task_key}: ${task.task_title} (${task.status})`)
  .join("\n");

const loopDir = loopId
  ? `.agent-loop/loops/${loopId}`
  : ".agent-loop";

const context = [
  "## Agent Loop State (post-compaction reinjection)",
  `Loop ID: ${loopId || "(unknown)"}`,
  `Plan: ${boulder.plan_name}`,
  `Status: ${boulder.status}`,
  `Progress: ${boulder.stats?.done || 0}/${boulder.stats?.total_tasks || 0}`,
  `Current task: ${boulder.current_task || "(none)"}`,
  doneTasks ? `Recent completed tasks:\n${doneTasks}` : "Recent completed tasks: (none)",
  pendingTasks ? `Pending/failed tasks:\n${pendingTasks}` : "Pending/failed tasks: (none)",
  `Read ${loopDir}/boulder.json for full state.`,
  `Read ${loopDir}/handoffs/ for latest handoff context.`,
  `Read ${loopDir}/notepads/ for accumulated learnings.`,
  "Use mcp__agent-loop__agent_loop_status and mcp__agent-loop__agent_loop_runtime_tick before next dispatch.",
].join("\n");

process.stdout.write(toHookOutput(context));
