// =============================================================================
// Agent Loop Plugin — Main Entry Point (Multi-Instance Isolated)
// =============================================================================
//
// OpenCode plugin that orchestrates multi-step coding tasks through subagent
// delegation with full context isolation.
//
// ISOLATION MODEL:
//   Each Agent Loop instance has a unique loop_id (= plan name) and its own
//   directory under .agent-loop/loops/{loopId}/ containing boulder.json,
//   loop-state.json, handoffs/, notepads/, and evidence/.
//
//   The plugin holds an activeLoopId in memory. All tools operate exclusively
//   on the active loop. An active-loop.json pointer persists the active loop
//   to disk for cross-session continuity.
//
// Architecture:
//   User -> /agent-loop -> Orchestrator Agent -> [Worker Subagent per task]
//   Plugin events drive auto-continuation between tasks.
//
// File: .opencode/plugins/agent-loop/plugin.ts
// =============================================================================

import { writeFile } from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { createHash } from "crypto";
import { tool } from "@opencode-ai/plugin";

import type {
  BoulderState,
  ContinuationContext,
  HandoffFile,
  LoopRuntimeState,
  PlanTask,
  WorkerPayload,
} from "./types";

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
} from "./state";

import {
  buildWorkerPrompt,
  buildContinuationPrompt,
  buildCompactionContext,
  parseHandoffFromWorkerOutput,
} from "./prompts";

import {
  runBackpressureGate,
  formatGateResult,
  getBackpressureShellCommand,
} from "./gate";

// =============================================================================
// Plugin Export
// =============================================================================

