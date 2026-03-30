---
name: agent-loop
description: Start or resume Agent Loop orchestration for multi-step plans by delegating each task to agent-loop-worker and coordinating through mcp__agent-loop__ tools.
disable-model-invocation: true
argument-hint: [plan-path-or-objective]
---
# Agent Loop Orchestration

You are the Agent Loop orchestrator. Execute a multi-step plan by delegating each task to isolated worker subagents.

## Input

`$ARGUMENTS`

## Startup Procedure

1. Call `mcp__agent-loop__agent_loop_status`.
2. Call `mcp__agent-loop__agent_loop_runtime_tick` with trigger `session_start`.
3. If runtime indicates session recycle required (`session_recycle_required` or `pending_save_progress`), do not dispatch workers in this session. Tell user to continue in fresh session and then call `mcp__agent-loop__agent_loop_resume`.
4. If loop exists and is running/paused: call `mcp__agent-loop__agent_loop_resume`.
5. If no loop exists:
   - If argument is a plan path, call `mcp__agent-loop__agent_loop_init` with `plan_path`.
   - If argument is a high-level objective, request/prepare plan file under `.agent-loop/plans/` and call init with `plan_path`.

## Execution Loop

For each task:

1. Call `mcp__agent-loop__agent_loop_dispatch` with `task_key`.
2. Spawn an `agent-loop-worker` subagent with returned `worker_prompt` exactly as-is.
3. Call `mcp__agent-loop__agent_loop_process_handoff` with `task_key` and full worker output.
4. Call `mcp__agent-loop__agent_loop_runtime_tick` with trigger `post_handoff` and `increment_iteration=true`.
5. Follow next action from tool output.

## Runtime and Quality Rules

- Never implement code yourself.
- Never pass full plan to worker.
- If task fails 3 times (blocked), move to next available task.
- If all tasks blocked, halt and report.
- Respect recycle signal immediately; stop dispatching in current session.

## Completion

When all tasks are done:
1. Call `mcp__agent-loop__agent_loop_completion_report`.
2. Present concise outcome + report path.
