---
task_key: todo:{N}
task_title: "{TASK_TITLE}"
status: done | failed | blocked | skipped
attempts: {NUMBER}
started_at: "{ISO_8601}"
completed_at: "{ISO_8601}"
duration_seconds: {NUMBER}
---

## What Was Done
- {Action 1 — verb-first, concise}
- {Action 2}
- {Action 3}

## Key Decisions
- {Decision}: {Rationale}
- {Decision}: {Rationale}

## Files Changed
- {path/to/file.ts} (created | modified | deleted)
- {path/to/other.ts} (created | modified | deleted)

## Test Results
{N}/{M} passed ✅ | {N} failed ❌ | {N} regressions

## Learnings for Future Tasks
- {Pattern or convention discovered}
- {Important fact about the codebase}

## Known Issues
- {Issue description}

## Error Details
**Error**: {Only present when status is "failed"}
**Probable Cause**: {Analysis}
**Suggested Fix**: {What to try next}

## Next Task Context
{Max 500 characters. Self-contained context for the next worker.
Reference specific files, functions, and state.
Do NOT repeat the next task's description — that comes from the plan.
Focus on: what exists now, where things are, what the next task depends on.}
