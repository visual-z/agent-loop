import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";

export function loopDir(workdir) {
  return join(workdir, ".agent-loop");
}

export function boulderPath(workdir) {
  return join(loopDir(workdir), "boulder.json");
}

export function plansDir(workdir) {
  return join(loopDir(workdir), "plans");
}

export function handoffsDir(workdir) {
  return join(loopDir(workdir), "handoffs");
}

export function notepadsDir(workdir, planName) {
  return join(loopDir(workdir), "notepads", planName);
}

export function runtimeStatePath(workdir) {
  return join(loopDir(workdir), "loop-state.json");
}

export function createRuntimeState(sessionId, startedAt) {
  const now = startedAt || new Date().toISOString();
  return {
    active: true,
    session_id: sessionId,
    iteration: 0,
    max_iterations_per_session: 15,
    total_iterations: 0,
    max_total_iterations: 200,
    started_at: now,
    last_continued_at: null,
    last_state_hash: null,
    stall_count: 0,
    stall_threshold: 3,
    pending_save_progress: false,
    context_pressure_threshold: 0.9,
  };
}

export async function readRuntimeState(workdir) {
  const p = runtimeStatePath(workdir);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw);
    const base = createRuntimeState(
      parsed.session_id ?? null,
      parsed.started_at || new Date().toISOString()
    );
    return {
      ...base,
      ...parsed,
      started_at: parsed.started_at || base.started_at,
    };
  } catch {
    return null;
  }
}

export async function writeRuntimeState(workdir, state) {
  await ensureDir(loopDir(workdir));
  await writeFile(runtimeStatePath(workdir), JSON.stringify(state, null, 2), "utf-8");
}

export async function readBoulder(workdir) {
  const p = boulderPath(workdir);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeBoulder(workdir, state) {
  state.updated_at = new Date().toISOString();
  state.stats = computeStats(state);
  await ensureDir(loopDir(workdir));
  await writeFile(boulderPath(workdir), JSON.stringify(state, null, 2), "utf-8");
}

export function createBoulder(planPath, planName, tasks, orchestratorSessionId) {
  const now = new Date().toISOString();
  const taskSessions = {};

  for (const t of tasks) {
    taskSessions[t.key] = {
      task_key: t.key,
      task_title: t.title,
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      dependencies: t.dependencies,
    };
  }

  return {
    active_plan: planPath,
    plan_name: planName,
    started_at: now,
    updated_at: now,
    iteration: 0,
    max_iterations: 100,
    status: "running",
    completion_promise: "ALL_TASKS_DONE",
    current_task: null,
    orchestrator_session_id: orchestratorSessionId,
    last_worker_session_id: null,
    task_sessions: taskSessions,
    stats: {
      total_tasks: tasks.length,
      done: 0,
      in_progress: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      pending: tasks.length,
      backpressure_failures: 0,
      total_attempts: 0,
    },
    consecutive_failures: 0,
    max_consecutive_failures: 5,
  };
}

export function computeStats(state) {
  const sessions = Object.values(state.task_sessions);
  const counts = {
    pending: 0,
    "in-progress": 0,
    done: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };

  let totalAttempts = 0;
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] || 0) + 1;
    totalAttempts += s.attempts;
  }

  return {
    total_tasks: sessions.length,
    done: counts.done,
    in_progress: counts["in-progress"],
    failed: counts.failed,
    blocked: counts.blocked,
    skipped: counts.skipped,
    pending: counts.pending,
    backpressure_failures: state.stats?.backpressure_failures ?? 0,
    total_attempts: totalAttempts,
  };
}

export function markTaskStarted(state, taskKey, workerSessionId) {
  const task = state.task_sessions[taskKey];
  if (!task) throw new Error(`Unknown task: ${taskKey}`);

  task.status = "in-progress";
  task.attempts += 1;
  task.started_at = new Date().toISOString();
  if (workerSessionId) task.worker_session_id = workerSessionId;

  state.current_task = taskKey;
  state.iteration += 1;
}

export function markTaskDone(state, taskKey) {
  const task = state.task_sessions[taskKey];
  if (!task) throw new Error(`Unknown task: ${taskKey}`);

  task.status = "done";
  task.completed_at = new Date().toISOString();
  state.consecutive_failures = 0;
  if (state.current_task === taskKey) state.current_task = null;
}

