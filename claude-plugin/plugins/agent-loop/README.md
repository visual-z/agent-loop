# Agent Loop Plugin for Claude Code

Install this plugin from Claude Code Marketplace, then run:

```text
/agent-loop <plan-path-or-objective>
```

If your setup requires namespaced commands:

```text
/agent-loop:agent-loop <plan-path-or-objective>
```

This plugin provides:

- `agent-loop-orchestrator` (primary agent)
- `agent-loop-worker` (hidden subagent)
- MCP lifecycle tools (`agent_loop_*`)
- Runtime guard hooks and session continuity hooks

Maintainer validation:

```bash
bun run check
```
