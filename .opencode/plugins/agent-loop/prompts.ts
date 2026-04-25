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

export interface PersonaInjection {
  persona_id: string;
  persona_name: string;
  persona_body: string;
}

/**
 * Constructs the minimal prompt for a worker subagent.
 *
 * The worker prompt contains:
 * 0. (Optional) Persona prefix — agency-agent body injected as the worker's
 *    expert identity. The worker is always dispatched to `agent-loop-worker`;
 *    the persona changes only the prompt, not the OpenCode subagent ID.
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
export function buildWorkerPrompt(
  payload: WorkerPayload,
  persona?: PersonaInjection | null
): string {
  const sections: string[] = [];
  const isAgentTestTask =
    payload.task.title.startsWith("Test Route:") ||
    payload.task.title.startsWith("Review Route:") ||
    payload.task.title === "Generate MonkeyTest Final Report";

  // -- Persona prefix (only when explicitly requested by the orchestrator)
  if (persona && persona.persona_body.trim()) {
    sections.push(`# Persona: ${persona.persona_name}

(persona_id: \`${persona.persona_id}\`)

You are operating in the persona below for THIS task only. Use its expertise,
tone, and standards while still obeying the task constraints in the next
section. The handoff format requirements at the end are non-negotiable.

---
${persona.persona_body.trim()}
---
`);
  }

  // -- System preamble
  sections.push(`# Task Assignment

Complete the task below, then write a handoff summary.

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
2. After each batch, verify your changes still work for this task
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

  if (isAgentTestTask) {
    sections.push(`## Agent Test Execution Rules
- You are executing this task as \`agent-test-worker\`.
- You MUST update \`.monkey-test-state.json\` yourself before returning.
- The orchestrator will NOT edit or write the MonkeyTest state file for you.
- For \`Test Route:\` tasks, default to \`agent-browser\` for browser automation.
- Only fall back to another built-in browser automation tool if \`agent-browser\` is genuinely unavailable.
- Do NOT create ad hoc Playwright, Puppeteer, or Selenium scripts unless the task explicitly requires it.
- Do NOT install browser frameworks or browser binaries unless the task explicitly requires it.
- For \`Review Route:\` tasks, do not open a browser; use screenshots and the route report.
- For \`Generate MonkeyTest Final Report\`, aggregate existing MonkeyTest outputs and update final state.
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

## Files Changed (Optional)
(List of files created, modified, or deleted. Write "None" if no file changes.)

## Test Results
(Output of verification, if any)

## Final Response (Optional)
(If this task is message-only, write the exact user-facing result here.)

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
// Plan Architect Prompt — dispatched to agent-loop-plan-architect subagent
// ---------------------------------------------------------------------------

export interface PlanArchitectPayload {
  plan_path: string;
  plan_name: string;
  objective: string;
  revision: number;
  prior_plan_content: string; // empty on revision 1
  accumulated_feedback: string; // empty on revision 1
  accumulated_clarifications: string; // empty until first CLARIFY_REQUEST round
}

/**
 * Builds the prompt for the plan-architect subagent.
 *
 * On revision 1 it asks for a fresh multi-perspective decomposition.
 * On revision ≥2 it must address prior feedback and bump the revision number.
 */