export function markTaskFailed(state, taskKey, error) {
  const task = state.task_sessions[taskKey];
  if (!task) throw new Error(`Unknown task: ${taskKey}`);

  task.last_error = error;
  state.consecutive_failures += 1;

  if (task.attempts >= task.max_attempts) {
    task.status = "blocked";
  } else {
    task.status = "failed";
  }

  if (state.current_task === taskKey) state.current_task = null;
}

export function markTaskBlocked(state, taskKey, reason) {
  const task = state.task_sessions[taskKey];
  if (!task) throw new Error(`Unknown task: ${taskKey}`);

  task.status = "blocked";
  task.last_error = reason;
  if (!task.completed_at) task.completed_at = new Date().toISOString();
  state.consecutive_failures += 1;

  if (state.current_task === taskKey) state.current_task = null;
}

export function pickNextTask(state) {
  for (const [key, task] of Object.entries(state.task_sessions)) {
    if (task.status === "failed" && task.attempts < task.max_attempts) {
      if (areDependenciesMet(state, key)) return key;
    }
  }

  for (const [key, task] of Object.entries(state.task_sessions)) {
    if (task.status === "pending") {
      if (areDependenciesMet(state, key)) return key;
    }
  }

  return null;
}

function areDependenciesMet(state, taskKey) {
  const task = state.task_sessions[taskKey];
  if (!task?.dependencies?.length) return true;

  return task.dependencies.every((depKey) => {
    const dep = state.task_sessions[depKey];
    return dep && (dep.status === "done" || dep.status === "skipped");
  });
}

export function isLoopComplete(state) {
  return Object.values(state.task_sessions).every(
    (task) => task.status === "done" || task.status === "blocked" || task.status === "skipped"
  );
}

export function shouldHalt(state) {
  if (state.iteration >= state.max_iterations) return true;
  if (state.consecutive_failures >= state.max_consecutive_failures) return true;

  const remaining = Object.values(state.task_sessions).filter(
    (task) => task.status !== "done" && task.status !== "skipped"
  );

  return remaining.length > 0 && remaining.every((task) => task.status === "blocked");
}

export async function parsePlan(planPath) {
  const raw = await readFile(planPath, "utf-8");
  const name = basename(planPath, ".md");

  const tldr = extractSection(raw, "TL;DR") || extractSection(raw, "TLDR") || "";
  const context = extractSection(raw, "Context") || "";
  const objectives = extractSection(raw, "Work Objectives") || "";
  const verification = extractSection(raw, "Verification Strategy") || "";
  const tasks = parseTodos(raw);

  return {
    name,
    path: planPath,
    tldr,
    context,
    objectives,
    verification_strategy: verification,
    tasks,
  };
}

