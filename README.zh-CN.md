# Agent Loop（OpenCode + Claude Code）

[English README](README.md) | [给 Agent 的精简 README](README.agent.md)

本项目发布两个运行时版本：OpenCode 和 Claude Code。

## 用户安装

### OpenCode（一个 bang 命令）

在 OpenCode 里直接执行：

```bash
!bunx @agent-loop/agent-loop-opencode@latest
```

### Claude Code

**第 1 步** - 添加 marketplace（只需一次）：

```
/plugin marketplace add visual-z/agent-loop
```

**第 2 步** - 安装插件：

```
/plugin install agent-loop@agent-loop
```

安装后执行 `/reload-plugins` 激活插件。

## 安装后使用

```text
/agent-loop <计划路径或目标>
```

如果你的 Claude 环境强制命名空间：

```text
/agent-loop:agent-loop <计划路径或目标>
```
