# Worker Handoff

Every worker returns a handoff block as the final content of its response. The parent thread saves it to:

`.agent-loop/codex/loops/<loop_id>/handoffs/<task_key>.md`

## Worker Prompt Shape

Give the worker:

- One task key and title.
- The task description, acceptance criteria, files, and validation command.
- Relevant notes from `notes.md`.
- Any previous handoff context needed for this task.
- The handoff contract below.

Do not give the worker unrelated tasks or the whole chat history.

## Required Handoff

```text
HANDOFF_START
task_key: todo:1
task_title: Example task
status: done|failed|blocked

## What Was Done
- Concrete work completed.

## Key Decisions
- Decisions that affect later tasks, or "None".

## Files Changed
- `path/to/file`

## Validation
- Command run and result, or why validation was not run.

## Evidence
- Files, command output, screenshots, or other artifacts proving the result.

## Blocked / Known Issues
None

## Next Task Context
Specific context the parent or next worker should know.
HANDOFF_END
```

## Parent Processing

- Save the handoff exactly.
- Update the task status and attempts in `state.json`.
- Append durable decisions, learnings, and blockers to `notes.md`.
- Run validation when the task or dependent batch requires it.
- If status is `blocked`, do not retry blindly. Either choose another ready task or ask the user.