function extractSection(md, heading) {
  const regex = new RegExp(`^#{1,3}\\s+${escapeRegex(heading)}\\s*$`, "mi");
  const match = regex.exec(md);
  if (!match) return "";

  const startIdx = match.index + match[0].length;
  const level = (match[0].match(/^#+/) || ["##"])[0].length;
  const nextHeading = new RegExp(`^#{1,${level}}\\s+`, "m");
  const rest = md.slice(startIdx);
  const nextMatch = nextHeading.exec(rest);
  const endIdx = nextMatch ? nextMatch.index : rest.length;

  return rest.slice(0, endIdx).trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseTodos(planContent) {
  const tasks = [];
  const todoSection =
    extractSection(planContent, "TODOs") ||
    extractSection(planContent, "Tasks") ||
    planContent;

  const todoRegex = /^- \[[ x]\]\s*(?:(\d+)\.\s*)?(.+)$/gm;
  let match;
  const rawTodos = [];

  while ((match = todoRegex.exec(todoSection)) !== null) {
    const idx = match[1] ? parseInt(match[1], 10) : rawTodos.length + 1;
    rawTodos.push({
      index: idx,
      title: match[2].trim(),
      startPos: match.index + match[0].length,
    });
  }

  for (let i = 0; i < rawTodos.length; i += 1) {
    const start = rawTodos[i].startPos;
    const end =
      i + 1 < rawTodos.length
        ? todoSection.lastIndexOf("\n- [", rawTodos[i + 1].startPos)
        : todoSection.length;
    const body = todoSection.slice(start, end).trim();

    tasks.push({
      index: rawTodos[i].index,
      key: `todo:${rawTodos[i].index}`,
      title: rawTodos[i].title,
      description: body,
      acceptance_criteria: extractBoldSection(body, "Acceptance Criteria"),
      references: extractBoldSection(body, "References"),
      must_not_do: extractBoldSection(body, "Must NOT do"),
      dependencies: parseDependencies(body),
    });
  }

  return tasks;
}

function extractBoldSection(body, label) {
  const regex = new RegExp(`\\*\\*${escapeRegex(label)}\\*\\*:\\s*(.+?)(?=\\n\\s*\\*\\*|$)`, "s");
  const match = regex.exec(body);
  return match ? match[1].trim() : "";
}

function parseDependencies(body) {
  const match = /\*\*Depends on\*\*:\s*(.+)/i.exec(body);
  if (!match) return undefined;
  const deps = match[1].match(/todo:\d+/g);
  return deps || undefined;
}

export async function writeHandoff(workdir, handoff) {
  const dir = handoffsDir(workdir);
  await ensureDir(dir);

  const fileName = `${handoff.meta.task_key.replace(":", "-")}-handoff.md`;
  const filePath = join(dir, fileName);

  const content = `---
task_key: ${handoff.meta.task_key}
task_title: "${handoff.meta.task_title}"
status: ${handoff.meta.status}
attempts: ${handoff.meta.attempts}
completed_at: "${handoff.meta.completed_at}"
---

## What Was Done
${handoff.what_was_done}

## Key Decisions
${handoff.key_decisions}

## Files Changed
${handoff.files_changed}

## Test Results
${handoff.test_results}

## Learnings for Next Tasks
${handoff.learnings}

## Blocked / Known Issues
${handoff.blocked_issues}

## Next Task Context
${handoff.next_task_context}
`;

  await writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function readHandoff(workdir, taskKey) {
  const fileName = `${taskKey.replace(":", "-")}-handoff.md`;
  const filePath = join(handoffsDir(workdir), fileName);
  if (!existsSync(filePath)) return null;

  const raw = await readFile(filePath, "utf-8");
  return parseHandoff(raw);
}

export async function readLatestHandoff(workdir) {
  const dir = handoffsDir(workdir);
  if (!existsSync(dir)) return null;

  const files = (await readdir(dir)).filter((f) => f.endsWith("-handoff.md"));
  if (files.length === 0) return null;

  files.sort((a, b) => {
    const numA = parseInt(a.match(/todo-(\d+)-handoff\.md$/)?.[1] || "0", 10);
    const numB = parseInt(b.match(/todo-(\d+)-handoff\.md$/)?.[1] || "0", 10);
    return numA - numB;
  });

  const latest = files[files.length - 1];
  const raw = await readFile(join(dir, latest), "utf-8");
  return parseHandoff(raw);
}

function parseHandoff(raw) {
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";

  const meta = {
    task_key: extractFmValue(frontmatter, "task_key"),
    task_title: extractFmValue(frontmatter, "task_title").replace(/^"|"$/g, ""),
    status: extractFmValue(frontmatter, "status"),
    attempts: parseInt(extractFmValue(frontmatter, "attempts") || "1", 10),
    completed_at: extractFmValue(frontmatter, "completed_at").replace(/^"|"$/g, ""),
  };

  const body = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;

  return {
    meta,
    what_was_done: extractSection(body, "What Was Done"),
    key_decisions: extractSection(body, "Key Decisions"),
    files_changed: extractSection(body, "Files Changed"),
    test_results: extractSection(body, "Test Results"),
    learnings: extractSection(body, "Learnings for Next Tasks"),
    blocked_issues: extractSection(body, "Blocked / Known Issues"),
    next_task_context: extractSection(body, "Next Task Context"),
  };
}

function extractFmValue(frontmatter, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  return match ? match[1].trim() : "";
}

export async function readNotepad(workdir, planName, noteType) {
  const path = join(notepadsDir(workdir, planName), `${noteType}.md`);
  if (!existsSync(path)) return "";
  return readFile(path, "utf-8");
}

export async function appendNotepad(workdir, planName, noteType, content) {
  const dir = notepadsDir(workdir, planName);
  await ensureDir(dir);

  const path = join(dir, `${noteType}.md`);
  const existing = existsSync(path) ? await readFile(path, "utf-8") : "";
  const timestamp = new Date().toISOString().slice(0, 19);
  const appended = `${existing}\n\n### [${timestamp}]\n${content}`.trim();
  await writeFile(path, appended + "\n", "utf-8");
}

async function ensureDir(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}
