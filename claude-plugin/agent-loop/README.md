# Agent Loop Plugin for Claude Code

This plugin ports the OpenCode Agent Loop model to Claude Code with equivalent behavior where possible.

It uses:
- MCP tools (`mcp__agent-loop__agent_loop_*`) for loop lifecycle/state management
- Orchestrator + worker subagents for strict delegation
- Hooks for runtime guardrails and policy enforcement
- Existing `.agent-loop/` state files (`boulder.json`, `loop-state.json`, `handoffs/`, `notepads/`)

## Why this shape

Claude Code plugin APIs differ from OpenCode plugin APIs. This implementation replaces non-portable mechanisms with Claude-native primitives:

- `session.idle` continuation -> explicit runtime tick tool + orchestrator loop turns
- direct session prompt injection -> orchestrator retrieves continuation prompts from tool output
- plugin custom tool registration -> MCP server tools
- `tool.execute.before` plugin hook -> `PreToolUse` guard hook
- compaction context push -> `SessionStart`/runtime context injection + explicit compact context tool

## Directory Layout

- `.claude-plugin/plugin.json` - plugin manifest
- `.mcp.json` - registers `agent-loop` MCP server
- `mcp/server.mjs` - MCP tool server exposing `agent_loop_*`
- `mcp/core/*.mjs` - state, prompt, gate logic
- `agents/agent-loop-orchestrator.md` - orchestrator subagent
- `agents/agent-loop-worker.md` - worker subagent
- `skills/agent-loop/SKILL.md` - entry skill (`/agent-loop`)
- `hooks/hooks.json` - runtime guard hooks
- `hooks/orchestrator-guard.mjs` - blocks orchestrator mutation tools + invalid agent dispatch
- `hooks/runtime-gate.mjs` - stop gate for recycle/halt conditions
- `hooks/session-start-context.mjs` - reinjects loop context at session start/resume

## Setup

1. Install dependencies in plugin directory:

```bash
cd claude-plugin/agent-loop
bun install
```

Optional validation:

```bash
bun run check
```

2. Load plugin for local testing:

```bash
claude --plugin-dir ./claude-plugin/agent-loop
```

3. Use `/agent-loop` and provide plan path/objective.

## Recommended settings

Set the default main-thread agent to orchestrator while plugin is enabled:

```json
{
  "agent": "agent-loop-orchestrator"
}
```

You can put this in the plugin `settings.json` (provided) or in project/user settings.

## Feature Equivalence Mapping

### Fully equivalent

- loop state machine persisted in `.agent-loop/`
- task dispatch / worker isolation / handoff parsing
- notepad accumulation (`learnings`, `decisions`, `issues`)
- backpressure gate (build/test/lint)
- manual halt/status/resume/completion report

### Equivalent with adaptation

- orchestrator policy enforcement via `PreToolUse` hooks
- session recycle via runtime tick signals (instead of idle auto-injection)
- compaction survival via context hooks + state tooling

### Not 1:1 portable (handled by replacement)

- OpenCode `session.idle` event loop driver
- OpenCode `client.session.prompt()` message injection
- OpenCode `tool.execute.before` runtime guard in plugin harness
- OpenCode `experimental.session.compacting` context mutation API

## Runtime Notes

- The orchestrator should call `mcp__agent-loop__agent_loop_runtime_tick` each cycle.
- If runtime returns recycle required, stop dispatching workers in current session.
- Resume in a fresh session with `mcp__agent-loop__agent_loop_resume`.

## Suggested workflow in Claude session

1. Run `/agent-loop <plan-path-or-objective>`.
2. Orchestrator calls `agent_loop_status` -> `agent_loop_runtime_tick`.
3. Dispatch task -> run worker -> process handoff.
4. Repeat until done, or recycle when signaled.

## Known Constraints

- Claude plugin runtime is hook/event oriented; no direct idle heartbeat loop.
- Runtime progression is deterministic but explicit (tool-driven), not implicit (idle-driven).

This is intentional for behavior-equivalent migration under Claude API constraints.
