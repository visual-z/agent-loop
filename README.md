# Agent Loop (OpenCode + Claude Code)

[中文 README](README.zh-CN.md) | [README for Agents (minimal)](README.agent.md)

This project is published for two runtimes: OpenCode and Claude Code.

## User install

### OpenCode (one bang command)

Run this directly inside OpenCode:

```bash
!bunx @agent-loop/agent-loop-opencode@latest
```

### Claude Code

**Step 1** - Add marketplace:

```
/plugin marketplace add visual-z/agent-loop
```

Or use the shorthand:

```bash
/plugin market add visual-z/agent-loop
```

**Step 2** - Install plugin:

```bash
/plugin install agent-loop@agent-loop
```

Then run `/reload-plugins` to activate.

## Use after install

```text
/agent-loop <plan-path-or-objective>
```

If your Claude setup enforces namespacing:

```text
/agent-loop:agent-loop <plan-path-or-objective>
```
