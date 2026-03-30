# Claude Code Agent Loop Migration

Date: 2026-03-30

This repository now includes a Claude Code plugin implementation of Agent Loop under `claude-plugin/agent-loop/`.

## Goal

Provide functionally equivalent Agent Loop behavior on Claude Code, replacing OpenCode-only plugin APIs with Claude-native equivalents.

## Replacement Mapping

- OpenCode `session.idle` continuation
  - Replaced by explicit runtime control tool: `mcp__agent-loop__agent_loop_runtime_tick`
- OpenCode session prompt injection (`client.session.prompt`)
  - Replaced by orchestrator-driven continuation prompts returned from `agent_loop_status`
- OpenCode plugin tool registration
  - Replaced by MCP server tools in `mcp/server.mjs`
- OpenCode `tool.execute.before` policy guard
  - Replaced by Claude `PreToolUse` hook guard (`hooks/orchestrator-guard.mjs`)
- OpenCode `experimental.session.compacting` context injection
  - Replaced by `SessionStart`/`PostCompact` hook context reinjection

## Delivered Components

- Plugin manifest: `claude-plugin/agent-loop/.claude-plugin/plugin.json`
- MCP tool server: `claude-plugin/agent-loop/mcp/server.mjs`
- Core logic modules:
  - `claude-plugin/agent-loop/mcp/core/state.mjs`
  - `claude-plugin/agent-loop/mcp/core/prompts.mjs`
  - `claude-plugin/agent-loop/mcp/core/gate.mjs`
- Hooks:
  - `claude-plugin/agent-loop/hooks/hooks.json`
  - `claude-plugin/agent-loop/hooks/orchestrator-guard.mjs`
  - `claude-plugin/agent-loop/hooks/runtime-gate.mjs`
  - `claude-plugin/agent-loop/hooks/session-start-context.mjs`
  - `claude-plugin/agent-loop/hooks/post-compact-context.mjs`
- Subagents:
  - `claude-plugin/agent-loop/agents/agent-loop-orchestrator.md`
  - `claude-plugin/agent-loop/agents/agent-loop-worker.md`
- Entry skill:
  - `claude-plugin/agent-loop/skills/agent-loop/SKILL.md`
- Plugin default agent setting:
  - `claude-plugin/agent-loop/settings.json`

## Behavior Notes

- Loop semantics, boulder/notepad/handoff persistence, worker isolation, and gate behavior are preserved.
- Runtime progression in Claude is explicit (tool-driven) instead of implicit idle-driven.
- Session recycle signals are preserved via runtime state and stop/session hooks.

## How to Run

```bash
cd claude-plugin/agent-loop
bun install
bun run check
cd ../..
claude --plugin-dir ./claude-plugin/agent-loop
```

Then in Claude session run:

```text
/agent-loop <plan-path-or-objective>
```

## Validation done

- Bun syntax checks passed for all plugin `.mjs` scripts.
- Dependency install completed in plugin directory via Bun.
