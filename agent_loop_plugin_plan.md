# Agent Loop Plugin Plan (Aligned)

Status: active implementation plan aligned with current code.

## Objectives

1. Keep orchestrator context lean and stable for long task pipelines.
2. Enforce strict delegation: orchestrator coordinates, workers implement.
3. Persist loop progress on disk so sessions can be resumed safely.
4. Add practical session recycle controls before context collapse.

## Implemented

- Minimal plugin surface consolidated under `.opencode/plugins/agent-loop/`.
- Redundant prototype modules removed.
- Worker handoff protocol implemented and parsed.
- Notepad system (`learnings`, `decisions`, `issues`) integrated.
- Backpressure gate integrated into `agent_loop_process_handoff`.
- Runtime harness state added via `.agent-loop/loop-state.json`.
- Idle continuation now gated by:
  - per-session pressure threshold (default 90%)
  - total iteration cap
  - stall hash detection
- Session recycle flow added:
  - set `pending_save_progress`
  - prompt orchestrator to continue in fresh session
  - resume through `agent_loop_resume`
- Hard orchestration guardrails added:
  - orchestrator agent permissions deny mutation tools and non-`agent-loop-worker` Task dispatch
  - plugin-level `tool.execute.before` enforces runtime policy in orchestrator session
- Handoff processing now returns compressed summaries to reduce main-context growth

## Runtime Controls (Current Defaults)

- `max_iterations_per_session`: 15
- `context_pressure_threshold`: 0.9
- `max_total_iterations`: 200
- `stall_threshold`: 3

These values live in `loop-state.json` and are persisted between sessions.

## Orchestrator Contract

- Use `agent_loop_status` at start.
- If `runtime.pending_save_progress` is `true`, stop dispatching in current session.
- In a fresh session, call `agent_loop_resume` and continue normal execution.
- Never implement code directly; always dispatch `agent-loop-worker`.

## Worker Contract

- Complete one task only.
- Return handoff block using `HANDOFF_START ... HANDOFF_END` format.
- Include status (`done|failed|blocked`) and required sections.

## Remaining Improvements

1. Add configurable runtime thresholds via tool inputs or env (without breaking defaults).
2. Persist richer gate evidence under `.agent-loop/evidence/`.
3. Add targeted tests for runtime state transitions:
   - recycle trigger
   - cross-session resume
   - stall cutoff behavior
4. Optionally add token-aware pressure estimation to complement iteration-based pressure.

## Out of Scope

- Claude Code compatibility layer
- Parallel worker fan-out
- Automatic commits/push behavior

## Reference Files

- `.opencode/plugins/agent-loop/plugin.ts`
- `.opencode/plugins/agent-loop/state.ts`
- `.opencode/plugins/agent-loop/types.ts`
- `.opencode/plugins/agent-loop/prompts.ts`
- `.opencode/commands/agent-loop.md`
- `.opencode/agents/agent-loop-orchestrator.md`
