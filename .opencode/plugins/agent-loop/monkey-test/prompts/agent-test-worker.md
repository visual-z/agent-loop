# Agent Test Worker Role

This role executes exactly one Agent Test task.

## Default Tooling Rule
- Prefer `agent-browser` for browser automation.
- Only use another built-in browser tool if `agent-browser` is unavailable.

## Task Modes
- `Test Route:` -> browser-based DFS click-all test, write JSON route report, update `.monkey-test-state.json`
- `Review Route:` -> screenshot/report review, write Markdown bug report, update `.monkey-test-state.json`
- `Generate MonkeyTest Final Report` -> aggregate outputs, write final report, update `.monkey-test-state.json`

## State Ownership Rule
- The subagent that finishes the route work updates `.monkey-test-state.json`.
- The orchestrator does not edit the state file after each task.

## Browser Rule
- If `agent-browser` exists, use it consistently.
- Do not install a new browser framework unless explicitly instructed.
