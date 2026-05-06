# Agent Loop

[中文 README](README.zh-CN.md) | [README for Agents (minimal)](README.agent.md)

This project is published for OpenCode and Codex.

## User install

### OpenCode (one bang command)

Run this directly inside OpenCode:

```bash
!bunx @agent-loop/agent-loop-opencode@latest
```

### Codex Plugin

Add this repository as a Codex plugin marketplace:

```bash
codex plugin marketplace add visual-z/agent-loop
codex
/plugins
```

In the plugin directory, switch to the Agent Loop marketplace and install
`Agent Loop`. See [codex-plugin/README.md](codex-plugin/README.md) for details.

## Use after install

```text
/agent-loop <plan-path-or-objective>
$agent-loop plan <objective>
```
