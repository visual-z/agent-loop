# Agent Loop State

State lives in the workspace so any Codex session can resume without relying on chat history.

## active-loop.json

Path: `.agent-loop/codex/active-loop.json`

```json
{
  "loop_id": "short-slug",
  "activated_at": "2026-05-06T00:00:00.000Z"
}
```

## state.json

Path: `.agent-loop/codex/loops/<loop_id>/state.json`

```json
{
  "loop_id": "short-slug",
  "objective": "User-provided objective",
  "status": "planning",
  "continue_on_stop": false,
  "awaiting_user": false,
  "stop_hook_active": false,
  "created_at": "2026-05-06T00:00:00.000Z",
  "updated_at": "2026-05-06T00:00:00.000Z",
  "last_handoff": null,
  "next_action": "Write the plan.",
  "tasks": []
}
```

Statuses:

- `planning`: plan is being written or clarified.
- `running`: workers may be dispatched and Stop hook continuation may run.
- `paused`: user or parent thread halted the loop.
- `blocked`: no progress is possible without user input or a fix decision.
- `completed`: completion audit passed.

Task shape:

```json
{
  "key": "todo:1",
  "title": "Implement the focused change",
  "type": "spike",
  "status": "pending",
  "depends_on": [],
  "files": ["src/example.ts"],
  "validation": "npm test",
  "acceptance": "Observable done condition",
  "attempts": 0,
  "notes": ""
}
```

Task statuses: `pending`, `in-progress`, `done`, `failed`, `blocked`.

## Update Rules

- Write state after every dispatch, handoff, validation result, pause, resume, and completion.
- Keep `updated_at` current whenever meaningful state changes.
- Set `continue_on_stop: true` only when the next turn can safely continue without user input.
- Set `awaiting_user: true` when the loop must stop for a decision.
- Do not mark `completed` until the completion audit has real evidence for every requirement.
