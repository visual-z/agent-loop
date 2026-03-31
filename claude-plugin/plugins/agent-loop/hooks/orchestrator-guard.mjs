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

function isOrchestrator(agentType) {
  if (!agentType) return false;
  return (
    agentType === "agent-loop-orchestrator" ||
    agentType === "agent-loop:agent-loop-orchestrator"
  );
}

async function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function shouldGuard(input) {
  if (isOrchestrator(input.agent_type)) return true;

  const sessionId = input.session_id || null;
  if (!sessionId) return false;

  const cwd = input.cwd || process.cwd();
  const boulder = await readJson(join(cwd, ".agent-loop", "boulder.json"));
  if (!boulder || boulder.status !== "running") return false;

  return boulder.orchestrator_session_id === sessionId;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

const input = parseJson(await readStdin());
if (!(await shouldGuard(input))) {
  process.exit(0);
}

const cwd = input.cwd || process.cwd();
const runtime = await readJson(join(cwd, ".agent-loop", "loop-state.json"));

const toolName = input.tool_name || "";
const toolInput = input.tool_input || {};

if (runtime?.pending_save_progress && toolName === "Agent") {
  deny(
    "Agent Loop runtime requires session recycle. Do not dispatch worker tasks in this session. Open a fresh session and call mcp__agent-loop__agent_loop_resume."
  );
  process.exit(0);
}

const blockedMutationTools = new Set(["Bash", "Edit", "Write", "NotebookEdit", "PowerShell"]);
if (blockedMutationTools.has(toolName)) {
  deny(
    `Agent Loop policy violation: orchestrator cannot call ${toolName}. Delegate implementation through agent-loop-worker.`
  );
  process.exit(0);
}

if (toolName === "Agent") {
  const target =
    toolInput.subagent_type ||
    toolInput.agent_type ||
    toolInput.agent ||
    toolInput.subagent ||
    toolInput.name ||
    null;

  const allowed = new Set(["agent-loop-worker", "agent-loop:agent-loop-worker"]);
  if (!target || !allowed.has(target)) {
    deny(
      `Agent Loop policy violation: orchestrator may only dispatch agent-loop-worker, received: ${target || "(missing)"}`
    );
    process.exit(0);
  }
}

process.exit(0);
