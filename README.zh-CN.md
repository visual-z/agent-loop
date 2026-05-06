# Agent Loop

[English README](README.md) | [给 Agent 的精简 README](README.agent.md)

本项目发布给 OpenCode 和 Codex。

## 用户安装

### OpenCode（一个 bang 命令）

在 OpenCode 里直接执行：

```bash
!bunx @agent-loop/agent-loop-opencode@latest
```

### Codex Plugin

把这个仓库添加成 Codex plugin marketplace：

```bash
codex plugin marketplace add visual-z/agent-loop
codex
/plugins
```

然后在插件目录里切到 Agent Loop marketplace，安装 `Agent Loop`。详细说明见
[codex-plugin/README.md](codex-plugin/README.md)。

## 安装后使用

```text
/agent-loop <计划路径或目标>
$agent-loop plan <目标>
```
