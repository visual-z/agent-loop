# Agent Loop Architecture (OpenCode Only)

Version: 2.0  
Date: 2026-03-30  
Status: Implemented Baseline + Runtime Recycle

## Scope

This document describes the implemented Agent Loop plugin in this repository.

- Platform: OpenCode only
- Pattern: Orchestrator delegates all implementation to worker subagents
- State root: `.agent-loop/`
- Primary plugin: `.opencode/plugins/agent-loop/plugin.ts`

## Core Design

Three layers:

1) Plugin Harness (TypeScript event hooks)
- Drives continuation on session idle
- Owns runtime lifecycle controls (session recycle, stall detection)
- Persists harness runtime state in `.agent-loop/loop-state.json`

2) Orchestrator Agent (primary)
- Uses `agent_loop_*` tools only
- Never implements feature code itself
- Dispatches one worker at a time through the Task tool
- Enforced by hard guardrails:
  - agent permissions deny direct mutation tools for orchestrator
  - plugin `tool.execute.before` blocks orchestrator mutation tool calls and non-`agent-loop-worker` task dispatches

3) Worker Subagent (ephemeral)
- Receives only minimal task context
- Implements one task
- Returns structured handoff block (`HANDOFF_START ... HANDOFF_END`)

## Runtime Files

Under `.agent-loop/`:

- `boulder.json` — task graph and loop progress state
- `loop-state.json` — harness runtime control state
- `plans/*.md` — plan/TODO source
- `handoffs/*-handoff.md` — per-task handoff records
- `notepads/{plan}/(learnings|decisions|issues).md` — compressed cross-task memory
- `evidence/` — optional gate evidence

## Tool Surface

Implemented plugin tools:

- `agent_loop_init`
- `agent_loop_resume`
- `agent_loop_dispatch`
- `agent_loop_process_handoff`
- `agent_loop_status`
- `agent_loop_halt`
- `agent_loop_backpressure_gate`
- `agent_loop_update_notepad`
- `agent_loop_completion_report`

## Event Hooks

Implemented hooks:

- `session.created`
  - Rebinds runtime to the newly created session
  - Resets per-session counters (`iteration`, `stall_count`)
  - Clears `pending_save_progress`

- `session.idle`
  - Main continuation driver
  - Validates running state from `boulder.json`
  - Prevents cross-session prompt injection by session binding checks
  - Applies runtime guards before continuation:
    - stall detection by boulder state hash
    - total-iteration hard limit
    - context pressure threshold (90% by default)
  - Injects continuation prompt when safe to continue

- `experimental.session.compacting`
  - Injects compact loop context summary for compaction survival

- `session.error`
  - Marks current task failed
  - Halts loop if halt conditions are met

- `tool.execute.before`
  - Enforces orchestrator behavior at runtime
  - Blocks orchestrator session from direct mutation tools (`bash`, `edit`, `write`, `patch`, `apply_patch`, `multiedit`)
  - Allows task dispatch only to `agent-loop-worker`

## Session Recycle and Context Pressure

Runtime control is persisted in `.agent-loop/loop-state.json`:

```json
{
  "active": true,
  "session_id": "ses_xxx",
  "iteration": 0,
  "max_iterations_per_session": 15,
  "total_iterations": 0,
  "max_total_iterations": 200,
  "started_at": "2026-03-30T00:00:00.000Z",
  "last_continued_at": null,
  "last_state_hash": null,
  "stall_count": 0,
  "stall_threshold": 3,
  "pending_save_progress": false,
  "context_pressure_threshold": 0.9
}
```

Behavior:

- Per-session pressure is approximated as:
  - `iteration / max_iterations_per_session`
- At threshold (`>= 0.9` by default), harness:
  - sets `pending_save_progress = true`
  - deactivates loop in current session
  - injects a "Session Recycle Required" prompt
  - refuses further dispatch in that session
- Resume path:
  - new session created
  - orchestrator calls `agent_loop_resume`
  - runtime counters reset for the new session

Note: token-level context measurement is not currently implemented; iteration-based pressure is the intentional baseline.

## Stall Detection

- Harness computes a SHA-256 hash from a reduced `boulder.json` view:
  - loop status
  - iteration
  - current task
  - sorted task statuses/attempts/completion flags
- If hash does not change across idle cycles, `stall_count` increases.
- At `stall_threshold` (default 3), loop is deactivated to prevent runaway idle injections.

## Handoff and Memory Flow

Worker output must include a structured handoff block.

From handoff, plugin persists:

- handoff markdown file under `handoffs/`
- appended learnings/decisions/issues into notepads
- returns a compressed `summary` field to orchestrator (bounded output) to avoid raw worker-output accumulation in main context

Only compact context is passed forward to next worker:

- previous handoff `Next Task Context`
- notepad summaries (truncated)
- current task description and extracted file references

This keeps orchestrator context narrow while preserving continuity.

## Backpressure Gate

Gate module: `.opencode/plugins/agent-loop/gate.ts`

- Auto-detects project type (node/rust/go/python)
- Runs build and tests as blocking checks
- Runs lint as non-blocking warning check
- On gate failure, task is failed for retry path; after max attempts task becomes blocked

## Current Simplifications

- No Claude Code compatibility layer in this repo
- No parallel worker execution (single-task sequential pipeline)
- No automatic plan generation inside plugin tools (orchestrator creates plan file when needed)

## Operational Contract for Orchestrator

- Always delegate implementation work to `agent-loop-worker`
- Always process worker output via `agent_loop_process_handoff`
- Respect runtime recycle signals:
  - if `agent_loop_status.runtime.pending_save_progress` is true, stop dispatching in current session
  - continue in a fresh session via `agent_loop_resume`

## Key Files

- `.opencode/plugins/agent-loop/plugin.ts`
- `.opencode/plugins/agent-loop/state.ts`
- `.opencode/plugins/agent-loop/prompts.ts`
- `.opencode/plugins/agent-loop/gate.ts`
- `.opencode/commands/agent-loop.md`
- `.opencode/agents/agent-loop-orchestrator.md`
