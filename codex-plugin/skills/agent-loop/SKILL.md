---
name: agent-loop
description: "Run long Codex tasks through a filesystem-backed loop: plan, delegate to subagents, record handoffs, verify, and continue with hooks."
---

# Agent Loop

Use this skill when the user asks for `$agent-loop`, `@agent-loop`, long-running task orchestration, resumable work, subagent-first execution, or filesystem-backed task state.

Agent Loop is a method, not a hidden tool runtime. Keep the parent thread focused on planning, dispatch, validation, and state updates. Send implementation work to subagents whenever the task is large enough to benefit from isolation.

## Core Rules

- Store state in `.agent-loop/codex/`; do not rely on chat history as the source of truth.
- Prefer subagents for implementation tasks. Each worker gets exactly one task and returns one handoff.
- The parent thread may inspect, plan, dispatch, validate, update state, and summarize. It should not implement task work unless the task is tiny or the user asks for inline work.
- Continue active loops through the Stop hook only while `continue_on_stop: true`, `awaiting_user: false`, and real work remains.
- Mark a loop complete only after a completion audit maps the objective and every task to concrete evidence.

## Commands

Treat these as user-facing modes:

- `$agent-loop plan <objective>`: create a new loop plan and state.
- `$agent-loop run [plan-path]`: initialize or continue execution.
- `$agent-loop resume`: recover from `.agent-loop/codex/active-loop.json`.
- `$agent-loop report`: summarize final state, handoffs, validation, and open issues.
- `$agent-loop halt`: set the active loop to paused and stop hook continuation.

## State Layout

Read `references/loop-state.md` before creating or updating loop state.

Minimum layout:

```text
.agent-loop/codex/
  active-loop.json
  loops/<loop_id>/
    state.json
    plan.md
    handoffs/
    evidence/
    notes.md
```

`state.json` is the control plane. Update it after planning, dispatching, processing handoffs, validation, pauses, and completion.

## Planning

Read `references/plan-format.md` before writing a plan.

Plans should be short and executable:

- 3-12 tasks.
- Each task has a key, title, type, dependencies, likely files, validation, acceptance criteria, and a clear done condition.
- Include parallel hints only when tasks are genuinely independent.
- Ask the user when a decision would materially change the plan.

## Execution Loop

1. Read active loop state and plan.
2. Process any new worker handoffs in `handoffs/`; update task status and notes.
3. If validation is needed, run the repo-appropriate check before dispatching more dependent work.
4. Select the smallest safe ready batch. Avoid parallel tasks that touch the same files, shared schema, lockfiles, generated code, or CI config.
5. Spawn one subagent per selected task. Give each worker only its task prompt, relevant context, files, validation, and the handoff contract.
6. When workers return, save handoffs, update `state.json`, and run validation.
7. If more work remains and no user input is needed, keep `continue_on_stop: true` so the Stop hook can nudge the next turn.

Read `references/worker-handoff.md` before dispatching workers.

## Completion Audit

Before setting `status: "completed"`:

- Restate the objective as concrete deliverables.
- Map every explicit requirement, task, validation command, and deliverable to evidence.
- Inspect current files, handoffs, command output, screenshots, PR state, or other artifacts.
- Treat uncertainty as incomplete.
- Set `continue_on_stop: false` after completion.

## Stop Conditions

Set `awaiting_user: true` and stop when:

- A product/scope decision is required.
- All ready work is blocked.
- Validation fails and the fix is unclear.
- The next action would be destructive or outside the user's request.
- The loop is complete.

Do not hide limitations: Codex plugin hooks provide continuation nudges, not a full autonomous background runtime.
