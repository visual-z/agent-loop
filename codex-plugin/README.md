# Agent Loop Codex Plugin

Codex-native Agent Loop plugin.

This package ports the Agent Loop idea, not the OpenCode runtime. It uses:

- Codex skills for orchestration instructions.
- Workspace files for state and handoffs.
- Codex hooks for best-effort continuation nudges.
- Codex subagents for isolated task execution.

It intentionally does not use MCP for internal Agent Loop behavior.

## Use

Install from the public GitHub repository:

```bash
codex plugin marketplace add visual-z/agent-loop
codex
/plugins
```

In the plugin directory, switch to the Agent Loop marketplace, open Agent Loop,
and select `Install plugin`. Then start a new thread and invoke:

```text
$agent-loop plan <objective>
$agent-loop run
$agent-loop resume
$agent-loop report
```

For a pinned install, use:

```bash
codex plugin marketplace add visual-z/agent-loop --ref main
```

State is written under:

```text
.agent-loop/codex/
```

## Limits

The Stop hook can request another turn when a loop is active, but it is not a full background runtime. It will stop when the loop is paused, complete, waiting for user input, blocked, or unchanged too recently.
