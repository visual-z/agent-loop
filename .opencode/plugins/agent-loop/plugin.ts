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
import { join, basename } from "path";
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
  pickReadyTasks,
  inProgressTaskKeys,
  isLoopComplete,
  shouldHalt,
  parsePlan,
  readHandoff,
  readLatestHandoff,
  writeHandoff,
  writeWorkerPrompt,
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
  readPlanFrontmatter,
  stampPlanApproved,
  appendPlanFeedback,
  readPlanFeedback,
  readPlanContent,
  appendPlanClarifications,
  readPlanClarifications,
} from "./state";

import {
  buildWorkerPrompt,
  buildContinuationPrompt,
  buildCompactionContext,
  buildPlanArchitectPrompt,
  parseHandoffFromWorkerOutput,
} from "./prompts";

import {
  runBackpressureGate,
  formatGateResult,
  getBackpressureShellCommand,
} from "./gate";
import {
  loadWorkerCatalog,
  getPersonaBody,
  type WorkerCatalogEntry,
} from "./worker-catalog";

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

  /** Most recent terminal loop, kept so completion_report works after cleanup */
  let lastTerminalLoopId: string | null = null;

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

  /**
   * The exhaustive list of subagent IDs the orchestrator is allowed to
   * dispatch. Personas are NOT here — they are injected as prompt prefixes
   * into `agent-loop-worker`, not dispatched as separate subagents.
   */
  const ALLOWED_DISPATCH_TARGETS = new Set([
    "agent-loop-worker",
    "agent-loop-plan-architect",
    "agent-test-worker",
    "monkey-test-page-tester",
    "monkey-test-report-reviewer",
  ]);

  const isTerminalLoopStatus = (status: BoulderState["status"]) =>
    status === "completed" || status === "halted" || status === "failed";

  async function clearActiveLoopIfTerminal(
    loopId: string | null,
    status: BoulderState["status"]
  ): Promise<void> {
    if (!loopId || !isTerminalLoopStatus(status)) return;
    lastTerminalLoopId = loopId;
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

  async function injectSessionPrompt(
    targetSessionId: string,
    text: string,
    noReply = false
  ): Promise<void> {
    const body = {
      parts: [{ type: "text", text }],
      ...(noReply ? { noReply: true } : {}),
    };

    await client.session.prompt({
      path: targetSessionId,
      body,
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
    const filePaths =
      task.file_paths && task.file_paths.length > 0
        ? task.file_paths
        : extractFilePaths(
            `${task.description}\n${task.acceptance_criteria}\n${task.references}`
          );

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
              await injectSessionPrompt(
                targetSessionId,
                "## Agent Loop — Session Recycle Required\n\n" +
                  `Session context pressure reached ${Math.round(sessionPressure * 100)}%.\n` +
                  "Please save progress now and continue in a fresh session using agent_loop_resume.\n" +
                  "Do not dispatch a new worker in this session."
              );
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
          const readyKeys = pickReadyTasks(state, 8);
          const inFlight = inProgressTaskKeys(state);
          const nextKey = readyKeys[0] ?? null;
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
            ready_tasks: readyKeys.map((k) => ({
              task_key: k,
              task_title: state.task_sessions[k]?.task_title ?? "",
            })),
            in_progress_tasks: inFlight.map((k) => ({
              task_key: k,
              task_title: state.task_sessions[k]?.task_title ?? "",
            })),
          };

          if (latestHandoff) {
            ctx.handoff_summary = latestHandoff.what_was_done;
          }

          if (!nextKey && inFlight.length === 0) {
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
            await injectSessionPrompt(targetSessionId, prompt);

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
    //
    // The orchestrator is forbidden from calling mutation tools at ALL TIMES,
    // not just when a loop is active. The plan-architect subagent is the only
    // path to writing files (via the Task tool). This is the structural cure
    // for the "orchestrator keeps trying to Write/Edit" failure mode.
    // =========================================================================
    "tool.execute.before": async (input: any, output: any) => {
      const toolName = input?.tool || input?.name;
      if (!toolName) return;

      const sessionId =
        getSessionIdFromEvent(input) ||
        getSessionIdFromEvent(output) ||
        null;

      // Identify the orchestrator session through any signal we have:
      //   1. cached in-memory orchestratorSessionId (set on init/resume/session.created)
      //   2. boulder.json's bound orchestrator_session_id (cross-session continuity)
      let boundSessionId = orchestratorSessionId;
      if (!boundSessionId && activeLoopId) {
        const state = await readBoulder(workdir, activeLoopId);
        boundSessionId = state?.orchestrator_session_id || null;
      }

      const isOrchestratorCall =
        Boolean(boundSessionId) && sessionId === boundSessionId;

      // If we're certain this is the orchestrator session, never let it mutate.
      if (isOrchestratorCall && ORCHESTRATOR_MUTATION_TOOLS.has(toolName)) {
        throw new Error(
          `Agent Loop policy violation: orchestrator cannot call ${toolName}. ` +
            `Delegate to a worker via the Task tool. For plan files specifically, ` +
            `dispatch \`agent-loop-plan-architect\`.`
        );
      }

      // Sandbox: any write/edit/patch from any session must land inside the
      // project workdir. Catches subagent typos (relative paths from a wrong
      // cwd) and accidental writes to ~ or /tmp. Bash mutations are not
      // intercepted here — those go through the orchestrator deny + per-agent
      // permission config.
      if (toolName === "write" || toolName === "edit" || toolName === "patch" || toolName === "multiedit") {
        const args = output?.args || input?.args || {};
        const target =
          args.filePath ||
          args.file_path ||
          args.path ||
          args.target ||
          (Array.isArray(args.edits) && args.edits[0]?.filePath) ||
          null;
        if (typeof target === "string" && target.length > 0) {
          const resolved = target.startsWith("/")
            ? target
            : join(workdir, target);
          // Reject paths that escape workdir via prefix mismatch or `..`.
          const normalizedWork = workdir.replace(/\/+$/, "");
          const normalizedTarget = resolved.replace(/\/+$/, "");
          const escapes =
            !normalizedTarget.startsWith(normalizedWork + "/") &&
            normalizedTarget !== normalizedWork;
          if (escapes) {
            throw new Error(
              `Agent Loop sandbox violation: ${toolName} target "${target}" resolves to "${resolved}" which is OUTSIDE the project workdir "${workdir}". ` +
                `All file mutation must stay inside the project. If you intended a project-relative path, ensure it does not start with "/" or "..".`
            );
          }
        }
      }

      // Defense in depth: if the call originates from the orchestrator
      // session, prevent orchestrator from dispatching itself or any agent
      // outside the known whitelist. Personas are NOT dispatched directly —
      // they are injected as prompt prefixes into `agent-loop-worker`.
      if (isOrchestratorCall && toolName === "task") {
        const args = output?.args || input?.args || {};
        const targetAgent =
          args.subagent_type || args.agent || args.subagent || args.name || null;

        if (!targetAgent) {
          throw new Error(
            "Agent Loop policy violation: Task calls from orchestrator must target a worker subagent explicitly."
          );
        }

        if (
          targetAgent === "agent-loop-orchestrator" ||
          targetAgent === "agent-loop:agent-loop-orchestrator"
        ) {
          throw new Error(
            `Agent Loop policy violation: orchestrator may not dispatch itself, received: ${targetAgent}`
          );
        }

        const normalized = String(targetAgent).replace(/^agent-loop:/, "");
        if (!ALLOWED_DISPATCH_TARGETS.has(normalized)) {
          throw new Error(
            `Agent Loop policy violation: subagent_type "${targetAgent}" is not in the allowlist. ` +
              `Allowed targets: ${[...ALLOWED_DISPATCH_TARGETS].join(", ")}. ` +
              `For specialist execution, dispatch \`agent-loop-worker\` and pass \`persona_id\` to \`agent_loop_dispatch\` — personas are prompt prefixes, not OpenCode agents.`
          );
        }
      }
    },

    // =========================================================================
    // Custom Tools — Exposed to the orchestrator agent
    // =========================================================================
    tool: {
      // -------------------------------------------------------------------
      // agent_loop_propose_plan — Hand off plan authoring to plan-architect
      // -------------------------------------------------------------------
      agent_loop_propose_plan: tool({
        description: `Start (or revise) a plan via the agent-loop-plan-architect subagent. The orchestrator MUST NOT write the plan itself — call this tool, then dispatch agent-loop-plan-architect with the returned worker_prompt. After the architect returns, call agent_loop_request_plan_approval.`,
        args: {
          plan_name: tool.schema
            .string()
            .describe("Slug for the plan file. Becomes .agent-loop/plans/{plan_name}.md"),
          objective: tool.schema
            .string()
            .describe("High-level objective the plan must accomplish."),
        },
        async execute(args, context) {
          if (!args.plan_name || !/^[a-zA-Z0-9_-]+$/.test(args.plan_name)) {
            return JSON.stringify({
              error:
                "plan_name must be a slug (a-zA-Z0-9_-). Avoid spaces and slashes.",
            });
          }

          orchestratorSessionId =
            context.sessionID || orchestratorSessionId || null;

          const planPath = join(plansDir(workdir), `${args.plan_name}.md`);
          const fm = await readPlanFrontmatter(planPath);

          if (fm.approved_at) {
            return JSON.stringify({
              error: "Plan already approved; cannot re-propose.",
              plan_path: planPath,
              approved_at: fm.approved_at,
              next_action: `Call agent_loop_init with plan_path="${planPath}".`,
            });
          }

          const priorPlanContent = await readPlanContent(planPath);
          const accumulatedFeedback = await readPlanFeedback(planPath);
          const accumulatedClarifications = await readPlanClarifications(planPath);
          const nextRevision = (fm.revision ?? 0) + 1;

          const workerPrompt = buildPlanArchitectPrompt({
            plan_path: planPath,
            plan_name: args.plan_name,
            objective: args.objective,
            revision: nextRevision,
            prior_plan_content: priorPlanContent,
            accumulated_feedback: accumulatedFeedback,
            accumulated_clarifications: accumulatedClarifications,
          });

          return JSON.stringify({
            action: "dispatch_plan_architect",
            plan_path: planPath,
            plan_name: args.plan_name,
            revision: nextRevision,
            worker_agent: "agent-loop-plan-architect",
            worker_prompt: workerPrompt,
            instructions:
              "Dispatch `agent-loop-plan-architect` via the Task tool with worker_prompt as the task prompt. The architect's final response will be EITHER `PLAN_WRITTEN` (plan file is on disk → call agent_loop_request_plan_approval) OR `CLARIFY_REQUEST` (architect needs user input first → surface its Questions section to the user verbatim, collect answers, then call agent_loop_record_clarifications). Do NOT call agent_loop_init yet either way.",
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_request_plan_approval — HITL gate
      // -------------------------------------------------------------------
      agent_loop_request_plan_approval: tool({
        description: `Surface the drafted plan to the user for approval. The orchestrator MUST present the returned plan content verbatim to the user and STOP — wait for the user to reply with their decision (approve / edit / regenerate). When the user replies, call agent_loop_record_plan_decision.`,
        args: {
          plan_path: tool.schema
            .string()
            .describe("Path to the plan file the architect just wrote."),
        },
        async execute(args) {
          const planPath = args.plan_path.startsWith("/")
            ? args.plan_path
            : join(workdir, args.plan_path);

          if (!existsSync(planPath)) {
            return JSON.stringify({
              error: `Plan file not found: ${planPath}`,
            });
          }

          const fm = await readPlanFrontmatter(planPath);
          if (fm.approved_at) {
            return JSON.stringify({
              status: "already_approved",
              plan_path: planPath,
              approved_at: fm.approved_at,
              next_action: `Call agent_loop_init with plan_path="${planPath}".`,
            });
          }

          const content = await readPlanContent(planPath);
          const accumulatedFeedback = await readPlanFeedback(planPath);

          return JSON.stringify({
            action: "ask_user_for_plan_approval",
            plan_path: planPath,
            plan_name: fm.plan_name,
            revision: fm.revision ?? 1,
            plan_content: content,
            prior_feedback_rounds: accumulatedFeedback || null,
            user_question: [
              "I drafted the plan above. Please reply with one of:",
              "  - `approve` — accept as-is and start execution",
              "  - `edit: <your feedback>` — keep the structure but make these changes",
              "  - `regenerate: <your feedback>` — start over with a new approach",
              "I will not proceed until you reply.",
            ].join("\n"),
            instructions:
              "Present `plan_content` to the user verbatim, then ask the question above. STOP and wait. When the user replies, call agent_loop_record_plan_decision with their decision. Do not call any other agent_loop_* tool until the user responds.",
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_record_plan_decision — Apply user's verdict
      // -------------------------------------------------------------------
      agent_loop_record_plan_decision: tool({
        description: `Record the user's decision on the proposed plan. If approve, the plan is stamped with approved_at and the orchestrator can call agent_loop_init. If edit/regenerate, the feedback is recorded and a fresh plan-architect dispatch prompt is returned for the orchestrator to send.`,
        args: {
          plan_path: tool.schema.string().describe("Path to the plan file."),
          decision: tool.schema
            .enum(["approve", "edit", "regenerate"])
            .describe("User's verdict."),
          feedback: tool.schema
            .string()
            .describe("User feedback (required for edit/regenerate; ignored for approve).")
            .optional(),
          objective: tool.schema
            .string()
            .describe("Original objective — pass through so the architect retains context on revision.")
            .optional(),
        },
        async execute(args) {
          const planPath = args.plan_path.startsWith("/")
            ? args.plan_path
            : join(workdir, args.plan_path);

          if (!existsSync(planPath)) {
            return JSON.stringify({ error: `Plan file not found: ${planPath}` });
          }

          if (args.decision === "approve") {
            const stamped = await stampPlanApproved(planPath);
            return JSON.stringify({
              status: "approved",
              plan_path: planPath,
              approved_at: stamped.approved_at,
              revision: stamped.revision,
              next_action: `Call agent_loop_init with plan_path="${planPath}" to start execution.`,
            });
          }

          // edit / regenerate
          const feedback = (args.feedback || "").trim();
          if (!feedback) {
            return JSON.stringify({
              error: `decision=${args.decision} requires non-empty feedback.`,
            });
          }

          await appendPlanFeedback(planPath, feedback, args.decision);

          const fm = await readPlanFrontmatter(planPath);
          const nextRevision = (fm.revision ?? 1) + 1;
          const priorPlanContent = await readPlanContent(planPath);
          const accumulatedFeedback = await readPlanFeedback(planPath);
          const accumulatedClarifications = await readPlanClarifications(planPath);
          const planName = fm.plan_name || basename(planPath, ".md");

          const workerPrompt = buildPlanArchitectPrompt({
            plan_path: planPath,
            plan_name: planName,
            objective: args.objective || "(reuse the objective from the prior revision)",
            revision: nextRevision,
            prior_plan_content: priorPlanContent,
            accumulated_feedback: accumulatedFeedback,
            accumulated_clarifications: accumulatedClarifications,
          });

          return JSON.stringify({
            status: "revision_requested",
            decision: args.decision,
            plan_path: planPath,
            next_revision: nextRevision,
            worker_agent: "agent-loop-plan-architect",
            worker_prompt: workerPrompt,
            instructions:
              "Dispatch `agent-loop-plan-architect` again with worker_prompt. After it returns, call agent_loop_request_plan_approval again to re-enter the approval gate.",
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_record_clarifications — Persist user answers to the
      //   architect's CLARIFY_REQUEST and re-dispatch the architect with
      //   the answers attached. The plan-architect can keep cycling through
      //   clarification rounds as long as it surfaces real unknowns.
      // -------------------------------------------------------------------
      agent_loop_record_clarifications: tool({
        description: `When the plan-architect's last output was CLARIFY_REQUEST instead of PLAN_WRITTEN, surface the questions to the user, collect their answers, and call this tool with the (question, answer) pairs. The tool persists them to {plan_name}.clarifications.md and returns a fresh architect dispatch prompt that includes the accumulated clarifications. The revision number does NOT bump for clarification rounds — they are conversational, not authoring rounds.`,
        args: {
          plan_path: tool.schema.string().describe("Path to the plan file (same one used in propose_plan)."),
          objective: tool.schema
            .string()
            .describe("Original objective — pass through so the architect retains context.")
            .optional(),
          qa_pairs: tool.schema
            .array(
              tool.schema.object({
                question: tool.schema.string(),
                answer: tool.schema.string(),
              })
            )
            .describe(
              "Array of {question, answer}. Question text should match what the architect asked (paraphrasing fine). Answer must come from the user — do not invent."
            ),
        },
        async execute(args) {
          const planPath = args.plan_path.startsWith("/")
            ? args.plan_path
            : join(workdir, args.plan_path);

          const fm = await readPlanFrontmatter(planPath);
          if (fm.approved_at) {
            return JSON.stringify({
              error: "Plan already approved; clarifications are no longer accepted.",
              plan_path: planPath,
            });
          }

          if (!Array.isArray(args.qa_pairs) || args.qa_pairs.length === 0) {
            return JSON.stringify({
              error: "qa_pairs must be a non-empty array.",
            });
          }
          for (const pair of args.qa_pairs) {
            if (!pair?.question?.trim() || !pair?.answer?.trim()) {
              return JSON.stringify({
                error: "Every qa_pair must have non-empty question and answer.",
                offending: pair,
              });
            }
          }

          await appendPlanClarifications(planPath, args.qa_pairs);

          const planName = fm.plan_name || basename(planPath, ".md");
          // Clarifications do NOT bump revision; they only enrich the next
          // dispatch's context. Revision = current revision (or 1 if no plan
          // file yet exists on disk).
          const revisionForNextDispatch = fm.revision ?? 1;

          const priorPlanContent = await readPlanContent(planPath);
          const accumulatedFeedback = await readPlanFeedback(planPath);
          const accumulatedClarifications = await readPlanClarifications(planPath);

          const workerPrompt = buildPlanArchitectPrompt({
            plan_path: planPath,
            plan_name: planName,
            objective:
              args.objective || "(reuse the objective from the prior dispatch)",
            revision: revisionForNextDispatch,
            prior_plan_content: priorPlanContent,
            accumulated_feedback: accumulatedFeedback,
            accumulated_clarifications: accumulatedClarifications,
          });

          return JSON.stringify({
            status: "clarifications_recorded",
            plan_path: planPath,
            rounds_recorded: args.qa_pairs.length,
            worker_agent: "agent-loop-plan-architect",
            worker_prompt: workerPrompt,
            instructions:
              "Dispatch `agent-loop-plan-architect` again with worker_prompt. The architect's next output will EITHER be PLAN_WRITTEN (it had enough info this time) OR another CLARIFY_REQUEST (it still has unknowns — record those too and loop). Either way, do NOT call agent_loop_init until a plan is approved.",
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_init — Initialize a new Agent Loop from a plan
      // -------------------------------------------------------------------
      agent_loop_init: tool({
        description: `Initialize a new Agent Loop. Provide a plan_path. By default the runtime auto-stamps approved_at and starts immediately — the architect already extracted user intent via clarification rounds, so a separate approval click is just ceremony. To force the legacy "show plan, ask approve/edit/regenerate" gate (rare; only when user explicitly wants to review before any worker runs), pass auto_approve: false.`,
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
          auto_approve: tool.schema
            .boolean()
            .describe("Default true. If true, stamps approved_at automatically before starting. Set false ONLY when user explicitly requested a manual approval gate.")
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
              error: "Plan creation goes through agent_loop_propose_plan first.",
              next_action: `Call agent_loop_propose_plan with plan_name="${args.plan_name}" and objective="${args.objective}". The plan-architect will draft the plan (asking clarifying questions if needed). When it returns PLAN_WRITTEN, call agent_loop_init with the plan_path.`,
            });
          } else {
            return JSON.stringify({
              error:
                "Provide plan_path (or call agent_loop_propose_plan first to create a plan).",
            });
          }

          // Approval gate: by default auto-approve so we don't ask the user
          // for ceremonial confirmation. Clarifying questions during the
          // architect phase already extracted user intent; a second
          // approve/edit/regenerate prompt is friction. The legacy manual
          // gate stays available via auto_approve: false.
          const autoApprove = args.auto_approve !== false;
          let fm = await readPlanFrontmatter(planPath);
          if (!fm.approved_at) {
            if (autoApprove) {
              await stampPlanApproved(planPath);
              fm = await readPlanFrontmatter(planPath);
            } else {
              return JSON.stringify({
                error: "Plan not approved and auto_approve was disabled.",
                plan_path: planPath,
                next_action:
                  "Call agent_loop_request_plan_approval, then agent_loop_record_plan_decision. Or call agent_loop_init again without auto_approve=false.",
              });
            }
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
      // agent_loop_pick_batch — Return all task_keys ready to dispatch
      //                          in parallel right now, with the metadata
      //                          the orchestrator needs to judge coupling
      // -------------------------------------------------------------------
      agent_loop_pick_batch: tool({
        description: `Return ALL task_keys whose dependencies are satisfied. Each entry includes the metadata (file paths, acceptance criteria, must-not-do, parallel-group hint) the orchestrator needs to JUDGE COUPLING and decide which subset to actually run in parallel. Dependency-graph independence is necessary but not sufficient: two tasks may depend only on a common ancestor yet still mutate the same file. The orchestrator must reason over file overlap, shared resources, and task-type risk before issuing concurrent dispatches.`,
        args: {
          max: tool.schema
            .number()
            .describe("Soft cap on how many ready tasks to return. Default 8.")
            .optional(),
        },
        async execute(args) {
          if (!activeLoopId) {
            return JSON.stringify({ error: "No active loop." });
          }
          const state = await readBoulder(workdir, activeLoopId);
          if (!state) {
            return JSON.stringify({ error: "No active loop state." });
          }
          const cap = typeof args.max === "number" && args.max > 0 ? args.max : 8;
          const readyKeys = pickReadyTasks(state, cap);
          const inFlight = inProgressTaskKeys(state);

          // Resolve full task records from the plan so we can return enough
          // metadata for coupling judgment.
          let plan: Awaited<ReturnType<typeof parsePlan>> | null = null;
          try {
            plan = await parsePlan(state.active_plan);
          } catch {
            plan = null;
          }

          const truncate = (s: string, n: number) =>
            s.length > n ? s.slice(0, n).trim() + "…" : s.trim();

          const readyWithMeta = readyKeys.map((k) => {
            const t = plan?.tasks.find((x) => x.key === k);
            const desc = t?.description ?? "";
            const acc = t?.acceptance_criteria ?? "";
            const refs = t?.references ?? "";
            // Extract paths from every segment that mentions concrete files.
            const file_paths =
              t?.file_paths && t.file_paths.length > 0
                ? t.file_paths
                : extractFilePaths(`${desc}\n${acc}\n${refs}`);
            return {
              task_key: k,
              task_title: state.task_sessions[k]?.task_title,
              attempts: state.task_sessions[k]?.attempts ?? 0,
              dependencies: state.task_sessions[k]?.dependencies ?? [],
              acceptance_criteria: truncate(acc, 400),
              must_not_do: truncate(t?.must_not_do ?? "", 200),
              references: truncate(refs, 200),
              file_paths,
              task_type: t?.task_type ?? inferTaskType(desc),
              parallel_group: t?.parallel_group ?? null,
            };
          });

          // Heuristic file-overlap pre-check (advisory only).
          const overlapPairs: { a: string; b: string; shared: string[] }[] = [];
          for (let i = 0; i < readyWithMeta.length; i++) {
            for (let j = i + 1; j < readyWithMeta.length; j++) {
              const a = readyWithMeta[i];
              const b = readyWithMeta[j];
              const shared = a.file_paths.filter((p) => b.file_paths.includes(p));
              if (shared.length > 0) {
                overlapPairs.push({ a: a.task_key, b: b.task_key, shared });
              }
            }
          }

          let instructions: string;
          if (readyWithMeta.length === 0) {
            instructions =
              inFlight.length > 0
                ? "Nothing new is ready; the existing batch is still running. Wait for in-progress workers to return."
                : "No ready or in-flight tasks. Either all done, all blocked, or dependencies elsewhere. Check agent_loop_status.";
          } else if (readyWithMeta.length === 1) {
            instructions = "Only one task is ready right now. Dispatch it normally.";
          } else {
            instructions = [
              `${readyWithMeta.length} tasks have their dependencies satisfied. Decide WHICH SUBSET to run in parallel.`,
              "",
              "Heuristics for parallel-safe:",
              "  • Same `parallel_group` tag → safe to run together (architect-blessed).",
              "  • `file_paths` and `references` do NOT overlap → likely safe.",
              "  • All `task_type: impl` AND modify disjoint directories → likely safe.",
              "",
              "Heuristics for must-serialize:",
              "  • Any pair listed in `coupling_warnings.file_overlap` below.",
              "  • Tasks that touch shared schema (DB migration, generated client, lockfile, tsconfig, CI config).",
              "  • Tasks whose `must_not_do` mentions concurrent edits.",
              "  • `task_type: verify` — should run alone after its inputs settle.",
              "",
              "Recipe: choose your parallel subset, call `agent_loop_dispatch` for each in that subset, then issue ALL their `task_prompt`s to the Task tool IN THE SAME RESPONSE (one tool_use block per task) so OpenCode runs them concurrently. Run any serialized leftovers in a follow-up turn.",
            ].join("\n");
          }

          return JSON.stringify({
            ready_tasks: readyWithMeta,
            in_progress: inFlight,
            cap,
            coupling_warnings: {
              file_overlap: overlapPairs,
              note:
                overlapPairs.length > 0
                  ? "These pairs reference at least one common file path. Consider serializing them or splitting the batch."
                  : "No automatic file-overlap detected — but extract_file_paths is heuristic; verify by reading task descriptions.",
            },
            instructions,
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_dispatch — Build the worker prompt and dispatch
      // -------------------------------------------------------------------
      agent_loop_dispatch: tool({
        description: `Prepare a specific task for worker dispatch. Writes the full worker prompt to a per-loop prompt file and returns a short task_prompt + the subagent to dispatch to. The orchestrator must pass the returned worker_agent and task_prompt to the Task tool verbatim — the only valid subagents are agent-loop-worker (default) and agent-test-worker (auto-selected for MonkeyTest tasks). Specialist personas are injected into the prompt file via persona_id; they are NOT separate subagents.`,
        args: {
          task_key: tool.schema
            .string()
            .describe('The task key to dispatch (e.g. "todo:1")'),
          persona_id: tool.schema
            .string()
            .describe(
              "Optional persona_id from agent_loop_suggest_workers or agent_loop_list_workers. Injects that persona's expertise into the worker prompt file. Always dispatched to agent-loop-worker — do NOT use the persona name as subagent_type."
            )
            .optional(),
          inline_prompt: tool.schema
            .boolean()
            .describe("Debug/compatibility escape hatch. If true, also returns the full worker_prompt inline. Default false.")
            .optional(),
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

          // Resolve optional persona injection. If the orchestrator passes a
          // persona_id, look up the body and inject as a prompt prefix.
          let persona = null as
            | { persona_id: string; persona_name: string; persona_body: string }
            | null;
          if (args.persona_id) {
            const found = await getPersonaBody(args.persona_id);
            if (!found) {
              return JSON.stringify({
                error: `Unknown persona_id: ${args.persona_id}`,
                next_action:
                  "Call agent_loop_suggest_workers to find valid persona_id values, then retry agent_loop_dispatch with one of them (or omit persona_id to use a generic worker).",
              });
            }
            persona = {
              persona_id: found.persona_id,
              persona_name: found.name,
              persona_body: found.body,
            };
          }

          const workerPrompt = buildWorkerPrompt(payload, persona);

          const isAgentTestTask =
            task.title.startsWith("Test Route:") ||
            task.title.startsWith("Review Route:") ||
            task.title === "Generate MonkeyTest Final Report";

          // The OpenCode subagent ID is fixed. Personas are prompt prefixes,
          // never subagent IDs.
          const workerAgent = isAgentTestTask
            ? "agent-test-worker"
            : "agent-loop-worker";

          const promptFile = await writeWorkerPrompt(
            workdir,
            activeLoopId,
            args.task_key,
            workerPrompt
          );
          const taskPrompt = buildTaskPromptFromPromptFile(
            promptFile.relative_path,
            args.task_key,
            taskSession.task_title
          );
          const inlinePrompt =
            args.inline_prompt === true ||
            process.env.AGENT_LOOP_INLINE_WORKER_PROMPTS === "1";

          // Mark task as started
          markTaskStarted(state, args.task_key);
          await writeBoulder(workdir, activeLoopId, state);

          return JSON.stringify({
            action: "dispatch",
            task_key: args.task_key,
            task_title: taskSession.task_title,
            worker_agent: workerAgent,
            persona_id: persona?.persona_id ?? null,
            persona_name: persona?.persona_name ?? null,
            prompt_mode: inlinePrompt ? "inline_and_file" : "file",
            prompt_path: promptFile.relative_path,
            prompt_bytes: workerPrompt.length,
            task_prompt: taskPrompt,
            ...(inlinePrompt ? { worker_prompt: workerPrompt } : {}),
            instructions: isAgentTestTask
              ? `Dispatch via the Task tool with subagent_type="agent-test-worker". Pass task_prompt verbatim as the task prompt. The worker will read prompt_path for the full assignment. After the worker returns, call agent_loop_process_handoff with the worker's full output.`
              : persona
                ? `Dispatch via the Task tool with subagent_type="agent-loop-worker" (NOT the persona name). The persona "${persona.persona_name}" is already written into prompt_path. Pass task_prompt verbatim. After the worker returns, call agent_loop_process_handoff with the worker's full output.`
                : `Dispatch via the Task tool with subagent_type="agent-loop-worker". To inject a specialist persona, call agent_loop_suggest_workers, pick a persona_id, and re-call agent_loop_dispatch with persona_id set. Pass task_prompt verbatim. After the worker returns, call agent_loop_process_handoff with the worker's full output.`,
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_list_workers — List hidden worker personas for orchestrator
      // -------------------------------------------------------------------
      agent_loop_list_workers: tool({
        description:
          "List specialist personas from the vendored catalog. Default output is a lightweight category summary; pass category/search to return a bounded list. To pick a persona for a task, prefer agent_loop_suggest_workers.",
        args: {
          category: tool.schema
            .string()
            .describe("Optional filter (e.g. 'engineering', 'design', 'marketing').")
            .optional(),
          search: tool.schema
            .string()
            .describe("Optional substring matched against persona_id, name, or description (case-insensitive).")
            .optional(),
          limit: tool.schema
            .number()
            .describe("Maximum workers to return. Default 8, max 20 unless include_all=true.")
            .optional(),
          include_all: tool.schema
            .boolean()
            .describe("Expensive escape hatch. If true, returns all matching workers instead of the bounded list.")
            .optional(),
        },
        async execute(args) {
          const catalog = await loadWorkerCatalog(workdir);
          const categories = summarizeWorkerCategories(catalog.workers);

          if (!args.category && !args.search && args.include_all !== true) {
            return JSON.stringify({
              catalog_roots: catalog.roots,
              total: catalog.workers.length,
              returned: 0,
              categories,
              workers: [],
              usage:
                "This default response is intentionally small. Call agent_loop_suggest_workers(task_key) for a task-specific recommendation, or call agent_loop_list_workers with category/search and an optional limit.",
              examples: [
                'agent_loop_suggest_workers({"task_key":"todo:3","top_k":3})',
                'agent_loop_list_workers({"category":"engineering","search":"frontend","limit":5})',
              ],
            });
          }

          let workers = catalog.workers;
          if (args.category) {
            const c = args.category.toLowerCase();
            workers = workers.filter((w) => w.category.toLowerCase() === c);
          }
          if (args.search) {
            workers = rankWorkerCatalog(workers, args.search)
              .filter((w) => w.score > 0)
              .map((w) => w.worker);
          }

          const includeAll = args.include_all === true;
          const limit = includeAll
            ? workers.length
            : normalizeLimit(args.limit, 8, 20);
          const returnedWorkers = workers.slice(0, limit);

          return JSON.stringify({
            catalog_roots: catalog.roots,
            total: catalog.workers.length,
            matched: workers.length,
            returned: returnedWorkers.length,
            limit: includeAll ? null : limit,
            truncated: returnedWorkers.length < workers.length,
            categories,
            usage:
              "Pick a persona_id, then call agent_loop_dispatch(task_key, persona_id). Prefer agent_loop_suggest_workers(task_key) when choosing for a specific task.",
            workers: returnedWorkers.map((w) => ({
              persona_id: w.persona_id,
              name: w.name,
              category: w.category,
              description: w.description,
            })),
          });
        },
      }),

      // -------------------------------------------------------------------
      // agent_loop_suggest_workers — Task-aware bounded persona search
      // -------------------------------------------------------------------
      agent_loop_suggest_workers: tool({
        description:
          "Return a small ranked set of persona candidates for a specific task or intent. This avoids dumping the full persona catalog into the orchestrator context.",
        args: {
          task_key: tool.schema
            .string()
            .describe('Optional active-plan task key (e.g. "todo:3"). If provided, the tool reads task metadata from the active plan.')
            .optional(),
          intent: tool.schema
            .string()
            .describe("Optional free-text intent when no task_key is available.")
            .optional(),
          category: tool.schema
            .string()
            .describe("Optional category filter (e.g. engineering, design, testing).")
            .optional(),
          file_paths: tool.schema
            .array(tool.schema.string())
            .describe("Optional relevant file paths used as routing hints.")
            .optional(),
          top_k: tool.schema
            .number()
            .describe("Number of candidates to return. Default 5, max 10.")
            .optional(),
        },
        async execute(args) {
          const catalog = await loadWorkerCatalog(workdir);
          let task: PlanTask | null = null;
          let taskSource: string | null = null;

          if (args.task_key) {
            if (!activeLoopId) {
              return JSON.stringify({
                error: "task_key was provided but there is no active loop.",
                next_action:
                  "Pass intent/file_paths instead, or call agent_loop_resume first.",
              });
            }
            const state = await readBoulder(workdir, activeLoopId);
            if (!state) {
              return JSON.stringify({ error: "No active loop state." });
            }
            const plan = await parsePlan(state.active_plan);
            task = plan.tasks.find((t) => t.key === args.task_key) ?? null;
            if (!task) {
              return JSON.stringify({
                error: `Task ${args.task_key} not found in active plan.`,
                available: plan.tasks.map((t) => t.key),
              });
            }
            taskSource = `${task.key}: ${task.title}`;
          }

          const filePaths = [
            ...(task?.file_paths ?? []),
            ...((args.file_paths as string[] | undefined) ?? []),
          ];
          const query = [
            args.intent || "",
            task?.title || "",
            task?.description || "",
            task?.acceptance_criteria || "",
            task?.references || "",
            task?.must_not_do || "",
            task?.task_type || "",
            filePaths.join(" "),
          ]
            .filter(Boolean)
            .join("\n");

          if (!query.trim() && !args.category) {
            return JSON.stringify({
              error: "Provide task_key, intent, category, or file_paths.",
            });
          }

          const category = args.category?.trim() || undefined;
          const topK = normalizeLimit(args.top_k, 5, 10);
          const candidates = suggestWorkerCandidates(
            catalog.workers,
            query,
            filePaths,
            category,
            topK
          );

          return JSON.stringify({
            task_key: task?.key ?? null,
            task_title: task?.title ?? null,
            query_source: taskSource || (args.intent ? "intent" : "filters"),
            category: category ?? null,
            total_workers: catalog.workers.length,
            returned: candidates.length,
            usage:
              "Choose one persona_id if it materially improves the task, then call agent_loop_dispatch(task_key, persona_id). If none fit, omit persona_id and use the generic agent-loop-worker.",
            candidates,
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
            .describe("The full output/response from the worker subagent (HANDOFF block preferred, plain result text also accepted)"),
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
              in_progress: inProgressTaskKeys(state),
            });
          }
          // Multi-task: any in-progress task can post a handoff regardless of
          // which one is the "primary" current_task pointer.

          // Parse the handoff from worker output
          const parsed = parseHandoffFromWorkerOutput(args.worker_output);

          const sanitize = (text: string, maxChars: number) =>
            (text || "").trim().slice(0, maxChars);

          const compressedSummary = [
            `Task ${args.task_key}: ${taskSession.task_title}`,
            parsed.what_was_done ? `Done: ${sanitize(parsed.what_was_done, 800)}` : "",
            parsed.key_decisions ? `Decisions: ${sanitize(parsed.key_decisions, 600)}` : "",
            parsed.files_changed ? `Files: ${sanitize(parsed.files_changed, 500)}` : "",
            parsed.test_results ? `Tests: ${sanitize(parsed.test_results, 400)}` : "",
            parsed.final_response ? `Response: ${sanitize(parsed.final_response, 500)}` : "",
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

          // Optimistically mark this task done so the in-progress check below
          // sees the correct count for the rest of the batch.
          markTaskDone(state, args.task_key);

          // Defer the gate while there are siblings still in-flight. Running
          // `pnpm build`/equivalents 6 times concurrently would thrash and
          // produce noisy failures. The last handoff in a batch runs the gate
          // once, gating the whole batch.
          const stillRunning = inProgressTaskKeys(state);
          const deferGate = stillRunning.length > 0;

          if (!args.skip_gate && !deferGate) {
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
            // already marked done above
            state.stats.backpressure_failures = Math.max(
              0,
              (state.stats.backpressure_failures || 0)
            );
          } else {
            state.stats.backpressure_failures =
              (state.stats.backpressure_failures || 0) + 1;
            // Roll back the optimistic done and record the failure.
            markTaskFailed(
              state,
              args.task_key,
              `Backpressure gate failed:\n${formatGateResult(gateResult)}`
            );
          }

          const readyKeys = pickReadyTasks(state);
          const nextKey = readyKeys[0] ?? null;
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
          const stillRunningAfter = inProgressTaskKeys(state);

          const gateState: "passed" | "failed" | "deferred" = deferGate
            ? "deferred"
            : gateResult.passed
              ? "passed"
              : "failed";

          let nextAction: string;
          if (allDone) {
            nextAction = "All tasks complete! Generate a completion report.";
          } else if (halted) {
            nextAction =
              "Loop halted. Review blocked tasks and decide how to proceed.";
          } else if (deferGate) {
            nextAction = `Batch in flight: ${stillRunningAfter.length} sibling task(s) still running (${stillRunningAfter.join(", ")}). Wait for their handoffs; the gate runs once when the last one returns. Do not dispatch new tasks until then unless they are independent of the running batch.`;
          } else if (gateResult.passed) {
            nextAction = readyKeys.length > 1
              ? `${readyKeys.length} tasks are ready in parallel. Call agent_loop_pick_batch then dispatch them concurrently in this turn.`
              : nextKey
                ? `Dispatch next: agent_loop_dispatch("${nextKey}")`
                : "No more tasks.";
          } else {
            const ts = state.task_sessions[args.task_key];
            nextAction = `Gate failed for ${args.task_key}. ${
              ts && ts.attempts < ts.max_attempts
                ? `Retry: agent_loop_dispatch("${args.task_key}")`
                : `Task blocked. Move to next: agent_loop_dispatch("${nextKey || "none"}")`
            }`;
          }

          return JSON.stringify({
            status:
              gateState === "passed"
                ? "done"
                : gateState === "deferred"
                  ? "done_pending_gate"
                  : "gate_failed",
            gate_state: gateState,
            task_key: args.task_key,
            summary: compressedSummary,
            gate: deferGate
              ? null
              : {
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
            gate_details:
              !deferGate && !gateResult.passed
                ? formatGateResult(gateResult)
                : undefined,
            progress: `${doneTasks.length}/${state.stats.total_tasks}`,
            in_progress: stillRunningAfter,
            ready_tasks: readyKeys,
            all_done: allDone,
            halted,
            next_task: nextKey,
            next_task_title: nextKey
              ? state.task_sessions[nextKey]?.task_title
              : null,
            next_action: nextAction,
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
          "Manually pause the Agent Loop. All tasks currently in progress will be reset to pending so resume cannot strand a parallel batch.",
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

          const haltedLoopId = activeLoopId;
          const state = await readBoulder(workdir, haltedLoopId);
          if (!state) {
            return JSON.stringify({ error: "No active loop." });
          }

          const runtime = await readRuntimeState(workdir, haltedLoopId);

          state.status = "paused";
          const resetTasks = inProgressTaskKeys(state);
          for (const taskKey of resetTasks) {
            const t = state.task_sessions[taskKey];
            if (t?.status === "in-progress") {
              t.status = "pending";
            }
          }
          state.current_task = null;
          await writeBoulder(workdir, haltedLoopId, state);
          loopActive = false;
          if (runtime) {
            runtime.active = false;
            runtime.pending_save_progress = false;
            await writeRuntimeState(workdir, haltedLoopId, runtime);
          }

          // Clear active loop pointer
          await clearActiveLoopPointer(workdir);
          if (activeLoopId === haltedLoopId) {
            activeLoopId = null;
          }

          return JSON.stringify({
            status: "paused",
            loop_id: haltedLoopId,
            reason: args.reason || "Manual halt",
            reset_tasks: resetTasks,
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
          "Run the backpressure verification gate and return results.",
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
        args: {
          loop_id: tool.schema
            .string()
            .describe("Specific loop ID to report. Optional; defaults to the active loop, then the most recently completed/halted/failed loop.")
            .optional(),
        },
        async execute(args, context) {
          const loops = await listLoops(workdir);
          const targetLoopId =
            args.loop_id ||
            activeLoopId ||
            lastTerminalLoopId ||
            loops.find((l) => isTerminalLoopStatus(l.status))?.loop_id ||
            null;

          if (!targetLoopId) {
            return JSON.stringify({
              error: "No loop available for completion report.",
              available_loops: loops.map((l) => ({
                loop_id: l.loop_id,
                status: l.status,
                progress: l.progress,
                updated_at: l.updated_at,
              })),
            });
          }

          const state = await readBoulder(workdir, targetLoopId);
          if (!state) {
            return JSON.stringify({
              error: "No loop state found.",
              loop_id: targetLoopId,
              available_loops: loops.map((l) => l.loop_id),
            });
          }

          const learnings = await readNotepad(workdir, targetLoopId, "learnings");
          const decisions = await readNotepad(workdir, targetLoopId, "decisions");
          const issues = await readNotepad(workdir, targetLoopId, "issues");

          const tasks = Object.values(state.task_sessions);
          const done = tasks.filter((t) => t.status === "done");
          const blocked = tasks.filter((t) => t.status === "blocked");
          const totalAttempts = tasks.reduce((s, t) => s + t.attempts, 0);

          const report = [
            `# Agent Loop Completion Report`,
            ``,
            `**Loop ID**: ${targetLoopId}`,
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
            loopInstanceDir(workdir, targetLoopId),
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
    // Backtick-wrapped concrete files (with extension)
    /`([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)`/g,
    // Backtick-wrapped directory paths (multi-segment, no extension required)
    /`([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-./]*)`/g,
    // Bare source file patterns (no backticks)
    /(?:src|lib|app|test|tests|pkg|web|server|client|api|components)\/[a-zA-Z0-9_\-./]+(?:\.[a-zA-Z]+)?/g,
  ];

  const paths = new Set<string>();
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      let p = m[1] || m[0];
      if (!p.includes("/") || p.startsWith("http") || p.startsWith("//")) continue;
      // Normalize trailing slashes so `foo/bar/` and `foo/bar` collide.
      p = p.replace(/\/+$/, "");
      paths.add(p);
    }
  }
  return [...paths];
}

function inferTaskType(text: string): NonNullable<PlanTask["task_type"]> {
  if (/\bspike\b/i.test(text)) return "spike";
  if (/\bverify\b/i.test(text)) return "verify";
  return "impl";
}

function buildTaskPromptFromPromptFile(
  promptPath: string,
  taskKey: string,
  taskTitle: string
): string {
  return [
    `Read \`${promptPath}\` first. It is your full assignment for ${taskKey}: ${taskTitle}.`,
    "Follow that assignment exactly, including its constraints and verification instructions.",
    "Do not ask the orchestrator to paste the prompt body. Use the Read tool on the prompt file.",
    "When finished or blocked, return the required HANDOFF_START ... HANDOFF_END block as your final response.",
  ].join("\n");
}

function normalizeLimit(
  value: unknown,
  fallback: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function summarizeWorkerCategories(workers: WorkerCatalogEntry[]): {
  category: string;
  count: number;
}[] {
  const counts = new Map<string, number>();
  for (const w of workers) {
    counts.set(w.category, (counts.get(w.category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function tokenizeForWorkerSearch(text: string): string[] {
  const tokens =
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set(tokens.map((t) => t.replace(/_/g, "-")))];
}

function inferWorkerRoutingTerms(
  query: string,
  filePaths: string[]
): { terms: string[]; reasons: string[] } {
  const haystack = `${query}\n${filePaths.join("\n")}`.toLowerCase();
  const terms = new Set<string>();
  const reasons: string[] = [];

  const add = (condition: boolean, newTerms: string[], reason: string) => {
    if (!condition) return;
    for (const term of newTerms) terms.add(term);
    reasons.push(reason);
  };

  add(
    /(component|frontend|react|vue|svelte|css|tailwind|ui|ux|page|app\/|web\/|client\/|components\/)/.test(haystack),
    ["frontend", "ui", "design", "react", "component"],
    "UI/frontend file or keyword match"
  );
  add(
    /(api|route|controller|server|backend|service|auth|jwt|oauth|session|middleware)/.test(haystack),
    ["backend", "api", "server", "auth", "security"],
    "API/backend/auth keyword match"
  );
  add(
    /(database|schema|migration|sql|postgres|mysql|sqlite|prisma|drizzle|orm)/.test(haystack),
    ["database", "backend", "data", "schema"],
    "database/schema keyword match"
  );
  add(
    /(test|spec|playwright|cypress|vitest|jest|qa|verify|accessibility|a11y)/.test(haystack),
    ["testing", "qa", "accessibility", "verify"],
    "testing/verification keyword match"
  );
  add(
    /(docker|kubernetes|k8s|deploy|deployment|ci|workflow|github\/workflows|infra|sre|devops)/.test(haystack),
    ["devops", "sre", "infrastructure", "ci"],
    "deployment/CI/infrastructure keyword match"
  );
  add(
    /(readme|docs|documentation|technical writer|markdown|guide)/.test(haystack),
    ["technical", "writer", "documentation", "docs"],
    "documentation keyword match"
  );

  return { terms: [...terms], reasons };
}

function scoreWorker(
  worker: WorkerCatalogEntry,
  terms: string[],
  routingReasons: string[],
  category?: string
): { score: number; why: string[] } {
  const name = worker.name.toLowerCase();
  const description = worker.description.toLowerCase();
  const id = worker.persona_id.toLowerCase();
  const workerCategory = worker.category.toLowerCase();
  const why = new Set<string>();
  let score = 0;

  if (category && workerCategory === category.toLowerCase()) {
    score += 6;
    why.add(`category=${worker.category}`);
  }

  for (const term of terms) {
    if (term.length < 2) continue;
    if (name.includes(term)) {
      score += 5;
      why.add(`name matches "${term}"`);
    } else if (id.includes(term)) {
      score += 4;
      why.add(`persona_id matches "${term}"`);
    } else if (description.includes(term)) {
      score += 3;
      why.add(`description matches "${term}"`);
    } else if (workerCategory.includes(term)) {
      score += 2;
      why.add(`category matches "${term}"`);
    }
  }

  if (score > 0) {
    for (const reason of routingReasons.slice(0, 2)) {
      why.add(reason);
    }
  }

  return { score, why: [...why].slice(0, 4) };
}

function rankWorkerCatalog(
  workers: WorkerCatalogEntry[],
  query: string,
  filePaths: string[] = [],
  category?: string
): { worker: WorkerCatalogEntry; score: number; why: string[] }[] {
  const routing = inferWorkerRoutingTerms(query, filePaths);
  const terms = [
    ...tokenizeForWorkerSearch(query),
    ...routing.terms,
    ...(category ? [category.toLowerCase()] : []),
  ];

  return workers
    .map((worker) => {
      const scored = scoreWorker(worker, terms, routing.reasons, category);
      return { worker, ...scored };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.worker.persona_id.localeCompare(b.worker.persona_id);
    });
}

function suggestWorkerCandidates(
  workers: WorkerCatalogEntry[],
  query: string,
  filePaths: string[],
  category: string | undefined,
  topK: number
): {
  persona_id: string;
  name: string;
  category: string;
  description: string;
  score: number;
  why: string[];
}[] {
  const scoped = category
    ? workers.filter((w) => w.category.toLowerCase() === category.toLowerCase())
    : workers;
  const ranked = rankWorkerCatalog(scoped, query, filePaths, category);
  const positives = ranked.filter((w) => w.score > 0);
  const selected = (positives.length > 0 ? positives : ranked).slice(0, topK);

  return selected.map(({ worker, score, why }) => ({
    persona_id: worker.persona_id,
    name: worker.name,
    category: worker.category,
    description: worker.description,
    score,
    why:
      why.length > 0
        ? why
        : ["fallback candidate; no strong catalog match found"],
  }));
}

export default AgentLoopPlugin;

function computeBoulderHash(state: BoulderState): string {
  const payload = {
    status: state.status,
    iteration: state.iteration,
    current_task: state.current_task,
    in_progress_count: Object.values(state.task_sessions).filter(
      (t) => t.status === "in-progress"
    ).length,
    task_sessions: Object.values(state.task_sessions)
      .map((t) => ({
        key: t.task_key,
        status: t.status,
        attempts: t.attempts,
        completed_at: t.completed_at || null,
        started_at: t.started_at || null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
