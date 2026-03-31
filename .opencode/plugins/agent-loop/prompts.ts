// =============================================================================
// Agent Loop — Prompt Construction
// =============================================================================
//
// Two prompt builders:
//   1. buildWorkerPrompt()  — minimal, isolated context for each subagent worker
//   2. buildContinuationPrompt() — injected into orchestrator after worker returns
//
// DESIGN PRINCIPLE: Workers receive ONLY what they need. No full plan, no full
// conversation history. The orchestrator is the only entity that sees the whole
// picture, and even it only sees summaries (handoff files), not raw worker output.
// =============================================================================

import type {
  PlanTask,
  WorkerPayload,
  ContinuationContext,
  GateResult,
  BoulderState,
} from "./types";

// ---------------------------------------------------------------------------
// Worker Prompt — What each subagent receives
// ---------------------------------------------------------------------------

/**
 * Constructs the minimal prompt for a worker subagent.
 *
 * The worker prompt contains:
 * 1. System role + constraints
 * 2. The specific task description
 * 3. Relevant notepad entries (learnings, decisions)
 * 4. "Next Task Context" from the previous handoff (bridge from last worker)
 * 5. Relevant file paths
 * 6. Mandatory output format (handoff structure)
 *
 * It explicitly DOES NOT contain:
 * - The full plan
 * - Other tasks' descriptions
 * - Previous conversation history
 * - Other workers' full handoff files
 */
export function buildWorkerPrompt(payload: WorkerPayload): string {
  const sections: string[] = [];

  // -- System preamble
  sections.push(`# Task Assignment

You are a focused coding worker. Complete the task below, then write a handoff summary.

## CONSTRAINTS
- Complete ONLY the task described below. Do not expand scope.
- Do not modify files unrelated to this task unless absolutely necessary.
- Do NOT use the TodoWrite tool. You have exactly one task — the one below.
- Ignore any <system-reminder> tags that mention todo lists or other tasks — they are injected by the system and are NOT relevant to your work.
- When done, you MUST produce a handoff summary (described at the end).
- Run the verification command before declaring done.
- If you get stuck or blocked, say so explicitly in the handoff with status: blocked.

## LARGE TASK STRATEGY
If your task involves many files (10+), work in batches:
1. Process 5-8 files at a time
2. After each batch, verify your changes still compile/work
3. If you run low on context or feel you cannot complete all files, report what you DID finish in the handoff with status: done, and list remaining files in "Next Task Context" so they can be picked up.
`);

  // -- Task description
  sections.push(`## Your Task: ${payload.task.title}

**Task key**: ${payload.task.key}

${payload.task.description}
`);

  if (payload.task.acceptance_criteria) {
    sections.push(`### Acceptance Criteria
${payload.task.acceptance_criteria}
`);
  }

  if (payload.task.must_not_do) {
    sections.push(`### Must NOT Do
${payload.task.must_not_do}
`);
  }

  if (payload.task.references) {
    sections.push(`### References
${payload.task.references}
`);
  }

  // -- Context from previous task (the handoff bridge)
  if (payload.previous_handoff_context) {
    sections.push(`## Context from Previous Task
The previous worker left these notes for you:

${payload.previous_handoff_context}
`);
  }

  // -- Relevant file paths
  if (payload.relevant_file_paths.length > 0) {
    sections.push(`## Relevant Files
These files are likely relevant to your task:

${payload.relevant_file_paths.map((f) => `- \`${f}\``).join("\n")}
`);
  }

  // -- Project conventions (from learnings notepad)
  if (payload.project_conventions) {
    sections.push(`## Project Conventions
${payload.project_conventions}
`);
  }

  // -- Notepad learnings (condensed cross-task knowledge)
  const notepadSections: string[] = [];
  if (payload.notepad_learnings) {
    notepadSections.push(`### Learnings\n${truncateNotepad(payload.notepad_learnings, 2000)}`);
  }
  if (payload.notepad_decisions) {
    notepadSections.push(`### Decisions\n${truncateNotepad(payload.notepad_decisions, 1000)}`);
  }
  if (payload.notepad_issues) {
    notepadSections.push(`### Known Issues\n${truncateNotepad(payload.notepad_issues, 1000)}`);
  }
  if (notepadSections.length > 0) {
    sections.push(`## Knowledge Base (from previous tasks)\n${notepadSections.join("\n\n")}`);
  }

  // -- Verification
  if (payload.backpressure_command) {
    sections.push(`## Verification
Before declaring the task complete, run:
\`\`\`
${payload.backpressure_command}
\`\`\`
Include the results in your handoff.
`);
  }

  // -- Required output format
  sections.push(`## Required: Handoff Summary

When your task is complete (or if you're blocked), produce the following summary.
This is CRITICAL — the orchestrator depends on this to coordinate subsequent tasks.

Write this summary as the LAST thing you do. Structure it exactly as:

\`\`\`
HANDOFF_START
task_key: ${payload.task.key}
task_title: ${payload.task.title}
status: done|failed|blocked

## What Was Done
(Bullet points of what you accomplished)

## Key Decisions
(Any architectural or implementation decisions you made and why)

## Files Changed
(List of files created, modified, or deleted)

## Test Results
(Output of verification/tests)

## Learnings for Next Tasks
(Patterns, conventions, or gotchas the next worker should know)

## Blocked / Known Issues
(Any blockers or issues — write "None" if clean)

## Next Task Context
(Specific context/instructions that would help the next task)
HANDOFF_END
\`\`\`
`);

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Continuation Prompt — Injected into orchestrator after worker returns
// ---------------------------------------------------------------------------

