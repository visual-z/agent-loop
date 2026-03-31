# Agent Loop - Agent Quickstart

[English README](README.md) | [中文 README](README.zh-CN.md)

## 1) User install commands only

### OpenCode

Tell user to run inside OpenCode:

```bash
!bunx @agent-loop/agent-loop-opencode@latest
```

### Claude Code

Tell user to run:

```bash
/plugin add-marketplace https://github.com/visual-z/agent-loop
```

If your environment has shortcut syntax, this can be:

```bash
/add-marketplace https://github.com/visual-z/agent-loop
```

## 2) Invoke after install

- Preferred command (both runtimes):

```text
/agent-loop <plan-path-or-objective>
```

- Claude fallback if namespacing is required:

```text
/agent-loop:agent-loop <plan-path-or-objective>
```

## 3) Agent response requirements

Always output these two points clearly:

1. Which plugin was installed: OpenCode or Claude Code.
2. Exactly how to invoke it now (the slash command and one concrete example).
