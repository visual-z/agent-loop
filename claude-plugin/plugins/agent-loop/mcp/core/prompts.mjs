export function buildWorkerPrompt(payload) {
  const sections = [];

  sections.push(`# Task Assignment

You are a focused coding worker. Complete the task below, then write a handoff summary.

## CONSTRAINTS
- Complete ONLY the task described below. Do not expand scope.
- Do not modify files unrelated to this task unless absolutely necessary.
- When done, you MUST produce a handoff summary (described at the end).
- Run the verification command before declaring done.
- If you get stuck or blocked, say so explicitly in the handoff with status: blocked.
`);

  sections.push(`## Your Task: ${payload.task.title}

**Task key**: ${payload.task.key}

${payload.task.description}
`);

  if (payload.task.acceptance_criteria) {
    sections.push(`### Acceptance Criteria
${payload.task.acceptance_criteria}
`);
  }

  if (payload.task.must_not_do) {
    sections.push(`### Must NOT Do
${payload.task.must_not_do}
`);
  }

  if (payload.task.references) {
    sections.push(`### References
${payload.task.references}
`);
  }

  if (payload.previous_handoff_context) {
    sections.push(`## Context from Previous Task
The previous worker left these notes for you:

${payload.previous_handoff_context}
`);
  }

  if (payload.relevant_file_paths.length > 0) {
    sections.push(`## Relevant Files
These files are likely relevant to your task:

${payload.relevant_file_paths.map((f) => `- \`${f}\``).join("\n")}
`);
  }

  if (payload.project_conventions) {
    sections.push(`## Project Conventions
${payload.project_conventions}
`);
  }

  const noteSections = [];
  if (payload.notepad_learnings) {
    noteSections.push(`### Learnings\n${truncateNotepad(payload.notepad_learnings, 2000)}`);
  }
  if (payload.notepad_decisions) {
    noteSections.push(`### Decisions\n${truncateNotepad(payload.notepad_decisions, 1000)}`);
  }
  if (payload.notepad_issues) {
    noteSections.push(`### Known Issues\n${truncateNotepad(payload.notepad_issues, 1000)}`);
  }
  if (noteSections.length > 0) {
    sections.push(`## Knowledge Base (from previous tasks)\n${noteSections.join("\n\n")}`);
  }

  if (payload.backpressure_command) {
    sections.push(`## Verification
Before declaring the task complete, run:
\`\`\`
${payload.backpressure_command}
\`\`\`
Include the results in your handoff.
`);
  }

  sections.push(`## Required: Handoff Summary

When your task is complete (or if you're blocked), produce the following summary.
This is CRITICAL - the orchestrator depends on this to coordinate subsequent tasks.

Write this summary as the LAST thing you do. Structure it exactly as:

\`\`\`
HANDOFF_START
task_key: ${payload.task.key}
task_title: ${payload.task.title}
status: done|failed|blocked

## What Was Done
(Bullet points of what you accomplished)

## Key Decisions
(Any architectural or implementation decisions you made and why)

## Files Changed (Optional)
(List of files created, modified, or deleted. Write "None" if no file changes.)

## Test Results
(Output of verification/tests)

## Final Response (Optional)
(If this task is message-only, write the exact user-facing result here.)

## Learnings for Next Tasks
(Patterns, conventions, or gotchas the next worker should know)

## Blocked / Known Issues
(Any blockers or issues - write "None" if clean)

## Next Task Context
(Specific context/instructions that would help the next task)
HANDOFF_END
\`\`\`
`);

  return sections.join("\n");
}

export function buildContinuationPrompt(ctx) {
  const lines = [];

  lines.push(`## Loop Iteration ${ctx.iteration} - Task Completed`);
  lines.push("");
  lines.push(`**Completed**: ${ctx.completed_task_title} (\`${ctx.completed_task_key}\`)`);
  lines.push(`**Progress**: ${ctx.progress}`);
  lines.push("");

  if (ctx.gate_result.passed) {
    lines.push("**Backpressure Gate**: PASSED");
  } else {
    lines.push("**Backpressure Gate**: FAILED");
    if (ctx.gate_result.build && !ctx.gate_result.build.passed) {
      lines.push(`  - Build: FAIL ${ctx.gate_result.build.output.slice(0, 200)}`);
    }
    if (ctx.gate_result.test && !ctx.gate_result.test.passed) {
      lines.push(`  - Test: FAIL ${ctx.gate_result.test.output.slice(0, 200)}`);
    }
    if (ctx.gate_result.lint && !ctx.gate_result.lint.passed) {
      lines.push(`  - Lint: WARN ${ctx.gate_result.lint.output.slice(0, 200)}`);
    }
  }
  lines.push("");

  if (ctx.handoff_summary) {
    lines.push(`**Handoff Summary**: ${ctx.handoff_summary.slice(0, 500)}`);
    lines.push("");
  }

  if (ctx.next_task_key && ctx.next_task_title) {
    lines.push(`**Next Task**: ${ctx.next_task_title} (\`${ctx.next_task_key}\`)`);
    lines.push("");
    lines.push(`Dispatch the next worker for \`${ctx.next_task_key}\` now.`);
  } else {
    lines.push("**All tasks completed.** Generate the completion report.");
  }

  return lines.join("\n");
}