export function buildPlanArchitectPrompt(p: PlanArchitectPayload): string {
  const isRevision = p.revision > 1;
  const sections: string[] = [];

  sections.push(`# Plan Authoring Assignment

You are the plan-architect. Produce ${isRevision ? "REVISION " + p.revision : "the initial draft"} of the plan file at:

  \`${p.plan_path}\`

This file will be reviewed by the human user before any execution starts. They WILL read it. Make it good.

## Objective
${p.objective}

## Ask First, Write Second — Clarification Protocol

Before writing the plan, identify EVERY load-bearing decision you cannot make confidently from the objective alone. Typical examples:

- Scope boundaries: which modules / surfaces are in vs out?
- Tech-stack selection: ORM? testing framework? CI runner? — only the user knows what's already in the repo if you can't tell.
- Performance / SLO targets: "fast" is ambiguous; ask for concrete numbers when load matters.
- UX preferences: dark mode? mobile-first? a11y target? — never guess.
- Risk tolerance: is downtime / migration acceptable? are public-API breaking changes ok?
- Acceptance bar: how tested? how documented? what does "done" look like?

Rule: **if more than ~30% of your TODOs would change depending on an unknown answer, you MUST ask first**.

How to ask, in order of preference:

**1. PREFERRED — call the \`question\` tool directly**. The runtime permits this. The user sees a structured multiple-choice UI and answers come back to YOU in this same dispatch.

### Required argument schema (EXACT field names — get this wrong and the tool throws SchemaError)

The tool takes a single argument \`questions\` — an array. Each entry MUST have these fields:

| field | type | required | rule |
|---|---|---|---|
| \`question\` | string | **YES** | The actual question text. **The key MUST be literally \`question\`** — not \`text\`/\`prompt\`/\`title\`. Dropping this is the #1 schema error. |
| \`header\` | string | **YES** | Short label, MAX 30 chars. |
| \`options\` | array | **YES** | Each option \`{ label, description }\`. |
| \`options[].label\` | string | **YES** | 1–5 word display text. |
| \`options[].description\` | string | **YES** | One-sentence explanation. |

### Exact call shape (JSON)

\`\`\`json
{
  "questions": [
    {
      "question": "Which IDP do you want new-api to authenticate against?",
      "header": "SSO direction",
      "options": [
        { "label": "Org IDP (Casdoor / Keycloak / Okta / Azure AD)", "description": "Configure new-api as OIDC Relying Party against your IdP." },
        { "label": "lobsterpool SP-style SSO", "description": "Reuse lobsterpool's session for new-api." },
        { "label": "Add SAML / CAS protocol", "description": "Extend new-api to a protocol it doesn't speak." },
        { "label": "Other", "description": "I'll describe my scenario." }
      ]
    },
    {
      "question": "Deployment environment?",
      "header": "Target",
      "options": [
        { "label": "Production", "description": "Plan must respect prod constraints." },
        { "label": "Local dev", "description": "Free to iterate." }
      ]
    }
  ]
}
\`\`\`

Rules:
- Up to 5 questions per call. All in one \`questions\` array.
- Always include an \`Other\` / \`Custom\` option for free-text fallback.
- Do NOT echo the questions as markdown after invoking — the tool itself surfaces them.
- After receiving answers, fold them into your reasoning and proceed (write the plan or ask follow-ups).

### Common schema mistakes

- ❌ \`text:\` / \`prompt:\` / \`title:\` instead of \`question:\`. The key MUST be \`question\`.
- ❌ \`header\` longer than 30 chars.
- ❌ Missing \`description\` on an option.
- ❌ Wrapping in an extra \`{ params: {...} }\` layer.

### On schema error — RETRY

If the tool returns \`Missing key at ["questions"][N]["question"]\`, you wrote the wrong field. Look at the path, fix the JSON, call again. NEVER fall back to printing markdown — fix and retry up to 3 times, then drop to \`CLARIFY_REQUEST\` if all retries fail.

**2. FALLBACK — emit a \`CLARIFY_REQUEST\` block**. Use this only when you need answers persisted to disk for cross-session continuity (rare). Format:

\`\`\`
CLARIFY_REQUEST
plan_path: ${p.plan_path}
revision: ${p.revision}

## Why I cannot write the plan yet
(2–3 sentences)

## Questions
1. <question, single concrete decision>
2. <question, single concrete decision>
   ...

(Cap at 5. Multiple-choice phrasing. No yes/no taste questions.)
\`\`\`

Do NOT write the plan file in the same response as a \`CLARIFY_REQUEST\`. Pick ONE: \`question\` tool, \`CLARIFY_REQUEST\` block, or \`PLAN_WRITTEN\`.

When clarifications are already provided in this prompt (see "Accumulated Clarifications" below), you must NOT re-ask the same question — the user already answered it.

## Required Reasoning Discipline
Do all four phases internally before writing:
1. Initial Understanding — restate the objective, list assumptions, list unknowns.
2. Multi-Perspective Exploration — three substantively different decompositions:
   - fastest-delivery
   - risk-reduction-first
   - architectural-cleanliness-first
   Each MUST diverge in ordering and cut points, not just wording.
3. Critic Review — fresh-eyes comparison; you may synthesize across the three rather than picking one.
4. Final Plan — emit the chosen decomposition as TODOs.

Surface 2–6 sentences from each phase under \`## Plan Rationale\`.

## File Format
Write exactly one file at the path above. Frontmatter:
\`\`\`
---
plan_name: ${p.plan_name}
revision: ${p.revision}
created_at: "<ISO timestamp>"
---
\`\`\`
Do NOT include \`approved_at\` — the runtime owns that field.

Sections in order: TL;DR, Context, Work Objectives, Plan Rationale, Verification Strategy, TODOs.

TODO formatting (REQUIRED):
\`\`\`
- [ ] N. Title

  **Task Type**: spike | impl | verify   (one word)
  **Acceptance Criteria**: ...
  **Must NOT do**: ...
  **References**: ...
  **Depends on**: todo:K   (omit if none)
  **Parallel Group**: optional name like "table-impls" — co-tagged TODOs are explicitly safe to run concurrently
  free-form description...
\`\`\`

Constraints:
- 3–12 TODOs.
- Each TODO is doable by ONE worker in one dispatch (≤ ~20 minutes).
- Acceptance criteria must be observable, not aspirational.
- Use \`todo:N\` keys in dependencies, never titles.
- Use **spike** for upfront research/analysis tasks that produce a shared note used by later tasks. Use **impl** for actual changes. Use **verify** for final acceptance.
- When several TODOs share a common dependency and touch independent files, give them the SAME \`Parallel Group\` so the orchestrator dispatches them concurrently. The runtime's gate is deferred across the batch — don't worry about \`pnpm build\` thrashing.
- Bias the design toward fan-out: a single upfront spike followed by a wide parallel impl batch is preferable to a long serial chain when the impls are independent.
`);

  if (isRevision) {
    sections.push(`## Prior Plan (revision ${p.revision - 1})

You MUST read and replace this. Output the FULL revised plan, do not produce a diff.

\`\`\`markdown
${p.prior_plan_content.trim() || "(missing prior plan)"}
\`\`\`

## Accumulated User Feedback
Address every point. Add a \`## Revision Notes\` section listing each feedback item and your response.

${p.accumulated_feedback.trim() || "(no feedback recorded)"}
`);
  }

  if (p.accumulated_clarifications.trim()) {
    sections.push(`## Accumulated Clarifications (already answered by user)

These Q/A pairs are settled. Do NOT re-ask. Bake the answers into the plan and reference the relevant decisions in \`## Plan Rationale\`.

${p.accumulated_clarifications.trim()}
`);
  }

  sections.push(`## Final Output Contract

Choose ONE final mode:

**Path A — call the \`question\` tool now**: invoke the tool with \`{"questions":[...]}\` mid-dispatch. Answers come back to YOU in this same task; continue reasoning and either write the plan (Path C) or ask more questions. This is preferred for short interactive interviews.

**Path B — emit \`CLARIFY_REQUEST\`**: end the dispatch with a \`CLARIFY_REQUEST\` block. Used when answers must be persisted across sessions or you want them recorded into \`{plan_name}.clarifications.md\` for later revisions.

**Path C — write the plan and emit \`PLAN_WRITTEN\`**: write the plan file then return ONLY this short message as your final response (no extra prose):

\`\`\`
PLAN_WRITTEN
path: ${p.plan_path}
revision: ${p.revision}
todo_count: <N>
\`\`\`

Pick exactly one terminal mode per dispatch. Path A may loop through multiple \`question\` tool calls before transitioning to Path C.

The orchestrator handles each terminal:
- Path C → orchestrator calls \`agent_loop_init\` (auto-approve by default).
- Path B → orchestrator surfaces questions to user via the \`question\` tool and calls \`agent_loop_record_clarifications\`.
- Path A → no orchestrator action needed; you handled it inline.

Revision does NOT bump for \`question\` / CLARIFY rounds — only when the user explicitly edits/regenerates an existing draft.
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

  const ready = ctx.ready_tasks ?? [];
  const inFlight = ctx.in_progress_tasks ?? [];

  if (inFlight.length > 0) {
    lines.push(`**In-Flight (${inFlight.length})**:`);
    for (const t of inFlight) lines.push(`  - \`${t.task_key}\`: ${t.task_title}`);
    lines.push(``);
  }

  if (ready.length > 1) {
    lines.push(`**Ready to dispatch in PARALLEL (${ready.length})**:`);
    for (const t of ready) lines.push(`  - \`${t.task_key}\`: ${t.task_title}`);
    lines.push(``);
    lines.push(
      `Call \`agent_loop_pick_batch\`, then dispatch ALL ready tasks IN THE SAME TURN by issuing one Task tool call per task in a single response. After every worker has returned, process each handoff in order.`
    );
  } else if (ctx.next_task_key && ctx.next_task_title) {
    lines.push(`**Next Task**: ${ctx.next_task_title} (\`${ctx.next_task_key}\`)`);
    lines.push(``);
    lines.push(`Dispatch the next worker for \`${ctx.next_task_key}\` now.`);
  } else if (inFlight.length > 0) {
    lines.push(
      `Nothing new is ready. ${inFlight.length} worker(s) still in flight; wait for their handoffs.`
    );
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

You are a loop orchestrator managing a multi-step plan through subagent delegation.

## Your Role
1. Read the plan from \`.agent-loop/plans/\`
2. Read current state from \`.agent-loop/loops/{loop_id}/boulder.json\`
3. Discover task-specific worker personas with \`agent_loop_suggest_workers\` when needed
4. For each task in order, dispatch a worker subagent using the Task tool
5. After each worker returns, process the handoff, run the backpressure gate, and update state
6. Continue until all tasks are complete or the loop is halted

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
- Use \`agent_loop_suggest_workers\` to get a small task-specific persona shortlist. Use \`agent_loop_list_workers(category|search)\` only for manual browsing; its default response is intentionally summarized.
- After each worker returns, use the \`agent_loop_process_handoff\` tool to update state.
- Use the \`agent_loop_backpressure_gate\` tool to verify quality after each task.
- If \`agent_loop_status.runtime.pending_save_progress\` is true, stop dispatching in this session and continue from a fresh session via \`agent_loop_resume\`.
- If a task fails the gate 3 times, mark it as blocked and move on.
- If all remaining tasks are blocked, halt the loop.

## Worker Dispatch Template
When dispatching a worker, use the Task tool with this structure:
- Agent: choose the most appropriate available worker subagent for the task
- Prompt: Constructed by the \`agent_loop_dispatch\` tool
- The dispatch tool returns \`task_prompt\`, not the full worker prompt by default. Pass \`task_prompt\` verbatim to the Task tool; the worker reads the full assignment from \`prompt_path\`.

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
  final_response: string;
  blocked_issues: string;
  next_task_context: string;
} {
  const match = output.match(/HANDOFF_START\n([\s\S]*?)HANDOFF_END/);
  const block = match ? match[1] : output;
  const statusMatch = block.match(/^status:\s*(.+)$/im);
  const status = normalizeStatus(statusMatch?.[1], output);

  const finalResponse =
    extractHandoffSection(block, [
      "Final Response",
      "User-Facing Result",
      "User Response",
      "Result",
    ]) ||
    (!match ? output.trim().slice(0, 4000) : "");

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
    final_response: finalResponse,
    blocked_issues: extractHandoffSection(block, [
      "Blocked / Known Issues",
      "Blocked Issues",
      "Known Issues",
    ]),
    next_task_context: extractHandoffSection(block, ["Next Task Context"]),
  };
}

function normalizeStatus(
  raw: string | undefined,
  sourceText = ""
): "done" | "failed" | "blocked" {
  const value = (raw || "").trim().toLowerCase();
  if (value === "failed" || value === "blocked") return value;

  const text = sourceText.toLowerCase();
  if (/\bstatus\s*:\s*blocked\b/.test(text)) return "blocked";
  if (/\bstatus\s*:\s*failed\b/.test(text)) return "failed";
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
