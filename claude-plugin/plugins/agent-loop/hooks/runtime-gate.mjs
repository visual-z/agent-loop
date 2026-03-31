#!/usr/bin/env bun

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

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

function isOrchestrator(agentType) {
  if (!agentType) return false;
  return (
    agentType === "agent-loop-orchestrator" ||
    agentType === "agent-loop:agent-loop-orchestrator"
  );
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

function emitBlock(reason) {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          "Agent Loop runtime gate blocked stop due to recycle or halt condition. Respect the reason and follow resume/halt flow.",
      },
    })
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

const input = parseJson(await readStdin());
if (!(await shouldGuard(input))) {
  process.exit(0);
}

const cwd = input.cwd || process.cwd();
const runtime = await readJson(join(cwd, ".agent-loop", "loop-state.json"));
if (runtime?.pending_save_progress) {
  emitBlock(
    "Agent Loop runtime requires session recycle. Do not continue dispatching workers in this session."
  );
  process.exit(0);
}

const message = input.last_assistant_message || "";

if (message.includes("Session context pressure reached") || message.includes("session_recycle_required")) {
  emitBlock(
    "Agent Loop runtime requires session recycle. Do not continue dispatching workers in this session."
  );
  process.exit(0);
}

if (message.includes("Loop halted") || message.includes("all remaining tasks blocked")) {
  emitBlock("Agent Loop is halted. Resolve blocked tasks or stop the loop.");
  process.exit(0);
}

process.exit(0);
