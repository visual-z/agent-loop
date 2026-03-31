#!/usr/bin/env bun

// =============================================================================
// Agent Loop MCP Server (Multi-Instance Isolated)
// =============================================================================
//
// MCP server for Claude Code that orchestrates multi-step coding tasks through
// subagent delegation with full context isolation per loop instance.
//
// ISOLATION MODEL:
//   Each Agent Loop instance has a unique loop_id (= plan name) and its own
//   directory under .agent-loop/loops/{loopId}/ containing boulder.json,
//   loop-state.json, handoffs/, notepads/, and evidence/.
//
//   The server holds an activeLoopId in memory. All tools operate exclusively
//   on the active loop. An active-loop.json pointer persists the active loop
//   to disk for cross-session continuity.
// =============================================================================

import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  readBoulder,
  writeBoulder,
  readRuntimeState,
  writeRuntimeState,
  createRuntimeState,
  createBoulder,
  markTaskStarted,
  markTaskDone,
  markTaskFailed,
  markTaskBlocked,
  pickNextTask,
  isLoopComplete,
  shouldHalt,
  parsePlan,
  readHandoff,
  readLatestHandoff,
  writeHandoff,
  readNotepad,
  appendNotepad,
  loopDir,
  loopInstanceDir,
  plansDir,
  listLoops,
  readActiveLoopPointer,
  writeActiveLoopPointer,
  clearActiveLoopPointer,
  migrateOldLayout,
} from "./core/state.mjs";

import {
  buildWorkerPrompt,
  buildContinuationPrompt,
  buildCompactionContext,
  parseHandoffFromWorkerOutput,
} from "./core/prompts.mjs";

import {
  runBackpressureGate,
  formatGateResult,
  getBackpressureShellCommand,
} from "./core/gate.mjs";

const workdir = resolve(process.env.AGENT_LOOP_WORKDIR || process.cwd());

// ---------------------------------------------------------------------------
// In-memory state — lives for the server's lifetime
// ---------------------------------------------------------------------------

/** The currently active loop ID (= plan name) */
let activeLoopId = null;

// ---------------------------------------------------------------------------
// Startup: Auto-migration + restore active loop pointer
// ---------------------------------------------------------------------------

try {
  const migratedId = await migrateOldLayout(workdir);
  if (migratedId) {
    activeLoopId = migratedId;
  }

  if (!activeLoopId) {
    const pointer = await readActiveLoopPointer(workdir);
    if (pointer) {
      const state = await readBoulder(workdir, pointer.loop_id);
      if (state && (state.status === "running" || state.status === "paused")) {
        activeLoopId = pointer.loop_id;
      }
    }
  }
} catch {
  // Non-fatal — startup continues without active loop
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function isTerminalLoopStatus(status) {
  return status === "completed" || status === "halted" || status === "failed";
}

async function clearActiveLoopIfTerminal(loopId, status) {
  if (!loopId || !isTerminalLoopStatus(status)) return;
  await clearActiveLoopPointer(workdir);
  if (activeLoopId === loopId) {
    activeLoopId = null;
  }
}

async function runShell(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "No command provided",
    };
  }

  return new Promise((resolvePromise) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr: stderr || error.message,
      });
    });

    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function ensureRuntimeState(loopId, sessionId) {
  const existing = await readRuntimeState(workdir, loopId);
  if (existing) return existing;

  const created = createRuntimeState(sessionId || null);
  await writeRuntimeState(workdir, loopId, created);
  return created;
}

function extractFilePaths(text) {
  const patterns = [
    /`([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)`/g,
    /(?:src|lib|app|test|tests|pkg)\/[a-zA-Z0-9_\-./]+\.[a-zA-Z]+/g,
  ];

  const paths = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const path = match[1] || match[0];
      if (path.includes("/") && !path.startsWith("http")) {
        paths.add(path);
      }
    }
  }

  return [...paths];
}