export function buildCompactionContext(state) {
  const loopId = state.loop_id || state.plan_name;

  const doneTasks = Object.values(state.task_sessions)
    .filter((t) => t.status === "done")
    .map((t) => `  [done] ${t.task_key}: ${t.task_title}`)
    .join("\n");

  const pendingTasks = Object.values(state.task_sessions)
    .filter((t) => t.status === "pending" || t.status === "failed")
    .map((t) => `  [todo] ${t.task_key}: ${t.task_title} (${t.status})`)
    .join("\n");

  const blockedTasks = Object.values(state.task_sessions)
    .filter((t) => t.status === "blocked")
    .map((t) => `  [blocked] ${t.task_key}: ${t.task_title} - ${t.last_error || "unknown"}`)
    .join("\n");

  return `## Agent Loop State (preserved across compaction)

**Loop ID**: ${loopId}
**Plan**: ${state.plan_name} (${state.active_plan})
**Status**: ${state.status}
**Iteration**: ${state.iteration}/${state.max_iterations}
**Progress**: ${state.stats.done}/${state.stats.total_tasks} tasks complete

### Completed Tasks
${doneTasks || "  (none yet)"}

### Remaining Tasks
${pendingTasks || "  (none)"}

${blockedTasks ? `### Blocked Tasks\n${blockedTasks}` : ""}

**Current task**: ${state.current_task || "(none - pick next)"}

Read \`.agent-loop/loops/${loopId}/boulder.json\` for full state.
Read \`.agent-loop/loops/${loopId}/handoffs/\` for latest handoff context.
Read \`.agent-loop/loops/${loopId}/notepads/\` for accumulated learnings.
`;
}

export function parseHandoffFromWorkerOutput(output) {
  const match = output.match(/HANDOFF_START\n([\s\S]*?)HANDOFF_END/);
  const block = match ? match[1] : output;
  const statusMatch = block.match(/^status:\s*(.+)$/im);
  const status = normalizeStatus(statusMatch?.[1], output);

  const finalResponse =
    extractHandoffSection(block, [
      "Final Response",
      "User-Facing Result",
      "User Response",
      "Result",
    ]) ||
    (!match ? output.trim().slice(0, 4000) : "");

  return {
    status,
    what_was_done: extractHandoffSection(block, ["What Was Done"]),
    key_decisions: extractHandoffSection(block, ["Key Decisions"]),
    files_changed: extractHandoffSection(block, ["Files Changed"]),
    test_results: extractHandoffSection(block, ["Test Results"]),
    learnings: extractHandoffSection(block, [
      "Learnings for Next Tasks",
      "Learnings for Future Tasks",
      "Learnings",
    ]),
    final_response: finalResponse,
    blocked_issues: extractHandoffSection(block, [
      "Blocked / Known Issues",
      "Blocked Issues",
      "Known Issues",
    ]),
    next_task_context: extractHandoffSection(block, ["Next Task Context"]),
  };
}

function normalizeStatus(raw, sourceText = "") {
  const value = (raw || "").trim().toLowerCase();
  if (value === "failed" || value === "blocked") return value;

  const text = sourceText.toLowerCase();
  if (/\bstatus\s*:\s*blocked\b/.test(text)) return "blocked";
  if (/\bstatus\s*:\s*failed\b/.test(text)) return "failed";
  return "done";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHandoffSection(markdown, labels) {
  for (const label of labels) {
    const headingRegex = new RegExp(`^##\\s+${escapeRegex(label)}\\s*$`, "mi");
    const headingMatch = headingRegex.exec(markdown);
    if (headingMatch) {
      const startIdx = headingMatch.index + headingMatch[0].length;
      const rest = markdown.slice(startIdx);
      const nextHeading = /^##\s+/m.exec(rest);
      const endIdx = nextHeading ? nextHeading.index : rest.length;
      const content = rest.slice(0, endIdx).trim();
      if (content) return content;
    }

    const labelRegex = new RegExp(`^${escapeRegex(label)}:\\s*(.*)$`, "mi");
    const labelMatch = labelRegex.exec(markdown);
    if (!labelMatch) continue;

    const startIdx = labelMatch.index + labelMatch[0].length;
    const rest = markdown.slice(startIdx);
    const nextLabel = /^\s*(?:##\s+|[A-Za-z][A-Za-z /-]*:\s*$)/m.exec(rest);
    const endIdx = nextLabel ? nextLabel.index : rest.length;
    const inline = (labelMatch[1] || "").trim();
    const block = rest.slice(0, endIdx).trim();
    const content = [inline, block].filter(Boolean).join("\n").trim();
    if (content) return content;
  }

  return "";
}

function truncateNotepad(content, maxChars) {
  if (content.length <= maxChars) return content;

  const entries = content.split(/(?=^### \[)/m);
  let result = "";
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if ((result + entries[i]).length > maxChars) break;
    result = entries[i] + result;
  }

  if (result.length < content.length) {
    result = "[...earlier entries truncated...]\n\n" + result;
  }
  return result;
}
