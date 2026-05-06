# Agent Loop Plan Format

Path: `.agent-loop/codex/loops/<loop_id>/plan.md`

Write plans for execution, not ceremony. The plan should let a worker understand exactly one task without seeing the whole conversation.

```markdown
# <Objective Title>

## Summary
One short paragraph describing the outcome.

## Tasks

### todo:1 - Discover current behavior
Type: spike
Depends on: none
Files: `src/example.ts`, `tests/example.test.ts`
Validation: `npm test`
Acceptance: Current behavior and safe edit path are documented in `notes.md`.

Inspect the current implementation and record the relevant constraints.

### todo:2 - Implement focused change
Type: impl
Depends on: todo:1
Files: `src/example.ts`
Validation: `npm test`
Acceptance: The requested behavior works and existing behavior remains covered.

Make the smallest change that satisfies the objective.

### todo:3 - Verify and report
Type: verify
Depends on: todo:2
Files: none
Validation: `npm test`
Acceptance: Completion audit maps the objective to evidence.

Run validation and produce the final report.
```

## Guidelines

- Use 3-12 tasks.
- Prefer one upfront spike only when discovery materially reduces risk.
- Give each implementation task a narrow file or subsystem boundary.
- Use parallel groups only for independent tasks with disjoint files and no shared generated artifacts.
- Verification tasks should run after implementation tasks settle.
- Do not invent backend, schema, or deployment work unless the objective requires it.