export const AgentLoopPlugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}: {
  project: any;
  client: any;
  $: any;
  directory: string;
  worktree: string;
}) => {
  // ---------------------------------------------------------------------------
  // Internal State — lives for the plugin's lifetime (one OpenCode session)
  // ---------------------------------------------------------------------------

  /** The orchestrator session ID, set when the loop starts */
  let orchestratorSessionId: string | null = null;

  /** The currently active loop ID (= plan name) */
  let activeLoopId: string | null = null;

  /** Whether we're actively in a loop iteration */
  let loopActive = false;

  /** Debounce: prevent double-firing from rapid idle events */
  let lastIdleTimestamp = 0;
  const IDLE_DEBOUNCE_MS = 2000;

  /**
   * Working directory for runtime files.
   *
   * In non-git folders OpenCode can report worktree as "/", which is not
   * writable for plugin state. Fall back to the session directory in that case.
   */
  const workdir = worktree && worktree !== "/" ? worktree : directory;

  const ORCHESTRATOR_MUTATION_TOOLS = new Set([
    "bash",
    "edit",
    "write",
    "patch",
    "apply_patch",
    "multiedit",
  ]);

  const WORKER_AGENT_NAMES = new Set(["agent-loop-worker"]);

  const isTerminalLoopStatus = (status: BoulderState["status"]) =>
    status === "completed" || status === "halted" || status === "failed";

  async function clearActiveLoopIfTerminal(
    loopId: string | null,
    status: BoulderState["status"]
  ): Promise<void> {
    if (!loopId || !isTerminalLoopStatus(status)) return;
    await clearActiveLoopPointer(workdir);
    if (activeLoopId === loopId) {
      activeLoopId = null;
      loopActive = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Startup: Auto-migration + restore active loop pointer
  // ---------------------------------------------------------------------------

  // Run migration check and restore active loop on startup
  (async () => {
    try {
      // Migrate old single-instance layout if present
      const migratedId = await migrateOldLayout(workdir);
      if (migratedId) {
        activeLoopId = migratedId;
      }

      // Restore from active-loop.json pointer
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
  })();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function ensureRuntimeState(
    loopId: string,
    sessionId: string | null
  ): Promise<LoopRuntimeState> {
    const existing = await readRuntimeState(workdir, loopId);
    if (existing) return existing;
    const created = createRuntimeState(sessionId);
    await writeRuntimeState(workdir, loopId, created);
    return created;
  }

  function getSessionIdFromEvent(payload: any): string | null {
    return (
      payload?.sessionID ||
      payload?.sessionId ||
      payload?.session?.id ||
      payload?.event?.sessionID ||
      payload?.event?.sessionId ||
      payload?.event?.id ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // Shell Runner Adapter
  // ---------------------------------------------------------------------------

  async function runShell(
    cmd: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (cmd.length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "No command provided",
      };
    }

    return new Promise((resolve) => {
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

      child.on("error", (error: Error) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr || error.message,
        });
      });

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: Load full task context for dispatch
  // ---------------------------------------------------------------------------

  async function buildPayloadForTask(
    loopId: string,
    state: BoulderState,
    task: PlanTask
  ): Promise<WorkerPayload> {
    // Read notepad entries (now scoped to loopId, not planName)
    const learnings = await readNotepad(workdir, loopId, "learnings");
    const decisions = await readNotepad(workdir, loopId, "decisions");
    const issues = await readNotepad(workdir, loopId, "issues");

    // Read previous handoff's "Next Task Context"
    let previousContext = "";
    const doneTasks = Object.values(state.task_sessions)
      .filter((t) => t.status === "done")
      .sort((a, b) => (a.completed_at || "").localeCompare(b.completed_at || ""));

    if (doneTasks.length > 0) {
      const lastDone = doneTasks[doneTasks.length - 1];
      const handoff = await readHandoff(workdir, loopId, lastDone.task_key);
      if (handoff) {
        previousContext = handoff.next_task_context;
      }
    }

    // If this is a retry, include the error from last attempt
    const taskSession = state.task_sessions[task.key];
    if (taskSession?.last_error) {
      previousContext += `\n\n⚠️ PREVIOUS ATTEMPT FAILED:\n${taskSession.last_error}\nPlease fix the issue described above.`;
    }

    // Extract relevant file paths from task description
    const filePaths = extractFilePaths(task.description);

    // Project conventions from learnings (first 500 chars)
    const conventions = learnings.slice(0, 500);

    return {
      task,
      notepad_learnings: learnings,
      notepad_decisions: decisions,
      notepad_issues: issues,
      previous_handoff_context: previousContext,
      relevant_file_paths: filePaths,
      project_conventions: conventions,
      backpressure_command: getBackpressureShellCommand(workdir),
    };
  }

  // ---------------------------------------------------------------------------
  // Event Hooks
  // ---------------------------------------------------------------------------

  return {
    // =========================================================================
    // event — Unified handler for session.created, session.idle, session.error
    // =========================================================================
    event: async ({ event }: { event: any }) => {
      const eventType = event?.type || event?.event || "";

      // ----- session.created — Reset per-session runtime counters -----
      if (eventType === "session.created") {
        if (!activeLoopId) return;

        const state = await readBoulder(workdir, activeLoopId);
        if (!state || state.status !== "running") return;

        const incomingSessionId =
          event?.sessionID || event?.sessionId || event?.id || null;

        const runtime = await ensureRuntimeState(activeLoopId, incomingSessionId);
        runtime.active = true;
        runtime.pending_save_progress = false;
        runtime.iteration = 0;
        runtime.stall_count = 0;
        runtime.last_state_hash = null;
        runtime.session_id = incomingSessionId || runtime.session_id;
        await writeRuntimeState(workdir, activeLoopId, runtime);

        if (incomingSessionId) {
          orchestratorSessionId = incomingSessionId;
        }
        loopActive = true;
        return;
      }

      // ----- session.idle — Auto-continuation driver -----
      if (eventType === "session.idle") {
        // Debounce rapid idle events
        const now = Date.now();
        if (now - lastIdleTimestamp < IDLE_DEBOUNCE_MS) return;
        lastIdleTimestamp = now;

        if (!activeLoopId) return;

        const state = await readBoulder(workdir, activeLoopId);
        if (!state || state.status !== "running") {
          loopActive = false;
          const runtime = await readRuntimeState(workdir, activeLoopId);
          if (runtime?.active) {
            runtime.active = false;
            runtime.pending_save_progress = false;
            await writeRuntimeState(workdir, activeLoopId, runtime);
          }

          if (!state) {
            await clearActiveLoopPointer(workdir);
            activeLoopId = null;
          } else {
            await clearActiveLoopIfTerminal(activeLoopId, state.status);
          }
          return;
        }

        const incomingSessionId =
          event?.sessionID || event?.sessionId || event?.id || null;
        const runtime = await ensureRuntimeState(
          activeLoopId,
          orchestratorSessionId || incomingSessionId
        );

        if (runtime.session_id && incomingSessionId && runtime.session_id !== incomingSessionId) {
          return;
        }
        if (!runtime.session_id && incomingSessionId) {
          runtime.session_id = incomingSessionId;
          await writeRuntimeState(workdir, activeLoopId, runtime);
        }

        if (!loopActive && runtime.active) {
          loopActive = true;
        }

        if (!loopActive) {
          return;
        }

        // Check if there's a current task still in-progress (worker still running).
        if (state.current_task) {
          const task = state.task_sessions[state.current_task];
          if (task?.status === "in-progress") {
            const handoff = await readHandoff(workdir, activeLoopId, state.current_task);
            if (!handoff) {
              return;
            }
          }
        }

        const stateHash = computeBoulderHash(state);
        if (runtime.last_state_hash === stateHash) {
          runtime.stall_count += 1;
        } else {
          runtime.last_state_hash = stateHash;
          runtime.stall_count = 0;
        }

        if (runtime.stall_count >= runtime.stall_threshold) {
          runtime.active = false;
          loopActive = false;
          await writeRuntimeState(workdir, activeLoopId, runtime);
          return;
        }

        if (runtime.total_iterations >= runtime.max_total_iterations) {
          state.status = "halted";
          loopActive = false;
          runtime.active = false;
          runtime.pending_save_progress = false;
          await writeBoulder(workdir, activeLoopId, state);
          await writeRuntimeState(workdir, activeLoopId, runtime);
          await clearActiveLoopIfTerminal(activeLoopId, state.status);
          return;
        }

        const sessionPressure =
          runtime.max_iterations_per_session > 0
            ? runtime.iteration / runtime.max_iterations_per_session
            : 0;

        if (
          !runtime.pending_save_progress &&
          sessionPressure >= runtime.context_pressure_threshold
        ) {
          runtime.pending_save_progress = true;
          runtime.active = false;
          runtime.last_continued_at = new Date().toISOString();
          await writeRuntimeState(workdir, activeLoopId, runtime);

          if (orchestratorSessionId || runtime.session_id) {
            const targetSessionId = orchestratorSessionId || runtime.session_id;
            try {
              await client.session.prompt({
                path: { id: targetSessionId },
                body: {
                  parts: [
                    {
                      type: "text",
                      text:
                        "## Agent Loop — Session Recycle Required\n\n" +
                        `Session context pressure reached ${Math.round(sessionPressure * 100)}%.\n` +
                        `Please save progress now and continue in a fresh session using agent_loop_resume.\n` +
                        "Do not dispatch a new worker in this session.",
                    },
                  ],
                },
              });
            } catch {
              // best effort
            }
          }
          loopActive = false;
          return;
        }

        if (runtime.pending_save_progress) {
          return;
        }

        // Auto-continue: inject continuation prompt into orchestrator
        if (orchestratorSessionId || runtime.session_id) {
          const nextKey = pickNextTask(state);
          const nextSession = nextKey ? state.task_sessions[nextKey] : null;
          const latestHandoff = await readLatestHandoff(workdir, activeLoopId);

          const completedTaskKey =
            latestHandoff?.meta.task_key || state.current_task || "unknown";
          const completedTaskTitle =
            latestHandoff?.meta.task_title ||
            state.task_sessions[completedTaskKey]?.task_title ||
            "unknown";

          const doneTasks = Object.values(state.task_sessions).filter(
            (t) => t.status === "done"
          );

          const ctx: ContinuationContext = {
            completed_task_key: completedTaskKey,
            completed_task_title: completedTaskTitle,
            handoff_summary: "",
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
            progress: `${doneTasks.length}/${state.stats.total_tasks} tasks complete`,
          };

          if (latestHandoff) {
            ctx.handoff_summary = latestHandoff.what_was_done;
          }

          if (!nextKey) {
            if (isLoopComplete(state)) {
              state.status = "completed";
            } else {
              state.status = "halted";
            }
            loopActive = false;
            runtime.active = false;
            runtime.pending_save_progress = false;
            await writeBoulder(workdir, activeLoopId, state);
            await writeRuntimeState(workdir, activeLoopId, runtime);
            await clearActiveLoopIfTerminal(activeLoopId, state.status);
          }

          const prompt = buildContinuationPrompt(ctx);
          const targetSessionId = orchestratorSessionId || runtime.session_id;
          if (!targetSessionId) {
            loopActive = false;
            runtime.active = false;
            await writeRuntimeState(workdir, activeLoopId, runtime);
            return;
          }

          try {
            await client.session.prompt({
              path: { id: targetSessionId },
              body: {
                parts: [{ type: "text", text: prompt }],
              },
            });

            orchestratorSessionId = targetSessionId;

            if (nextKey) {
              runtime.iteration += 1;
              runtime.total_iterations += 1;
              runtime.last_continued_at = new Date().toISOString();
              runtime.active = true;
              await writeRuntimeState(workdir, activeLoopId, runtime);
            }
          } catch (e: any) {
            console.error("[agent-loop] Failed to inject continuation:", e.message);
            loopActive = false;
            runtime.active = false;
            await writeRuntimeState(workdir, activeLoopId, runtime);
          }
        }
        return;
      }

      // ----- session.error — Handle session errors gracefully -----
      if (eventType === "session.error") {
        if (!loopActive || !activeLoopId) return;

        const state = await readBoulder(workdir, activeLoopId);
        if (!state) return;
        const runtime = await readRuntimeState(workdir, activeLoopId);

        if (state.current_task) {
          markTaskFailed(
            state,
            state.current_task,
            `Session error: ${event?.error || "unknown error"}`
          );
          await writeBoulder(workdir, activeLoopId, state);
        }

        if (shouldHalt(state)) {
          state.status = "halted";
          loopActive = false;
          await writeBoulder(workdir, activeLoopId, state);
          await clearActiveLoopIfTerminal(activeLoopId, state.status);
          if (runtime) {
            runtime.active = false;
            runtime.pending_save_progress = false;
            await writeRuntimeState(workdir, activeLoopId, runtime);
          }
        }
        return;
      }
    },

    // =========================================================================
    // session.compacted — Preserve loop state across compaction
    // =========================================================================
    "experimental.session.compacting": async (input: any, output: any) => {
      if (!activeLoopId) return;

      const state = await readBoulder(workdir, activeLoopId);
      if (!state || state.status !== "running") return;

      const compactionCtx = buildCompactionContext(state);
      output.context.push(compactionCtx);
    },

    // =========================================================================
    // tool.execute.before — Hard guardrails for orchestrator behavior
    // =========================================================================
    "tool.execute.before": async (input: any, output: any) => {
      if (!activeLoopId) return;

      const toolName = input?.tool || input?.name;
      if (!toolName) return;

      const sessionId =
        getSessionIdFromEvent(input) ||
        getSessionIdFromEvent(output) ||
        null;
      if (!sessionId) return;

      const state = await readBoulder(workdir, activeLoopId);
      if (!state) return;

      if (
        state.status === "completed" ||
        state.status === "halted" ||
        state.status === "failed"
      ) {
        return;
      }

      const boundSessionId = orchestratorSessionId || state.orchestrator_session_id;
      if (!boundSessionId || sessionId !== boundSessionId) {
        return;
      }

      if (ORCHESTRATOR_MUTATION_TOOLS.has(toolName)) {
        throw new Error(
          `Agent Loop policy violation: orchestrator cannot call ${toolName}. ` +
            `Delegate implementation through Task -> agent-loop-worker.`
        );
      }

      if (toolName === "task") {
        const args = output?.args || input?.args || {};
        const targetAgent =
          args.subagent_type || args.agent || args.subagent || args.name || null;

        if (!targetAgent) {
          throw new Error(
            "Agent Loop policy violation: Task calls from orchestrator must target agent-loop-worker explicitly."
          );
        }

        if (!WORKER_AGENT_NAMES.has(targetAgent)) {
          throw new Error(
            `Agent Loop policy violation: orchestrator may only dispatch agent-loop-worker, received: ${targetAgent}`
          );
        }
      }
    },

    // =========================================================================
    // Custom Tools — Exposed to the orchestrator agent
    // =========================================================================
    tool: {
      // -------------------------------------------------------------------
      // agent_loop_init — Initialize a new Agent Loop from a plan
      // -------------------------------------------------------------------
      agent_loop_init: tool({
        description: `Initialize a new Agent Loop. Provide either:
- An existing plan file path under .agent-loop/plans/
- A plan name + task descriptions to create a new plan
Reads the plan, parses TODOs, creates boulder.json, and activates the loop.`,
        args: {
          plan_path: tool.schema
            .string()
            .describe("Path to an existing plan .md file (relative to project root)")
            .optional(),
          plan_name: tool.schema
            .string()
            .describe("Name for a new plan (used if plan_path is not provided)")
            .optional(),
          objective: tool.schema
            .string()
            .describe("High-level objective for generating a new plan (used with plan_name)")
            .optional(),
        },
        async execute(args, context) {
          // Run migration first if needed
          await migrateOldLayout(workdir);

          let planPath: string;

          if (args.plan_path) {
            planPath = args.plan_path.startsWith("/")
              ? args.plan_path
              : join(workdir, args.plan_path);

            if (!existsSync(planPath)) {
              return JSON.stringify({
                error: `Plan file not found: ${planPath}`,
              });
            }
          } else if (args.plan_name && args.objective) {
            return JSON.stringify({
              action: "create_plan",
              plan_name: args.plan_name,
              plan_dir: plansDir(workdir),
              instructions: `Create a plan file at .agent-loop/plans/${args.plan_name}.md with the standard format (TL;DR, Context, Work Objectives, TODOs). The objective is: ${args.objective}. After creating the plan, call agent_loop_init again with the plan_path.`,
            });
          } else {
            return JSON.stringify({
              error:
                "Provide either plan_path (existing plan) or plan_name + objective (new plan)",
            });
          }

          // Parse the plan
          const plan = await parsePlan(planPath);
          if (plan.tasks.length === 0) {
            return JSON.stringify({
              error: "No TODO items found in plan. Ensure the plan has a ## TODOs section with '- [ ] N. Title' items.",
            });
          }

          const loopId = plan.name;

          // Check if a loop with this ID already exists and is running
          const existing = await readBoulder(workdir, loopId);
          if (existing && existing.status === "running") {
            return JSON.stringify({
              error: "Loop already active",
              loop_id: loopId,
              plan: existing.plan_name,
              progress: `${existing.stats.done}/${existing.stats.total_tasks}`,
              hint: "Use agent_loop_resume to continue, or agent_loop_halt to stop it first.",
            });
          }

          // Set the orchestrator session ID from the calling context
          orchestratorSessionId = context.sessionID || null;

          // Create boulder state with loop_id
          const state = createBoulder(
            loopId,
            planPath,
            plan.name,
            plan.tasks,
            orchestratorSessionId
          );
          await writeBoulder(workdir, loopId, state);

          // Activate the loop
          activeLoopId = loopId;
          loopActive = true;
          const runtime = createRuntimeState(orchestratorSessionId, state.started_at);
          await writeRuntimeState(workdir, loopId, runtime);

          // Write the active loop pointer
          await writeActiveLoopPointer(workdir, loopId);

          return JSON.stringify({
            status: "initialized",
            loop_id: loopId,
            plan_name: plan.name,
            total_tasks: plan.tasks.length,
            tasks: plan.tasks.map((t) => ({
              key: t.key,
              title: t.title,
            })),
            next_action:
              "Call agent_loop_dispatch with the first task key to begin execution.",
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_resume — Resume an existing loop (with loop selection)
      // -------------------------------------------------------------------
      agent_loop_resume: tool({
        description:
          "Resume an existing Agent Loop from boulder.json. Use this when re-entering a session with an active loop.",
        args: {
          loop_id: tool.schema
            .string()
            .describe("The loop ID to resume. If omitted: auto-resumes the only resumable loop, or returns a list to choose from.")
            .optional(),
        },
        async execute(args, context) {
          // Run migration first if needed
          await migrateOldLayout(workdir);

          let targetLoopId = args.loop_id;

          if (!targetLoopId) {
            // Discover available loops
            const loops = await listLoops(workdir);
            const resumable = loops.filter(
              (l) =>
                l.status === "running" ||
                l.status === "paused" ||
                l.status === "planning"
            );

            if (resumable.length === 0) {
              // Check if there are any loops at all
              if (loops.length === 0) {
                return JSON.stringify({
                  error: "No Agent Loop instances found. Use agent_loop_init to start a new one.",
                });
              }
              return JSON.stringify({
                error: "No resumable loops found. All loops are completed/halted/failed.",
                all_loops: loops.map((l) => ({
                  loop_id: l.loop_id,
                  status: l.status,
                  progress: l.progress,
                  updated_at: l.updated_at,
                })),
                hint: "Use agent_loop_init to start a new loop.",
              });
            }

            if (resumable.length === 1) {
              // Auto-select the only resumable loop
              targetLoopId = resumable[0].loop_id;
            } else {
              // Multiple resumable loops — return list for user to pick
              return JSON.stringify({
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
              });
            }
          }

          const state = await readBoulder(workdir, targetLoopId);
          if (!state) {
            return JSON.stringify({
              error: `No boulder.json found for loop "${targetLoopId}". Use agent_loop_init to start a new loop.`,
              available_loops: (await listLoops(workdir)).map((l) => l.loop_id),
            });
          }

          if (state.status === "completed") {
            return JSON.stringify({
              status: "completed",
              loop_id: targetLoopId,
              plan: state.plan_name,
              message: "This loop is already completed.",
            });
          }

          // Update orchestrator session
          const runtime = await ensureRuntimeState(
            targetLoopId,
            context.sessionID || null
          );
          orchestratorSessionId =
            context.sessionID || runtime.session_id || state.orchestrator_session_id;
          state.orchestrator_session_id = orchestratorSessionId;
          state.status = "running";
          await writeBoulder(workdir, targetLoopId, state);

          runtime.active = true;
          runtime.session_id = orchestratorSessionId || runtime.session_id;
          runtime.pending_save_progress = false;
          runtime.iteration = 0;
          runtime.stall_count = 0;
          runtime.last_state_hash = null;
          await writeRuntimeState(workdir, targetLoopId, runtime);

          // Activate this loop
          activeLoopId = targetLoopId;
          loopActive = true;
          await writeActiveLoopPointer(workdir, targetLoopId);

          // Find next task
          const nextKey = pickNextTask(state);
          const latestHandoff = await readLatestHandoff(workdir, targetLoopId);

          return JSON.stringify({
            status: "resumed",
            loop_id: targetLoopId,
            plan: state.plan_name,
            iteration: state.iteration,
            progress: `${state.stats.done}/${state.stats.total_tasks}`,
            current_task: state.current_task,
            next_task: nextKey,
            next_task_title: nextKey
              ? state.task_sessions[nextKey]?.task_title
              : null,
            latest_handoff_context: latestHandoff?.next_task_context || null,
            tasks: Object.values(state.task_sessions).map((t) => ({
              key: t.task_key,
              title: t.task_title,
              status: t.status,
              attempts: t.attempts,
            })),
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_dispatch — Build the worker prompt and dispatch
      // -------------------------------------------------------------------
      agent_loop_dispatch: tool({
        description: `Prepare the worker prompt for a specific task. Returns the constructed prompt that should be passed to an agent-loop-worker subagent via the Task tool. The prompt contains ONLY what the worker needs: task description, notepad learnings, previous handoff context, and relevant file paths. This ensures true context isolation.`,
        args: {
          task_key: tool.schema
            .string()
            .describe('The task key to dispatch (e.g. "todo:1")'),
        },
        async execute(args, context) {
          if (!activeLoopId) {
            return JSON.stringify({
              error: "No active loop. Call agent_loop_init or agent_loop_resume first.",
            });
          }

          const state = await readBoulder(workdir, activeLoopId);
          if (!state) {
            return JSON.stringify({
              error: "No active loop state. Call agent_loop_init first.",
            });
          }

          const runtime = await readRuntimeState(workdir, activeLoopId);
          if (runtime?.pending_save_progress) {
            return JSON.stringify({
              error: "Session recycle required before dispatching more workers.",
              pending_save_progress: true,
              next_action:
                "Open a fresh session and call agent_loop_resume, then dispatch the next task.",
            });
          }

          const callerSessionId = context.sessionID || null;
          if (
            runtime?.session_id &&
            callerSessionId &&
            runtime.session_id !== callerSessionId
          ) {
            return JSON.stringify({
              error: "Dispatch attempted from a non-bound session.",
              expected_session_id: runtime.session_id,
              received_session_id: callerSessionId,
              next_action: "Call agent_loop_resume in this session before dispatch.",
            });
          }

          const taskSession = state.task_sessions[args.task_key];
          if (!taskSession) {
            return JSON.stringify({
              error: `Unknown task: ${args.task_key}`,
              available: Object.keys(state.task_sessions),
            });
          }

          if (taskSession.status === "done") {
            return JSON.stringify({
              error: `Task ${args.task_key} is already done.`,
              next: pickNextTask(state),
            });
          }

          if (taskSession.status === "blocked") {
            return JSON.stringify({
              error: `Task ${args.task_key} is blocked after ${taskSession.attempts} attempts.`,
              last_error: taskSession.last_error,
            });
          }

          if (taskSession.status === "in-progress") {
            return JSON.stringify({
              error: `Task ${args.task_key} is already in progress.`,
            });
          }

          // Parse plan to get full task description
          const plan = await parsePlan(state.active_plan);
          const task = plan.tasks.find((t) => t.key === args.task_key);
          if (!task) {
            return JSON.stringify({
              error: `Task ${args.task_key} not found in plan file.`,
            });
          }

          // Build the worker payload
          const payload = await buildPayloadForTask(activeLoopId, state, task);
          const workerPrompt = buildWorkerPrompt(payload);

          // Mark task as started
          markTaskStarted(state, args.task_key);
          await writeBoulder(workdir, activeLoopId, state);

          return JSON.stringify({
            action: "dispatch",
            task_key: args.task_key,
            task_title: taskSession.task_title,
            worker_prompt: workerPrompt,
            instructions:
              `Dispatch this to an agent-loop-worker subagent using the Task tool. Pass the worker_prompt as the task prompt. Do NOT add any additional context — the prompt is self-contained. After the worker returns, call agent_loop_process_handoff with the worker's output.`,
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_process_handoff — Process worker output and update state
      // -------------------------------------------------------------------
      agent_loop_process_handoff: tool({
        description: `Process the output from a completed worker subagent. Parses the HANDOFF block, writes the handoff file, updates notepad learnings, and runs the backpressure gate. Returns the gate result and next action.`,
        args: {
          task_key: tool.schema
            .string()
            .describe("The task key that was just completed"),
          worker_output: tool.schema
            .string()
            .describe("The full output/response from the worker subagent (must contain HANDOFF_START...HANDOFF_END block)"),
          skip_gate: tool.schema
            .boolean()
            .describe("Skip the backpressure gate (use only if gate is known to be irrelevant)")
            .optional(),
        },
        async execute(args, context) {
          if (!activeLoopId) {
            return JSON.stringify({ error: "No active loop." });
          }

          const state = await readBoulder(workdir, activeLoopId);
          if (!state) {
            return JSON.stringify({ error: "No active loop." });
          }

          const taskSession = state.task_sessions[args.task_key];
          if (!taskSession) {
            return JSON.stringify({ error: `Unknown task: ${args.task_key}` });
          }

          if (taskSession.status !== "in-progress") {
            return JSON.stringify({
              error: `Cannot process handoff for ${args.task_key} because task is ${taskSession.status}. Dispatch it first.`,
              task_key: args.task_key,
              task_status: taskSession.status,
              current_task: state.current_task,
            });
          }

          if (state.current_task && state.current_task !== args.task_key) {
            return JSON.stringify({
              error: `Cannot process handoff for ${args.task_key} while ${state.current_task} is current in-progress task.`,
              task_key: args.task_key,
              current_task: state.current_task,
            });
          }

          // Parse the handoff from worker output
          const parsed = parseHandoffFromWorkerOutput(args.worker_output);

          if (!parsed) {
            markTaskFailed(
              state,
              args.task_key,
              "Worker did not produce a HANDOFF_START...HANDOFF_END block."
            );
            await writeBoulder(workdir, activeLoopId, state);

            return JSON.stringify({
              status: "failed",
              reason: "No handoff block found in worker output",
              task_key: args.task_key,
              attempts: state.task_sessions[args.task_key].attempts,
              max_attempts: state.task_sessions[args.task_key].max_attempts,
              can_retry:
                state.task_sessions[args.task_key].attempts <
                state.task_sessions[args.task_key].max_attempts,
              next_action:
                state.task_sessions[args.task_key].attempts <
                state.task_sessions[args.task_key].max_attempts
                  ? `Retry: call agent_loop_dispatch with task_key "${args.task_key}"`
                  : `Task blocked. Call agent_loop_dispatch with the next available task.`,
            });
          }

          const sanitize = (text: string, maxChars: number) =>
            (text || "").trim().slice(0, maxChars);

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

          // Write the handoff file (scoped to this loop)
          const handoffFile: HandoffFile = {
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
          if (parsed.learnings && parsed.learnings.trim()) {
            await appendNotepad(
              workdir,
              activeLoopId,
              "learnings",
              `From ${args.task_key} (${taskSession.task_title}):\n${parsed.learnings}`
            );
          }
          if (parsed.key_decisions && parsed.key_decisions.trim()) {
            await appendNotepad(
              workdir,
              activeLoopId,
              "decisions",
              `From ${args.task_key}:\n${parsed.key_decisions}`
            );
          }
          if (parsed.blocked_issues && parsed.blocked_issues.trim() && parsed.blocked_issues !== "None") {
            await appendNotepad(
              workdir,
              activeLoopId,
              "issues",
              `From ${args.task_key}:\n${parsed.blocked_issues}`
            );
          }

          // Handle worker-reported blocked
          if (parsed.status === "blocked") {
            markTaskBlocked(
              state,
              args.task_key,
              parsed.blocked_issues || "Worker reported blocked status"
            );
            await writeBoulder(workdir, activeLoopId, state);

            const nextKey = pickNextTask(state);
            return JSON.stringify({
              status: "blocked",
              task_key: args.task_key,
              reason: parsed.blocked_issues,
              summary: compressedSummary,
              can_retry: false,
              next_task: nextKey,
              next_action: nextKey
                ? `Dispatch next task: agent_loop_dispatch("${nextKey}")`
                : shouldHalt(state)
                ? "Loop halted — all remaining tasks blocked."
                : "No more tasks available.",
            });
          }

          // Handle worker-reported failure
          if (parsed.status === "failed") {
            markTaskFailed(
              state,
              args.task_key,
              parsed.blocked_issues || "Worker reported failure"
            );
            await writeBoulder(workdir, activeLoopId, state);

            const nextKey = pickNextTask(state);
            return JSON.stringify({
              status: parsed.status,
              task_key: args.task_key,
              reason: parsed.blocked_issues,
              summary: compressedSummary,
              can_retry:
                state.task_sessions[args.task_key].attempts <
                state.task_sessions[args.task_key].max_attempts,
              next_task: nextKey,
              next_action: nextKey
                ? `Dispatch next task: agent_loop_dispatch("${nextKey}")`
                : shouldHalt(state)
                ? "Loop halted — all remaining tasks blocked."
                : "No more tasks available.",
            });
          }

          // Run backpressure gate
          let gateResult = {
            passed: true,
            build: null,
            test: null,
            lint: null,
            timestamp: new Date().toISOString(),
          } as ReturnType<typeof import("./gate").runBackpressureGate> extends Promise<infer T> ? T : never;

          if (!args.skip_gate) {
            try {
              gateResult = await runBackpressureGate(runShell, workdir);
            } catch (e: any) {
              gateResult = {
                passed: false,
                build: null,
                test: { passed: false, output: e.message || String(e) },
                lint: null,
                timestamp: new Date().toISOString(),
              };
            }
          }

          if (gateResult.passed) {
            markTaskDone(state, args.task_key);
            state.stats.backpressure_failures = Math.max(
              0,
              (state.stats.backpressure_failures || 0)
            );
          } else {
            state.stats.backpressure_failures =
              (state.stats.backpressure_failures || 0) + 1;
            markTaskFailed(
              state,
              args.task_key,
              `Backpressure gate failed:\n${formatGateResult(gateResult)}`
            );
          }

          const nextKey = pickNextTask(state);
          const allDone = isLoopComplete(state);
          const halted = shouldHalt(state);

          if (allDone) {
            state.status = "completed";
          } else if (halted) {
            state.status = "halted";
          }

          await writeBoulder(workdir, activeLoopId, state);

          if (isTerminalLoopStatus(state.status)) {
            loopActive = false;
            const runtime = await readRuntimeState(workdir, activeLoopId);
            if (runtime) {
              runtime.active = false;
              runtime.pending_save_progress = false;
              await writeRuntimeState(workdir, activeLoopId, runtime);
            }
            await clearActiveLoopIfTerminal(activeLoopId, state.status);
          }

          const doneTasks = Object.values(state.task_sessions).filter(
            (t) => t.status === "done"
          );

          return JSON.stringify({
            status: gateResult.passed ? "done" : "gate_failed",
            task_key: args.task_key,
            summary: compressedSummary,
            gate: {
              passed: gateResult.passed,
              build: gateResult.build
                ? { passed: gateResult.build.passed }
                : null,
              test: gateResult.test
                ? { passed: gateResult.test.passed }
                : null,
              lint: gateResult.lint
                ? { passed: gateResult.lint.passed }
                : null,
            },
            gate_details: !gateResult.passed
              ? formatGateResult(gateResult)
              : undefined,
            progress: `${doneTasks.length}/${state.stats.total_tasks}`,
            all_done: allDone,
            halted,
            next_task: nextKey,
            next_task_title: nextKey
              ? state.task_sessions[nextKey]?.task_title
              : null,
            next_action: allDone
              ? "All tasks complete! Generate a completion report."
              : halted
              ? "Loop halted. Review blocked tasks and decide how to proceed."
              : gateResult.passed && nextKey
              ? `Dispatch next: agent_loop_dispatch("${nextKey}")`
              : !gateResult.passed
              ? `Gate failed for ${args.task_key}. ${
                  state.task_sessions[args.task_key].attempts <
                  state.task_sessions[args.task_key].max_attempts
                    ? `Retry: agent_loop_dispatch("${args.task_key}")`
                    : `Task blocked. Move to next: agent_loop_dispatch("${nextKey || "none"}")`
                }`
              : "No more tasks.",
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_status — Check current loop status
      // -------------------------------------------------------------------
      agent_loop_status: tool({
        description:
          "Get the current status of the Agent Loop: progress, task states, latest handoff.",
        args: {
          loop_id: tool.schema
            .string()
            .describe("Specific loop ID to check. Omit to see the active loop and list all loops.")
            .optional(),
        },
        async execute(args, context) {
          // Run migration first if needed
          await migrateOldLayout(workdir);

          const targetLoopId = args.loop_id || activeLoopId;

          // If no specific loop requested and no active loop, list all
          if (!targetLoopId) {
            const loops = await listLoops(workdir);
            return JSON.stringify({
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
            });
          }

          const state = await readBoulder(workdir, targetLoopId);
          const runtime = await readRuntimeState(workdir, targetLoopId);
          if (!state) {
            return JSON.stringify({
              active: false,
              loop_id: targetLoopId,
              message: `Loop "${targetLoopId}" not found.`,
              available_loops: (await listLoops(workdir)).map((l) => l.loop_id),
            });
          }

          const latestHandoff = await readLatestHandoff(workdir, targetLoopId);

          // Also list all loops for context
          const allLoops = await listLoops(workdir);

          return JSON.stringify({
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
            tasks: Object.values(state.task_sessions).map((t) => ({
              key: t.task_key,
              title: t.task_title,
              status: t.status,
              attempts: t.attempts,
              error: t.last_error
                ? t.last_error.slice(0, 100)
                : undefined,
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
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_halt — Manually halt the loop
      // -------------------------------------------------------------------
      agent_loop_halt: tool({
        description:
          "Manually halt the Agent Loop. Tasks in progress will be marked as paused.",
        args: {
          reason: tool.schema
            .string()
            .describe("Reason for halting")
            .optional(),
        },
        async execute(args, context) {
          if (!activeLoopId) {
            return JSON.stringify({ error: "No active loop." });
          }

          const state = await readBoulder(workdir, activeLoopId);
          if (!state) {
            return JSON.stringify({ error: "No active loop." });
          }

          const runtime = await readRuntimeState(workdir, activeLoopId);

          state.status = "paused";
          if (state.current_task) {
            const t = state.task_sessions[state.current_task];
            if (t && t.status === "in-progress") {
              t.status = "pending";
            }
            state.current_task = null;
          }
          await writeBoulder(workdir, activeLoopId, state);
          loopActive = false;
          if (runtime) {
            runtime.active = false;
            runtime.pending_save_progress = false;
            await writeRuntimeState(workdir, activeLoopId, runtime);
          }

          // Clear active loop pointer
          await clearActiveLoopPointer(workdir);

          return JSON.stringify({
            status: "paused",
            loop_id: activeLoopId,
            reason: args.reason || "Manual halt",
            progress: `${state.stats.done}/${state.stats.total_tasks}`,
            message:
              "Loop paused. Use agent_loop_resume to continue later.",
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_backpressure_gate — Run the gate manually
      // -------------------------------------------------------------------
      agent_loop_backpressure_gate: tool({
        description:
          "Run the backpressure quality gate (build + test + lint) and return results.",
        args: {},
        async execute(args, context) {
          const result = await runBackpressureGate(runShell, workdir);
          return formatGateResult(result);
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_update_notepad — Manually add to notepad
      // -------------------------------------------------------------------
      agent_loop_update_notepad: tool({
        description:
          "Add an entry to the notepad system (learnings, decisions, or issues).",
        args: {
          type: tool.schema
            .enum(["learnings", "decisions", "issues"])
            .describe("Which notepad to update"),
          content: tool.schema
            .string()
            .describe("Content to append"),
        },
        async execute(args, context) {
          if (!activeLoopId) {
            return JSON.stringify({
              error: "No active loop — notepad needs a loop context.",
            });
          }

          await appendNotepad(
            workdir,
            activeLoopId,
            args.type,
            args.content
          );
          return JSON.stringify({
            status: "appended",
            notepad: args.type,
            loop_id: activeLoopId,
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_completion_report — Generate final report
      // -------------------------------------------------------------------
      agent_loop_completion_report: tool({
        description:
          "Generate a completion report for the finished Agent Loop. Summarizes all tasks, decisions, and learnings.",
        args: {},
        async execute(args, context) {
          if (!activeLoopId) {
            return JSON.stringify({ error: "No active loop." });
          }

          const state = await readBoulder(workdir, activeLoopId);
          if (!state) {
            return JSON.stringify({ error: "No loop state found." });
          }

          const learnings = await readNotepad(workdir, activeLoopId, "learnings");
          const decisions = await readNotepad(workdir, activeLoopId, "decisions");
          const issues = await readNotepad(workdir, activeLoopId, "issues");

          const tasks = Object.values(state.task_sessions);
          const done = tasks.filter((t) => t.status === "done");
          const blocked = tasks.filter((t) => t.status === "blocked");
          const totalAttempts = tasks.reduce((s, t) => s + t.attempts, 0);

          const report = [
            `# Agent Loop Completion Report`,
            ``,
            `**Loop ID**: ${activeLoopId}`,
            `**Plan**: ${state.plan_name}`,
            `**Started**: ${state.started_at}`,
            `**Completed**: ${state.updated_at}`,
            `**Iterations**: ${state.iteration}`,
            `**Total Attempts**: ${totalAttempts}`,
            ``,
            `## Results: ${done.length}/${tasks.length} tasks completed`,
            ``,
            ...done.map(
              (t) => `- [done] ${t.task_key}: ${t.task_title} (${t.attempts} attempt${t.attempts > 1 ? "s" : ""})`
            ),
            ...blocked.map(
              (t) => `- [blocked] ${t.task_key}: ${t.task_title} — ${t.last_error?.slice(0, 100) || "unknown"}`
            ),
            ``,
            learnings
              ? `## Key Learnings\n${learnings}\n`
              : "",
            decisions
              ? `## Architectural Decisions\n${decisions}\n`
              : "",
            issues
              ? `## Known Issues\n${issues}\n`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          // Write report to loop-specific directory
          const reportPath = join(
            loopInstanceDir(workdir, activeLoopId),
            `report-${state.plan_name}.md`
          );
          await writeFile(reportPath, report, "utf-8");

          return report;
        },
      }),
    },
  };
};

// ---------------------------------------------------------------------------
// Utility: Extract file paths from text
// ---------------------------------------------------------------------------

function extractFilePaths(text: string): string[] {
  const patterns = [
    // Backtick-wrapped paths
    /`([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)`/g,
    // Common source file patterns
    /(?:src|lib|app|test|tests|pkg)\/[a-zA-Z0-9_\-./]+\.[a-zA-Z]+/g,
  ];

  const paths = new Set<string>();
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const p = m[1] || m[0];
      // Filter out things that aren't likely file paths
      if (p.includes("/") && !p.startsWith("http")) {
        paths.add(p);
      }
    }
  }
  return [...paths];
}

export default AgentLoopPlugin;

function computeBoulderHash(state: BoulderState): string {
  const payload = {
    status: state.status,
    iteration: state.iteration,
    current_task: state.current_task,
    task_sessions: Object.values(state.task_sessions)
      .map((t) => ({
        key: t.task_key,
        status: t.status,
        attempts: t.attempts,
        completed_at: t.completed_at || null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