async function buildPayloadForTask(loopId, state, task) {
  const learnings = await readNotepad(workdir, loopId, "learnings");
  const decisions = await readNotepad(workdir, loopId, "decisions");
  const issues = await readNotepad(workdir, loopId, "issues");

  let previousContext = "";
  const doneTasks = Object.values(state.task_sessions)
    .filter((t) => t.status === "done")
    .sort((a, b) => (a.completed_at || "").localeCompare(b.completed_at || ""));

  if (doneTasks.length > 0) {
    const lastDone = doneTasks[doneTasks.length - 1];
    const handoff = await readHandoff(workdir, loopId, lastDone.task_key);
    if (handoff) previousContext = handoff.next_task_context;
  }

  const taskSession = state.task_sessions[task.key];
  if (taskSession?.last_error) {
    previousContext += `\n\nPREVIOUS ATTEMPT FAILED:\n${taskSession.last_error}\nPlease fix the issue described above.`;
  }

  return {
    task,
    notepad_learnings: learnings,
    notepad_decisions: decisions,
    notepad_issues: issues,
    previous_handoff_context: previousContext,
    relevant_file_paths: extractFilePaths(task.description),
    project_conventions: learnings.slice(0, 500),
    backpressure_command: await getBackpressureShellCommand(workdir),
  };
}

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools = [
  {
    name: "agent_loop_init",
    description:
      "Initialize a new Agent Loop from an existing plan path or generate init instructions for a new plan.",
    inputSchema: {
      type: "object",
      properties: {
        plan_path: { type: "string" },
        plan_name: { type: "string" },
        objective: { type: "string" },
        session_id: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      // Run migration first if needed
      await migrateOldLayout(workdir);

      let planPath = "";
      if (args.plan_path) {
        planPath = args.plan_path.startsWith("/") ? args.plan_path : join(workdir, args.plan_path);
        if (!existsSync(planPath)) {
          return { error: `Plan file not found: ${planPath}` };
        }
      } else if (args.plan_name && args.objective) {
        return {
          action: "create_plan",
          plan_name: args.plan_name,
          plan_dir: plansDir(workdir),
          instructions:
            `Create .agent-loop/plans/${args.plan_name}.md with TL;DR, Context, Work Objectives, Verification Strategy, TODOs. Objective: ${args.objective}. Then call agent_loop_init with plan_path.`,
        };
      } else {
        return {
          error: "Provide plan_path or plan_name + objective",
        };
      }

      const plan = await parsePlan(planPath);
      if (plan.tasks.length === 0) {
        return {
          error: "No TODO items found in plan. Ensure TODO section with - [ ] tasks.",
        };
      }

      const loopId = plan.name;

      // Check if a loop with this ID already exists and is running
      const existing = await readBoulder(workdir, loopId);
      if (existing && existing.status === "running") {
        return {
          error: "Loop already active",
          loop_id: loopId,
          plan: existing.plan_name,
          progress: `${existing.stats.done}/${existing.stats.total_tasks}`,
          hint: "Use agent_loop_resume to continue, or agent_loop_halt to stop it first.",
        };
      }

      const orchestratorSessionId = args.session_id || null;
      const nextState = createBoulder(loopId, planPath, plan.name, plan.tasks, orchestratorSessionId);
      await writeBoulder(workdir, loopId, nextState);

      const runtime = createRuntimeState(orchestratorSessionId, nextState.started_at);
      await writeRuntimeState(workdir, loopId, runtime);

      // Activate the loop
      activeLoopId = loopId;
      await writeActiveLoopPointer(workdir, loopId);

      return {
        status: "initialized",
        loop_id: loopId,
        plan_name: plan.name,
        total_tasks: plan.tasks.length,
        tasks: plan.tasks.map((task) => ({ key: task.key, title: task.title })),
        next_action: "Call agent_loop_dispatch for the first task key.",
      };
    },
  },
  {
    name: "agent_loop_resume",
    description:
      "Resume an existing Agent Loop. If multiple resumable loops exist, returns a list for selection. Pass loop_id to pick one.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        loop_id: {
          type: "string",
          description: "The loop ID to resume. Omit to auto-select or list.",
        },
      },
      additionalProperties: false,
    },
    async execute(args) {
      // Run migration first if needed
      await migrateOldLayout(workdir);

      let targetLoopId = args.loop_id;

      if (!targetLoopId) {
        // Discover available loops
        const loops = await listLoops(workdir);
        const resumable = loops.filter(
          (l) => l.status === "running" || l.status === "paused" || l.status === "planning"
        );

        if (resumable.length === 0) {
          if (loops.length === 0) {
            return {
              error: "No Agent Loop instances found. Use agent_loop_init to start a new one.",
            };
          }
          return {
            error: "No resumable loops found. All loops are completed/halted/failed.",
            all_loops: loops.map((l) => ({
              loop_id: l.loop_id,
              status: l.status,
              progress: l.progress,
              updated_at: l.updated_at,
            })),
            hint: "Use agent_loop_init to start a new loop.",
          };
        }

        if (resumable.length === 1) {
          targetLoopId = resumable[0].loop_id;
        } else {
          return {
            action: "select_loop",
            message:
              "Multiple resumable Agent Loops found. Please specify which one to resume by calling agent_loop_resume with loop_id.",
            resumable_loops: resumable.map((l) => ({
              loop_id: l.loop_id,
              plan_name: l.plan_name,
              status: l.status,
              progress: l.progress,
              started_at: l.started_at,
              updated_at: l.updated_at,
            })),
          };
        }
      }

      const state = await readBoulder(workdir, targetLoopId);
      if (!state) {
        return {
          error: `No boulder.json found for loop "${targetLoopId}". Use agent_loop_init to start a new loop.`,
          available_loops: (await listLoops(workdir)).map((l) => l.loop_id),
        };
      }

      if (state.status === "completed") {
        return {
          status: "completed",
          loop_id: targetLoopId,
          plan: state.plan_name,
          message: "This loop is already completed.",
        };
      }

      const runtime = await ensureRuntimeState(targetLoopId, args.session_id || null);

      state.orchestrator_session_id = args.session_id || runtime.session_id || state.orchestrator_session_id;
      state.status = "running";
      await writeBoulder(workdir, targetLoopId, state);

      runtime.active = true;
      runtime.session_id = state.orchestrator_session_id || runtime.session_id;
      runtime.pending_save_progress = false;
      runtime.iteration = 0;
      runtime.stall_count = 0;
      runtime.last_state_hash = null;
      await writeRuntimeState(workdir, targetLoopId, runtime);

      // Activate this loop
      activeLoopId = targetLoopId;
      await writeActiveLoopPointer(workdir, targetLoopId);

      const nextKey = pickNextTask(state);
      const latestHandoff = await readLatestHandoff(workdir, targetLoopId);

      return {
        status: "resumed",
        loop_id: targetLoopId,
        plan: state.plan_name,
        iteration: state.iteration,
        progress: `${state.stats.done}/${state.stats.total_tasks}`,
        current_task: state.current_task,
        next_task: nextKey,
        next_task_title: nextKey ? state.task_sessions[nextKey]?.task_title : null,
        latest_handoff_context: latestHandoff?.next_task_context || null,
        tasks: Object.values(state.task_sessions).map((t) => ({
          key: t.task_key,
          title: t.task_title,
          status: t.status,
          attempts: t.attempts,
        })),
      };
    },
  },
  {
    name: "agent_loop_dispatch",
    description: "Prepare isolated worker prompt for a specific task key.",
    inputSchema: {
      type: "object",
      properties: {
        task_key: { type: "string" },
        worker_session_id: { type: "string" },
      },
      required: ["task_key"],
      additionalProperties: false,
    },
    async execute(args) {
      if (!activeLoopId) {
        return { error: "No active loop. Call agent_loop_init or agent_loop_resume first." };
      }

      const state = await readBoulder(workdir, activeLoopId);
      if (!state) return { error: "No active loop state. Call agent_loop_init first." };

      const runtime = await readRuntimeState(workdir, activeLoopId);
      if (runtime?.pending_save_progress) {
        return {
          error: "Session recycle required before dispatching more workers.",
          pending_save_progress: true,
          next_action: "Open a fresh session and call agent_loop_resume.",
        };
      }

      const taskSession = state.task_sessions[args.task_key];
      if (!taskSession) {
        return {
          error: `Unknown task: ${args.task_key}`,
          available: Object.keys(state.task_sessions),
        };
      }

      if (taskSession.status === "done") {
        return {
          error: `Task ${args.task_key} already done.`,
          next: pickNextTask(state),
        };
      }

      if (taskSession.status === "blocked") {
        return {
          error: `Task ${args.task_key} is blocked after ${taskSession.attempts} attempts.`,
          last_error: taskSession.last_error,
        };
      }

      if (taskSession.status === "in-progress") {
        return {
          error: `Task ${args.task_key} is already in-progress.`,
        };
      }

      const plan = await parsePlan(state.active_plan);
      const task = plan.tasks.find((item) => item.key === args.task_key);
      if (!task) {
        return { error: `Task ${args.task_key} not found in plan file.` };
      }

      const payload = await buildPayloadForTask(activeLoopId, state, task);
      const workerPrompt = buildWorkerPrompt(payload);

      markTaskStarted(state, args.task_key, args.worker_session_id);
      await writeBoulder(workdir, activeLoopId, state);

      return {
        action: "dispatch",
        task_key: args.task_key,
        task_title: taskSession.task_title,
        worker_prompt: workerPrompt,
        instructions:
          "Dispatch this prompt to agent-loop-worker subagent. After worker returns, call agent_loop_process_handoff with full worker output.",
      };
    },
  },
  {
    name: "agent_loop_process_handoff",
    description:
      "Parse worker handoff, persist handoff/notepad updates, run gate, and compute next action.",
    inputSchema: {
      type: "object",
      properties: {
        task_key: { type: "string" },
        worker_output: { type: "string" },
        skip_gate: { type: "boolean" },
      },
      required: ["task_key", "worker_output"],
      additionalProperties: false,
    },
    async execute(args) {
      if (!activeLoopId) {
        return { error: "No active loop." };
      }

      const state = await readBoulder(workdir, activeLoopId);
      if (!state) return { error: "No active loop." };

      const taskSession = state.task_sessions[args.task_key];
      if (!taskSession) return { error: `Unknown task: ${args.task_key}` };

      if (taskSession.status !== "in-progress") {
        return {
          error: `Cannot process handoff for ${args.task_key} because task is ${taskSession.status}. Dispatch it first.`,
          task_key: args.task_key,
          task_status: taskSession.status,
          current_task: state.current_task,
        };
      }

      if (state.current_task && state.current_task !== args.task_key) {
        return {
          error: `Cannot process handoff for ${args.task_key} while ${state.current_task} is current in-progress task.`,
          task_key: args.task_key,
          current_task: state.current_task,
        };
      }

      const parsed = parseHandoffFromWorkerOutput(args.worker_output);
      if (!parsed) {
        markTaskFailed(
          state,
          args.task_key,
          "Worker did not produce HANDOFF_START...HANDOFF_END block."
        );
        await writeBoulder(workdir, activeLoopId, state);

        return {
          status: "failed",
          reason: "No handoff block found in worker output",
          task_key: args.task_key,
          attempts: state.task_sessions[args.task_key].attempts,
          max_attempts: state.task_sessions[args.task_key].max_attempts,
          can_retry:
            state.task_sessions[args.task_key].attempts <
            state.task_sessions[args.task_key].max_attempts,
        };
      }

      const sanitize = (text, maxChars) => (text || "").trim().slice(0, maxChars);
      const compressedSummary = [
        `Task ${args.task_key}: ${taskSession.task_title}`,
        parsed.what_was_done ? `Done: ${sanitize(parsed.what_was_done, 800)}` : "",
        parsed.key_decisions ? `Decisions: ${sanitize(parsed.key_decisions, 600)}` : "",
        parsed.files_changed ? `Files: ${sanitize(parsed.files_changed, 500)}` : "",
        parsed.test_results ? `Tests: ${sanitize(parsed.test_results, 400)}` : "",
        parsed.blocked_issues && parsed.blocked_issues !== "None"
          ? `Issues: ${sanitize(parsed.blocked_issues, 400)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      // Write handoff file (scoped to this loop)
      const handoffFile = {
        meta: {
          task_key: args.task_key,
          task_title: taskSession.task_title,
          status: parsed.status,
          attempts: taskSession.attempts,
          completed_at: new Date().toISOString(),
        },
        ...parsed,
      };
      await writeHandoff(workdir, activeLoopId, handoffFile);

      // Append learnings to notepad (scoped to this loop)
      if (parsed.learnings?.trim()) {
        await appendNotepad(
          workdir,
          activeLoopId,
          "learnings",
          `From ${args.task_key} (${taskSession.task_title}):\n${parsed.learnings}`
        );
      }
      if (parsed.key_decisions?.trim()) {
        await appendNotepad(workdir, activeLoopId, "decisions", `From ${args.task_key}:\n${parsed.key_decisions}`);
      }
      if (parsed.blocked_issues?.trim() && parsed.blocked_issues !== "None") {
        await appendNotepad(workdir, activeLoopId, "issues", `From ${args.task_key}:\n${parsed.blocked_issues}`);
      }

      if (parsed.status === "blocked") {
        markTaskBlocked(
          state,
          args.task_key,
          parsed.blocked_issues || "Worker reported blocked status"
        );
        await writeBoulder(workdir, activeLoopId, state);

        const nextKey = pickNextTask(state);
        return {
          status: "blocked",
          task_key: args.task_key,
          reason: parsed.blocked_issues,
          summary: compressedSummary,
          next_task: nextKey,
        };
      }

      if (parsed.status === "failed") {
        markTaskFailed(
          state,
          args.task_key,
          parsed.blocked_issues || "Worker reported failure"
        );
        await writeBoulder(workdir, activeLoopId, state);

        const nextKey = pickNextTask(state);
        return {
          status: "failed",
          task_key: args.task_key,
          reason: parsed.blocked_issues,
          summary: compressedSummary,
          can_retry:
            state.task_sessions[args.task_key].attempts <
            state.task_sessions[args.task_key].max_attempts,
          next_task: nextKey,
        };
      }

      let gateResult = {
        passed: true,
        build: null,
        test: null,
        lint: null,
        timestamp: new Date().toISOString(),
      };

      if (!args.skip_gate) {
        try {
          gateResult = await runBackpressureGate(runShell, workdir);
        } catch (error) {
          gateResult = {
            passed: false,
            build: null,
            test: { passed: false, output: error?.message || String(error) },
            lint: null,
            timestamp: new Date().toISOString(),
          };
        }
      }

      if (gateResult.passed) {
        markTaskDone(state, args.task_key);
        state.stats.backpressure_failures = Math.max(0, state.stats.backpressure_failures || 0);
      } else {
        state.stats.backpressure_failures = (state.stats.backpressure_failures || 0) + 1;
        markTaskFailed(
          state,
          args.task_key,
          `Backpressure gate failed:\n${formatGateResult(gateResult)}`
        );
      }

      const nextKey = pickNextTask(state);
      const allDone = isLoopComplete(state);
      const halted = shouldHalt(state);
      const doneTasksList = Object.values(state.task_sessions).filter((task) => task.status === "done");

      let runtime = null;

      if (allDone) {
        state.status = "completed";
      } else if (halted) {
        state.status = "halted";
      }

      await writeBoulder(workdir, activeLoopId, state);

      if (isTerminalLoopStatus(state.status)) {
        runtime = await readRuntimeState(workdir, activeLoopId);
        if (runtime) {
          runtime.active = false;
          runtime.pending_save_progress = false;
          await writeRuntimeState(workdir, activeLoopId, runtime);
        }
        await clearActiveLoopIfTerminal(activeLoopId, state.status);
      }

      return {
        status: gateResult.passed ? "done" : "gate_failed",
        task_key: args.task_key,
        summary: compressedSummary,
        gate: {
          passed: gateResult.passed,
          build: gateResult.build ? { passed: gateResult.build.passed } : null,
          test: gateResult.test ? { passed: gateResult.test.passed } : null,
          lint: gateResult.lint ? { passed: gateResult.lint.passed } : null,
        },
        gate_details: gateResult.passed ? undefined : formatGateResult(gateResult),
        progress: `${doneTasksList.length}/${state.stats.total_tasks}`,
        all_done: allDone,
        halted,
        next_task: nextKey,
        next_task_title: nextKey ? state.task_sessions[nextKey]?.task_title : null,
      };
    },
  },
  {
    name: "agent_loop_status",
    description: "Return loop status, runtime controls, task states, and latest handoff summary.",
    inputSchema: {
      type: "object",
      properties: {
        loop_id: {
          type: "string",
          description: "Specific loop ID to check. Omit to see the active loop and list all loops.",
        },
      },
      additionalProperties: false,
    },
    async execute(args) {
      // Run migration first if needed
      await migrateOldLayout(workdir);

      const targetLoopId = args.loop_id || activeLoopId;

      // If no specific loop requested and no active loop, list all
      if (!targetLoopId) {
        const loops = await listLoops(workdir);
        return {
          active: false,
          active_loop_id: null,
          message: loops.length === 0
            ? "No Agent Loop instances found. Use agent_loop_init to start one."
            : "No active loop in this session. Use agent_loop_resume to continue one.",
          all_loops: loops.map((l) => ({
            loop_id: l.loop_id,
            plan_name: l.plan_name,
            status: l.status,
            progress: l.progress,
            started_at: l.started_at,
            updated_at: l.updated_at,
          })),
        };
      }

      const state = await readBoulder(workdir, targetLoopId);
      const runtime = await readRuntimeState(workdir, targetLoopId);
      if (!state) {
        return {
          active: false,
          loop_id: targetLoopId,
          message: `Loop "${targetLoopId}" not found.`,
          available_loops: (await listLoops(workdir)).map((l) => l.loop_id),
        };
      }

      const latestHandoff = await readLatestHandoff(workdir, targetLoopId);
      const allLoops = await listLoops(workdir);

      const status = {
        active: state.status === "running",
        loop_id: targetLoopId,
        is_current: targetLoopId === activeLoopId,
        plan: state.plan_name,
        status: state.status,
        iteration: state.iteration,
        max_iterations: state.max_iterations,
        runtime: runtime
          ? {
              active: runtime.active,
              session_id: runtime.session_id,
              iteration: runtime.iteration,
              max_iterations_per_session: runtime.max_iterations_per_session,
              total_iterations: runtime.total_iterations,
              max_total_iterations: runtime.max_total_iterations,
              stall_count: runtime.stall_count,
              stall_threshold: runtime.stall_threshold,
              pending_save_progress: runtime.pending_save_progress,
              context_pressure_threshold: runtime.context_pressure_threshold,
            }
          : null,
        progress: `${state.stats.done}/${state.stats.total_tasks}`,
        stats: state.stats,
        current_task: state.current_task,
        tasks: Object.values(state.task_sessions).map((task) => ({
          key: task.task_key,
          title: task.task_title,
          status: task.status,
          attempts: task.attempts,
          error: task.last_error ? task.last_error.slice(0, 100) : undefined,
        })),
        latest_handoff: latestHandoff
          ? {
              task: latestHandoff.meta.task_key,
              status: latestHandoff.meta.status,
              summary: latestHandoff.what_was_done.slice(0, 200),
            }
          : null,
        all_loops: allLoops.length > 1
          ? allLoops.map((l) => ({
              loop_id: l.loop_id,
              status: l.status,
              progress: l.progress,
            }))
          : undefined,
      };

      if (state.status === "running" && runtime?.active) {
        const nextKey = pickNextTask(state);
        const nextSession = nextKey ? state.task_sessions[nextKey] : null;
        const doneTasksList = Object.values(state.task_sessions).filter((t) => t.status === "done");

        const continuation = buildContinuationPrompt({
          completed_task_key:
            latestHandoff?.meta.task_key || state.current_task || "unknown",
          completed_task_title:
            latestHandoff?.meta.task_title ||
            state.task_sessions[latestHandoff?.meta.task_key || state.current_task || ""]?.task_title ||
            "unknown",
          handoff_summary: latestHandoff?.what_was_done || "",
          gate_result: {
            passed: true,
            build: null,
            test: null,
            lint: null,
            timestamp: new Date().toISOString(),
          },
          next_task_key: nextKey,
          next_task_title: nextSession?.task_title || null,
          iteration: state.iteration,
          progress: `${doneTasksList.length}/${state.stats.total_tasks} tasks complete`,
        });

        status.orchestrator_next_prompt = continuation;
      }

      return status;
    },
  },
  {
    name: "agent_loop_halt",
    description: "Pause loop execution and reset current in-progress task to pending.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      if (!activeLoopId) {
        return { error: "No active loop." };
      }

      const state = await readBoulder(workdir, activeLoopId);
      if (!state) return { error: "No active loop." };

      const runtime = await readRuntimeState(workdir, activeLoopId);
      state.status = "paused";

      if (state.current_task) {
        const current = state.task_sessions[state.current_task];
        if (current?.status === "in-progress") current.status = "pending";
        state.current_task = null;
      }

      await writeBoulder(workdir, activeLoopId, state);
      if (runtime) {
        runtime.active = false;
        runtime.pending_save_progress = false;
        await writeRuntimeState(workdir, activeLoopId, runtime);
      }

      // Clear active loop pointer
      await clearActiveLoopPointer(workdir);

      return {
        status: "paused",
        loop_id: activeLoopId,
        reason: args.reason || "Manual halt",
        progress: `${state.stats.done}/${state.stats.total_tasks}`,
        message: "Loop paused. Use agent_loop_resume to continue later.",
      };
    },
  },
  {
    name: "agent_loop_backpressure_gate",
    description: "Run backpressure gate manually and return formatted results.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await runBackpressureGate(runShell, workdir);
      return {
        gate: result,
        formatted: formatGateResult(result),
      };
    },
  },
  {
    name: "agent_loop_update_notepad",
    description: "Append a manual entry to learnings, decisions, or issues notepads.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["learnings", "decisions", "issues"] },
        content: { type: "string" },
      },
      required: ["type", "content"],
      additionalProperties: false,
    },
    async execute(args) {
      if (!activeLoopId) {
        return { error: "No active loop - notepad requires loop context." };
      }

      await appendNotepad(workdir, activeLoopId, args.type, args.content);
      return {
        status: "appended",
        notepad: args.type,
        loop_id: activeLoopId,
      };
    },
  },
  {
    name: "agent_loop_completion_report",
    description: "Generate completion report markdown and write it under the loop instance directory.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      if (!activeLoopId) {
        return { error: "No active loop." };
      }

      const state = await readBoulder(workdir, activeLoopId);
      if (!state) return { error: "No loop state found." };

      const learnings = await readNotepad(workdir, activeLoopId, "learnings");
      const decisions = await readNotepad(workdir, activeLoopId, "decisions");
      const issues = await readNotepad(workdir, activeLoopId, "issues");

      const tasks = Object.values(state.task_sessions);
      const done = tasks.filter((task) => task.status === "done");
      const blocked = tasks.filter((task) => task.status === "blocked");
      const totalAttempts = tasks.reduce((sum, task) => sum + task.attempts, 0);

      const report = [
        "# Agent Loop Completion Report",
        "",
        `**Loop ID**: ${activeLoopId}`,
        `**Plan**: ${state.plan_name}`,
        `**Started**: ${state.started_at}`,
        `**Completed**: ${state.updated_at}`,
        `**Iterations**: ${state.iteration}`,
        `**Total Attempts**: ${totalAttempts}`,
        "",
        `## Results: ${done.length}/${tasks.length} tasks completed`,
        "",
        ...done.map(
          (task) =>
            `- [done] ${task.task_key}: ${task.task_title} (${task.attempts} attempt${task.attempts > 1 ? "s" : ""})`
        ),
        ...blocked.map(
          (task) =>
            `- [blocked] ${task.task_key}: ${task.task_title} - ${task.last_error?.slice(0, 120) || "unknown"}`
        ),
        "",
        learnings ? `## Key Learnings\n${learnings}\n` : "",
        decisions ? `## Architectural Decisions\n${decisions}\n` : "",
        issues ? `## Known Issues\n${issues}\n` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const reportPath = join(loopInstanceDir(workdir, activeLoopId), `report-${state.plan_name}.md`);
      await writeFile(reportPath, report, "utf-8");

      return {
        report_path: reportPath,
        report,
      };
    },
  },
  {
    name: "agent_loop_runtime_tick",
    description:
      "Advance runtime guard state for this turn and return recycle/stall/limit signals plus optional context summary.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        trigger: {
          type: "string",
          enum: [
            "session_start",
            "resume",
            "post_handoff",
            "orchestrator_turn",
            "post_compact",
            "error",
          ],
        },
        increment_iteration: { type: "boolean" },
        fail_current_task: { type: "boolean" },
        error_message: { type: "string" },
      },
      required: ["trigger"],
      additionalProperties: false,
    },
    async execute(args) {
      if (!activeLoopId) {
        return {
          active: false,
          reason: "no_active_loop",
          hint: "Call agent_loop_init or agent_loop_resume first.",
        };
      }

      const state = await readBoulder(workdir, activeLoopId);
      const runtime = await ensureRuntimeState(activeLoopId, args.session_id || null);

      if (!state) {
        await clearActiveLoopPointer(workdir);
        activeLoopId = null;
        return {
          active: false,
          reason: "no_state",
          runtime,
        };
      }

      if (args.session_id && runtime.session_id && runtime.session_id !== args.session_id) {
        return {
          active: false,
          reason: "session_mismatch",
          expected_session_id: runtime.session_id,
          received_session_id: args.session_id,
          runtime,
        };
      }

      if (!runtime.session_id && args.session_id) {
        runtime.session_id = args.session_id;
      }

      if (args.trigger === "session_start" || args.trigger === "resume") {
        runtime.active = true;
        runtime.pending_save_progress = false;
        runtime.iteration = 0;
        runtime.stall_count = 0;
        runtime.last_state_hash = null;
      }

      if (args.increment_iteration) {
        runtime.iteration += 1;
        runtime.total_iterations += 1;
        runtime.last_continued_at = new Date().toISOString();
      }

      if (args.fail_current_task && state.current_task) {
        markTaskFailed(
          state,
          state.current_task,
          args.error_message || "Runtime tick requested failure for current task."
        );
        await writeBoulder(workdir, activeLoopId, state);
      }

      if (state.status !== "running") {
        runtime.active = false;
        runtime.pending_save_progress = false;
        await writeRuntimeState(workdir, activeLoopId, runtime);

        await clearActiveLoopIfTerminal(activeLoopId, state.status);
        return {
          active: false,
          reason: "loop_not_running",
          state_status: state.status,
          runtime,
        };
      }

      const hashPayload = {
        status: state.status,
        iteration: state.iteration,
        current_task: state.current_task,
        task_sessions: Object.values(state.task_sessions)
          .map((task) => ({
            key: task.task_key,
            status: task.status,
            attempts: task.attempts,
            completed_at: task.completed_at || null,
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      };
      const stateHash = JSON.stringify(hashPayload);

      if (runtime.last_state_hash === stateHash) {
        runtime.stall_count += 1;
      } else {
        runtime.last_state_hash = stateHash;
        runtime.stall_count = 0;
      }

      if (runtime.stall_count >= runtime.stall_threshold) {
        runtime.active = false;
        await writeRuntimeState(workdir, activeLoopId, runtime);
        return {
          active: false,
          reason: "stalled",
          stall_count: runtime.stall_count,
          stall_threshold: runtime.stall_threshold,
          runtime,
        };
      }

      if (runtime.total_iterations >= runtime.max_total_iterations) {
        state.status = "halted";
        await writeBoulder(workdir, activeLoopId, state);

        runtime.active = false;
        runtime.pending_save_progress = false;
        await writeRuntimeState(workdir, activeLoopId, runtime);
        await clearActiveLoopIfTerminal(activeLoopId, state.status);

        return {
          active: false,
          reason: "max_total_iterations",
          runtime,
        };
      }

      const sessionPressure =
        runtime.max_iterations_per_session > 0
          ? runtime.iteration / runtime.max_iterations_per_session
          : 0;

      if (!runtime.pending_save_progress && sessionPressure >= runtime.context_pressure_threshold) {
        runtime.pending_save_progress = true;
        runtime.active = false;
        runtime.last_continued_at = new Date().toISOString();
        await writeRuntimeState(workdir, activeLoopId, runtime);

        return {
          active: false,
          reason: "session_recycle_required",
          pressure: sessionPressure,
          runtime,
          message:
            "Session context pressure threshold reached. Save progress and continue in a fresh session via agent_loop_resume.",
        };
      }

      if (runtime.pending_save_progress) {
        await writeRuntimeState(workdir, activeLoopId, runtime);
        return {
          active: false,
          reason: "pending_save_progress",
          runtime,
        };
      }

      if (!runtime.active) runtime.active = true;
      await writeRuntimeState(workdir, activeLoopId, runtime);

      return {
        active: true,
        reason: "continue",
        runtime,
        next_task: pickNextTask(state),
      };
    },
  },
  {
    name: "agent_loop_compaction_context",
    description: "Return compact loop state summary suitable for PostCompact/System context reinjection.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      if (!activeLoopId) {
        return {
          available: false,
          reason: "no_active_loop",
        };
      }

      const state = await readBoulder(workdir, activeLoopId);
      if (!state || state.status !== "running") {
        return {
          available: false,
          reason: "loop_not_running",
        };
      }

      return {
        available: true,
        context: buildCompactionContext(state),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "agent-loop",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Agent Loop MCP server (multi-instance). Use agent_loop_* tools to initialize, dispatch, process handoffs, enforce runtime controls, and produce completion reports. Each loop instance is isolated under .agent-loop/loops/{loop_id}/.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = tools.find((tool) => tool.name === request.params.name);
  if (!handler) {
    return jsonResult({ error: `Unknown tool: ${request.params.name}` });
  }

  try {
    const args = parseToolArgs(request.params.arguments);
    const payload = await handler.execute(args);
    return jsonResult(payload);
  } catch (error) {
    return jsonResult({
      error: error?.message || String(error),
      tool: request.params.name,
    });
  }
});

await mkdir(loopDir(workdir), { recursive: true });
const transport = new StdioServerTransport();
await server.connect(transport);