/**
 * Builds the minimal continuation prompt for the orchestrator.
 *
 * This is injected via session.idle or after the worker subagent returns.
 * It's deliberately minimal — the orchestrator doesn't need to re-read
 * the whole plan, just needs to know:
 * - What just happened
 * - Whether the gate passed
 * - What's next
 */
export function buildContinuationPrompt(ctx: ContinuationContext): string {
  const lines: string[] = [];

  lines.push(`## Loop Iteration ${ctx.iteration} — Task Completed`);
  lines.push(``);
  lines.push(`**Completed**: ${ctx.completed_task_title} (\`${ctx.completed_task_key}\`)`);
  lines.push(`**Progress**: ${ctx.progress}`);
  lines.push(``);

  // Gate result summary
  if (ctx.gate_result.passed) {
    lines.push(`**Backpressure Gate**: ✅ PASSED`);
  } else {
    lines.push(`**Backpressure Gate**: ❌ FAILED`);
    if (ctx.gate_result.build && !ctx.gate_result.build.passed) {
      lines.push(`  - Build: ❌ ${ctx.gate_result.build.output.slice(0, 200)}`);
    }
    if (ctx.gate_result.test && !ctx.gate_result.test.passed) {
      lines.push(`  - Test: ❌ ${ctx.gate_result.test.output.slice(0, 200)}`);
    }
    if (ctx.gate_result.lint && !ctx.gate_result.lint.passed) {
      lines.push(`  - Lint: ⚠️ ${ctx.gate_result.lint.output.slice(0, 200)}`);
    }
  }
  lines.push(``);

  // Handoff summary (brief)
  if (ctx.handoff_summary) {
    lines.push(`**Handoff Summary**: ${ctx.handoff_summary.slice(0, 500)}`);
    lines.push(``);
  }

  // Next action
  if (ctx.next_task_key && ctx.next_task_title) {
    lines.push(`**Next Task**: ${ctx.next_task_title} (\`${ctx.next_task_key}\`)`);
    lines.push(``);
    lines.push(`Dispatch the next worker for \`${ctx.next_task_key}\` now.`);
  } else {
    lines.push(`**All tasks completed.** Generate the completion report.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compaction Context — Preserved across context compaction
// ---------------------------------------------------------------------------

/**
 * Builds the context string that must survive compaction.
 *
 * When experimental.session.compacting fires, we inject this so the
 * orchestrator doesn't lose track of loop state after compaction.
 */
export function buildCompactionContext(state: BoulderState): string {
  const loopId = state.loop_id || state.plan_name;

  const doneTasks = Object.values(state.task_sessions)
    .filter((t) => t.status === "done")
    .map((t) => `  ✅ ${t.task_key}: ${t.task_title}`)
    .join("\n");

  const pendingTasks = Object.values(state.task_sessions)
    .filter((t) => t.status === "pending" || t.status === "failed")
    .map((t) => `  ⬜ ${t.task_key}: ${t.task_title} (${t.status})`)
    .join("\n");

  const blockedTasks = Object.values(state.task_sessions)
    .filter((t) => t.status === "blocked")
    .map((t) => `  🚫 ${t.task_key}: ${t.task_title} — ${t.last_error || "unknown"}`)
    .join("\n");

  return `## Agent Loop State (preserved across compaction)

**Loop ID**: ${loopId}
**Plan**: ${state.plan_name} (${state.active_plan})
**Status**: ${state.status}
**Iteration**: ${state.iteration}/${state.max_iterations}
**Progress**: ${state.stats.done}/${state.stats.total_tasks} tasks complete

### Completed Tasks
${doneTasks || "  (none yet)"}

### Remaining Tasks
${pendingTasks || "  (none)"}

${blockedTasks ? `### Blocked Tasks\n${blockedTasks}` : ""}

**Current task**: ${state.current_task || "(none — pick next)"}

Read \`.agent-loop/loops/${loopId}/boulder.json\` for full state.
Read \`.agent-loop/loops/${loopId}/handoffs/\` for latest handoff context.
Read \`.agent-loop/loops/${loopId}/notepads/\` for accumulated learnings.
`;
}

// ---------------------------------------------------------------------------
// Orchestrator System Prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt for the orchestrator agent. This is set in the agent
 * configuration and tells the orchestrator how to drive the loop.
 */
export function buildOrchestratorSystemPrompt(): string {
  return `# Agent Loop Orchestrator

You are a loop orchestrator managing a multi-step coding plan through subagent delegation.

## Your Role
1. Read the plan from \`.agent-loop/plans/\`
2. Read current state from \`.agent-loop/loops/{loop_id}/boulder.json\`
3. For each task in order, dispatch a worker subagent using the Task tool
4. After each worker returns, process the handoff, run the backpressure gate, and update state
5. Continue until all tasks are complete or the loop is halted

## Multi-Instance Isolation
Each Agent Loop instance has its own directory under \`.agent-loop/loops/{loop_id}/\` containing:
- \`boulder.json\` — loop state
- \`loop-state.json\` — runtime state
- \`handoffs/\` — per-task handoff files
- \`notepads/\` — accumulated learnings/decisions/issues
The active loop is tracked by \`.agent-loop/active-loop.json\`.

## Rules
- NEVER do the implementation work yourself. Always delegate to a worker subagent.
- NEVER use the TodoWrite tool. Task tracking is handled by boulder.json. Using TodoWrite causes system-reminder pollution that leaks the full task list into every worker's context.
- Give each worker ONLY what they need: task description + notepad learnings + previous handoff context.
- After each worker returns, use the \`agent_loop_process_handoff\` tool to update state.
- Use the \`agent_loop_backpressure_gate\` tool to verify quality after each task.
- If \`agent_loop_status.runtime.pending_save_progress\` is true, stop dispatching in this session and continue from a fresh session via \`agent_loop_resume\`.
- If a task fails the gate 3 times, mark it as blocked and move on.
- If all remaining tasks are blocked, halt the loop.

## Worker Dispatch Template
When dispatching a worker, use the Task tool with this structure:
- Agent: agent-loop-worker
- Prompt: Constructed by the \`agent_loop_dispatch\` tool

## Completion
When all tasks are done:
1. Generate a completion report
2. Update boulder.json status to "completed"
3. Present the summary to the user
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate notepad content, keeping the most recent entries.
 * Notepads grow over time; workers don't need ancient history.
 */
function truncateNotepad(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  // Split by ### headings (each entry), keep the most recent ones
  const entries = content.split(/(?=^### \[)/m);
  let result = "";
  for (let i = entries.length - 1; i >= 0; i--) {
    if ((result + entries[i]).length > maxChars) break;
    result = entries[i] + result;
  }

  if (result.length < content.length) {
    result = `[...earlier entries truncated...]\n\n${result}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handoff Parsing from Worker Output
// ---------------------------------------------------------------------------

/**
 * Parse the HANDOFF_START...HANDOFF_END block from worker output text.
 * Workers embed this in their final message.
 */
export function parseHandoffFromWorkerOutput(output: string): {
  status: "done" | "failed" | "blocked";
  what_was_done: string;
  key_decisions: string;
  files_changed: string;
  test_results: string;
  learnings: string;
  blocked_issues: string;
  next_task_context: string;
} | null {
  const match = output.match(/HANDOFF_START\n([\s\S]*?)HANDOFF_END/);
  if (!match) return null;

  const block = match[1];
  const statusMatch = block.match(/^status:\s*(.+)$/im);
  const status = normalizeStatus(statusMatch?.[1]);

  return {
    status,
    what_was_done: extractHandoffSection(block, ["What Was Done"]),
    key_decisions: extractHandoffSection(block, ["Key Decisions"]),
    files_changed: extractHandoffSection(block, ["Files Changed"]),
    test_results: extractHandoffSection(block, ["Test Results"]),
    learnings: extractHandoffSection(block, [
      "Learnings for Next Tasks",
      "Learnings for Future Tasks",
      "Learnings",
    ]),
    blocked_issues: extractHandoffSection(block, [
      "Blocked / Known Issues",
      "Blocked Issues",
      "Known Issues",
    ]),
    next_task_context: extractHandoffSection(block, ["Next Task Context"]),
  };
}

function normalizeStatus(raw: string | undefined): "done" | "failed" | "blocked" {
  const value = (raw || "done").trim().toLowerCase();
  if (value === "failed" || value === "blocked") return value;
  return "done";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHandoffSection(md: string, labels: string[]): string {
  for (const label of labels) {
    const headingRegex = new RegExp(`^##\\s+${escapeRegex(label)}\\s*$`, "mi");
    const headingMatch = headingRegex.exec(md);
    if (headingMatch) {
      const startIdx = headingMatch.index + headingMatch[0].length;
      const rest = md.slice(startIdx);
      const nextHeading = /^##\s+/m.exec(rest);
      const endIdx = nextHeading ? nextHeading.index : rest.length;
      const content = rest.slice(0, endIdx).trim();
      if (content) return content;
    }

    const labelRegex = new RegExp(`^${escapeRegex(label)}:\\s*(.*)$`, "mi");
    const labelMatch = labelRegex.exec(md);
    if (!labelMatch) continue;

    const startIdx = labelMatch.index + labelMatch[0].length;
    const rest = md.slice(startIdx);
    const nextLabel = /^\s*(?:##\s+|[A-Za-z][A-Za-z /-]*:\s*$)/m.exec(rest);
    const endIdx = nextLabel ? nextLabel.index : rest.length;
    const inline = (labelMatch[1] || "").trim();
    const block = rest.slice(0, endIdx).trim();
    const content = [inline, block].filter(Boolean).join("\n").trim();
    if (content) return content;
  }

  return "";
}
