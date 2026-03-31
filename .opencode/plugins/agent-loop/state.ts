// =============================================================================
// Agent Loop — State Management (multi-instance isolated)
// =============================================================================
//
// Each Agent Loop instance gets its own directory under .agent-loop/loops/{loopId}/
// containing boulder.json, loop-state.json, handoffs/, notepads/, and evidence/.
//
// Plans remain shared under .agent-loop/plans/.
// An active-loop.json pointer tracks the currently active loop on disk.
// =============================================================================

import { readFile, writeFile, mkdir, readdir, rename, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import type {
  BoulderState,
  TaskSession,
  TaskStatus,
  LoopStatus,
  LoopStats,
  LoopRuntimeState,
  HandoffFile,
  HandoffMeta,
  PlanTask,
  Plan,
  GateResult,
  ActiveLoopPointer,
  LoopSummary,
} from "./types";

// ---------------------------------------------------------------------------
// Paths — Global (shared across all loops)
// ---------------------------------------------------------------------------

/** Top-level .agent-loop directory */
export function loopDir(workdir: string): string {
  return join(workdir, ".agent-loop");
}

/** Shared plans directory */
export function plansDir(workdir: string): string {
  return join(loopDir(workdir), "plans");
}

/** Root of all loop instances */
export function loopsRoot(workdir: string): string {
  return join(loopDir(workdir), "loops");
}

/** Path to the active-loop pointer file */
export function activeLoopPointerPath(workdir: string): string {
  return join(loopDir(workdir), "active-loop.json");
}

// ---------------------------------------------------------------------------
// Paths — Per-loop instance
// ---------------------------------------------------------------------------

/** Directory for a specific loop instance */
export function loopInstanceDir(workdir: string, loopId: string): string {
  return join(loopsRoot(workdir), loopId);
}

export function boulderPath(workdir: string, loopId: string): string {
  return join(loopInstanceDir(workdir, loopId), "boulder.json");
}

export function handoffsDir(workdir: string, loopId: string): string {
  return join(loopInstanceDir(workdir, loopId), "handoffs");
}

export function notepadsDir(workdir: string, loopId: string): string {
  return join(loopInstanceDir(workdir, loopId), "notepads");
}

export function evidenceDir(workdir: string, loopId: string): string {
  return join(loopInstanceDir(workdir, loopId), "evidence");
}

export function runtimeStatePath(workdir: string, loopId: string): string {
  return join(loopInstanceDir(workdir, loopId), "loop-state.json");
}

// ---------------------------------------------------------------------------
// Active Loop Pointer — Tracks which loop is currently active
// ---------------------------------------------------------------------------

export async function readActiveLoopPointer(
  workdir: string
): Promise<ActiveLoopPointer | null> {
  const p = activeLoopPointerPath(workdir);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as ActiveLoopPointer;
  } catch {
    return null;
  }
}

export async function writeActiveLoopPointer(
  workdir: string,
  loopId: string
): Promise<void> {
  await ensureDir(loopDir(workdir));
  const pointer: ActiveLoopPointer = {
    loop_id: loopId,
    activated_at: new Date().toISOString(),
  };
  await writeFile(
    activeLoopPointerPath(workdir),
    JSON.stringify(pointer, null, 2),
    "utf-8"
  );
}

export async function clearActiveLoopPointer(workdir: string): Promise<void> {
  const p = activeLoopPointerPath(workdir);
  if (existsSync(p)) {
    try {
      await unlink(p);
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// List Loops — Discover all loop instances
// ---------------------------------------------------------------------------

export async function listLoops(workdir: string): Promise<LoopSummary[]> {
  const root = loopsRoot(workdir);
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const loops: LoopSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const loopId = entry.name;
    const boulder = await readBoulder(workdir, loopId);
    if (!boulder) continue;

    loops.push({
      loop_id: loopId,
      plan_name: boulder.plan_name,
      status: boulder.status,
      progress: `${boulder.stats.done}/${boulder.stats.total_tasks}`,
      started_at: boulder.started_at,
      updated_at: boulder.updated_at,
    });
  }

  // Sort by updated_at descending (most recent first)
  loops.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return loops;
}

// ---------------------------------------------------------------------------
// Migration — Move old single-instance layout to new multi-instance layout
// ---------------------------------------------------------------------------

/**
 * Detect and migrate old-style .agent-loop/boulder.json to
 * .agent-loop/loops/{planName}/boulder.json.
 *
 * Returns the migrated loop_id, or null if no migration was needed.
 */
export async function migrateOldLayout(workdir: string): Promise<string | null> {
  const oldBoulderPath = join(loopDir(workdir), "boulder.json");
  if (!existsSync(oldBoulderPath)) return null;

  // Check if the old boulder.json already has loop_id (already migrated somehow)
  let oldBoulder: BoulderState;
  try {
    const raw = await readFile(oldBoulderPath, "utf-8");
    oldBoulder = JSON.parse(raw) as BoulderState;
  } catch {
    return null;
  }

  const loopId = oldBoulder.plan_name || "default";
  const instanceDir = loopInstanceDir(workdir, loopId);

  // Don't migrate if target already exists
  if (existsSync(join(instanceDir, "boulder.json"))) {
    // Just clean up old file
    try { await unlink(oldBoulderPath); } catch { /* ignore */ }
    return loopId;
  }

  // Create the new loop directory
  await ensureDir(instanceDir);

  // Migrate boulder.json
  oldBoulder.loop_id = loopId;
  await writeFile(
    join(instanceDir, "boulder.json"),
    JSON.stringify(oldBoulder, null, 2),
    "utf-8"
  );

  // Migrate loop-state.json
  const oldRuntimePath = join(loopDir(workdir), "loop-state.json");
  if (existsSync(oldRuntimePath)) {
    try {
      await rename(oldRuntimePath, join(instanceDir, "loop-state.json"));
    } catch {
      // Copy instead if rename fails (cross-device)
      const content = await readFile(oldRuntimePath, "utf-8");
      await writeFile(join(instanceDir, "loop-state.json"), content, "utf-8");
      try { await unlink(oldRuntimePath); } catch { /* ignore */ }
    }
  }

  // Migrate handoffs
  const oldHandoffsDir = join(loopDir(workdir), "handoffs");
  if (existsSync(oldHandoffsDir)) {
    const newHandoffsDir = join(instanceDir, "handoffs");
    await ensureDir(newHandoffsDir);
    const files = await readdir(oldHandoffsDir);
    for (const file of files) {
      if (file.endsWith("-handoff.md")) {
        try {
          await rename(join(oldHandoffsDir, file), join(newHandoffsDir, file));
        } catch {
          const content = await readFile(join(oldHandoffsDir, file), "utf-8");
          await writeFile(join(newHandoffsDir, file), content, "utf-8");
        }
      }
    }
  }

  // Migrate notepads (old structure: .agent-loop/notepads/{planName}/)
  const oldNotepadsDir = join(loopDir(workdir), "notepads", loopId);
  if (existsSync(oldNotepadsDir)) {
    const newNotepadsDir = join(instanceDir, "notepads");
    await ensureDir(newNotepadsDir);
    const files = await readdir(oldNotepadsDir);
    for (const file of files) {
      try {
        await rename(join(oldNotepadsDir, file), join(newNotepadsDir, file));
      } catch {
        const content = await readFile(join(oldNotepadsDir, file), "utf-8");
        await writeFile(join(newNotepadsDir, file), content, "utf-8");
      }
    }
  }

  // Migrate evidence
  const oldEvidenceDir = join(loopDir(workdir), "evidence");
  if (existsSync(oldEvidenceDir)) {
    const newEvidenceDir = join(instanceDir, "evidence");
    await ensureDir(newEvidenceDir);
    const files = await readdir(oldEvidenceDir);
    for (const file of files) {
      if (file === ".gitkeep") continue;
      try {
        await rename(join(oldEvidenceDir, file), join(newEvidenceDir, file));
      } catch {
        const content = await readFile(join(oldEvidenceDir, file), "utf-8");
        await writeFile(join(newEvidenceDir, file), content, "utf-8");
      }
    }
  }

  // Migrate report if exists
  const oldReportPath = join(loopDir(workdir), `report-${loopId}.md`);
  if (existsSync(oldReportPath)) {
    try {
      await rename(oldReportPath, join(instanceDir, `report-${loopId}.md`));
    } catch { /* ignore */ }
  }

  // Remove old boulder.json
  try { await unlink(oldBoulderPath); } catch { /* ignore */ }

  // Set as active if it was running
  if (oldBoulder.status === "running" || oldBoulder.status === "paused") {
    await writeActiveLoopPointer(workdir, loopId);
  }

  return loopId;
}

// ---------------------------------------------------------------------------
// Runtime State (loop-state.json) — Per-loop instance
// ---------------------------------------------------------------------------

export function createRuntimeState(
  sessionId: string | null,
  startedAt?: string
): LoopRuntimeState {
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

export async function readRuntimeState(
  workdir: string,
  loopId: string
): Promise<LoopRuntimeState | null> {
  const p = runtimeStatePath(workdir, loopId);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LoopRuntimeState>;
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

export async function writeRuntimeState(
  workdir: string,
  loopId: string,
  state: LoopRuntimeState
): Promise<void> {
  await ensureDir(loopInstanceDir(workdir, loopId));
  await writeFile(
    runtimeStatePath(workdir, loopId),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// boulder.json — Read / Write / Create / Update (per-loop instance)
// ---------------------------------------------------------------------------

export async function readBoulder(
  workdir: string,
  loopId: string
): Promise<BoulderState | null> {
  const p = boulderPath(workdir, loopId);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as BoulderState;
  } catch {
    return null;
  }
}

export async function writeBoulder(
  workdir: string,
  loopId: string,
  state: BoulderState
): Promise<void> {
  state.updated_at = new Date().toISOString();
  state.stats = computeStats(state);
  await ensureDir(loopInstanceDir(workdir, loopId));
  await writeFile(
    boulderPath(workdir, loopId),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

export function createBoulder(
  loopId: string,
  planPath: string,
  planName: string,
  tasks: PlanTask[],
  orchestratorSessionId: string | null
): BoulderState {
  const now = new Date().toISOString();

  const taskSessions: Record<string, TaskSession> = {};
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

  const state: BoulderState = {
    loop_id: loopId,
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
  return state;
}

export function computeStats(state: BoulderState): LoopStats {
  const sessions = Object.values(state.task_sessions);
  const counts: Record<TaskStatus, number> = {
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

/** Mark a task as in-progress */
export function markTaskStarted(
  state: BoulderState,
  taskKey: string,
  workerSessionId?: string
): void {
  const t = state.task_sessions[taskKey];
  if (!t) throw new Error(`Unknown task: ${taskKey}`);
  t.status = "in-progress";
  t.attempts += 1;
  t.started_at = new Date().toISOString();
  if (workerSessionId) t.worker_session_id = workerSessionId;
  state.current_task = taskKey;
  state.iteration += 1;
}

/** Mark task as done */
export function markTaskDone(state: BoulderState, taskKey: string): void {
  const t = state.task_sessions[taskKey];
  if (!t) throw new Error(`Unknown task: ${taskKey}`);
  t.status = "done";
  t.completed_at = new Date().toISOString();
  state.consecutive_failures = 0;
  if (state.current_task === taskKey) {
    state.current_task = null;
  }
}

/** Mark task as failed */
export function markTaskFailed(
  state: BoulderState,
  taskKey: string,
  error: string
): void {
  const t = state.task_sessions[taskKey];
  if (!t) throw new Error(`Unknown task: ${taskKey}`);
  t.last_error = error;
  state.consecutive_failures += 1;

  if (t.attempts >= t.max_attempts) {
    t.status = "blocked";
  } else {
    t.status = "failed"; // eligible for retry
  }

  if (state.current_task === taskKey) {
    state.current_task = null;
  }
}

/** Mark task as blocked immediately */
export function markTaskBlocked(
  state: BoulderState,
  taskKey: string,
  reason: string
): void {
  const t = state.task_sessions[taskKey];
  if (!t) throw new Error(`Unknown task: ${taskKey}`);
  t.status = "blocked";
  t.last_error = reason;
  if (!t.completed_at) {
    t.completed_at = new Date().toISOString();
  }
  state.consecutive_failures += 1;

  if (state.current_task === taskKey) {
    state.current_task = null;
  }
}

/** Pick the next actionable task. Respects dependencies. */
export function pickNextTask(state: BoulderState): string | null {
  // First: retry failed tasks (not blocked)
  for (const [key, t] of Object.entries(state.task_sessions)) {
    if (t.status === "failed" && t.attempts < t.max_attempts) {
      if (areDependenciesMet(state, key)) return key;
    }
  }
  // Then: pick pending
  for (const [key, t] of Object.entries(state.task_sessions)) {
    if (t.status === "pending") {
      if (areDependenciesMet(state, key)) return key;
    }
  }
  return null;
}

function areDependenciesMet(state: BoulderState, taskKey: string): boolean {
  const t = state.task_sessions[taskKey];
  if (!t?.dependencies?.length) return true;
  return t.dependencies.every((depKey) => {
    const dep = state.task_sessions[depKey];
    return dep && (dep.status === "done" || dep.status === "skipped");
  });
}

/** Check if all tasks are terminal (done | blocked | skipped) */
export function isLoopComplete(state: BoulderState): boolean {
  return Object.values(state.task_sessions).every(
    (t) => t.status === "done" || t.status === "blocked" || t.status === "skipped"
  );
}

/** Check if loop should halt due to consecutive failures */
export function shouldHalt(state: BoulderState): boolean {
  if (state.iteration >= state.max_iterations) return true;
  if (state.consecutive_failures >= state.max_consecutive_failures) return true;
  // All remaining tasks are blocked
  const remaining = Object.values(state.task_sessions).filter(
    (t) => t.status !== "done" && t.status !== "skipped"
  );
  return remaining.length > 0 && remaining.every((t) => t.status === "blocked");
}

// ---------------------------------------------------------------------------
// Plan Parsing
// ---------------------------------------------------------------------------

export async function parsePlan(planPath: string): Promise<Plan> {
  const raw = await readFile(planPath, "utf-8");
  const name = basename(planPath, ".md");

  // Extract sections
  const tldr = extractSection(raw, "TL;DR") || extractSection(raw, "TLDR") || "";
  const context = extractSection(raw, "Context") || "";
  const objectives = extractSection(raw, "Work Objectives") || "";
  const verification = extractSection(raw, "Verification Strategy") || "";

  // Parse TODOs
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

function extractSection(md: string, heading: string): string {
  // Match ## Heading or ### Heading
  const regex = new RegExp(
    `^#{1,3}\\s+${escapeRegex(heading)}\\s*$`,
    "mi"
  );
  const match = regex.exec(md);
  if (!match) return "";

  const startIdx = match.index + match[0].length;
  // Find next heading of same or higher level
  const level = (match[0].match(/^#+/) || ["##"])[0].length;
  const nextHeading = new RegExp(`^#{1,${level}}\\s+`, "m");
  const rest = md.slice(startIdx);
  const nextMatch = nextHeading.exec(rest);
  const endIdx = nextMatch ? nextMatch.index : rest.length;

  return rest.slice(0, endIdx).trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseTodos(planContent: string): PlanTask[] {
  const tasks: PlanTask[] = [];

  // Match TODO items: "- [ ] N. Title" or "- [ ] Title"
  // Capture everything until the next "- [ ]" or "- [x]" or end of TODOs section
  const todoSection =
    extractSection(planContent, "TODOs") ||
    extractSection(planContent, "Tasks") ||
    planContent;

  const todoRegex = /^- \[[ x]\]\s*(?:(\d+)\.\s*)?(.+)$/gm;
  let match: RegExpExecArray | null;
  const rawTodos: { index: number; title: string; lineStart: number; bodyStart: number }[] = [];

  while ((match = todoRegex.exec(todoSection)) !== null) {
    const idx = match[1] ? parseInt(match[1], 10) : rawTodos.length + 1;
    rawTodos.push({
      index: idx,
      title: match[2].trim(),
      lineStart: match.index,
      bodyStart: todoRegex.lastIndex,
    });
  }

  for (let i = 0; i < rawTodos.length; i++) {
    const start = rawTodos[i].bodyStart;
    const end = i + 1 < rawTodos.length ? rawTodos[i + 1].lineStart : todoSection.length;
    const body = todoSection.slice(start, end).trim();

    const task: PlanTask = {
      index: rawTodos[i].index,
      key: `todo:${rawTodos[i].index}`,
      title: rawTodos[i].title,
      description: body || rawTodos[i].title,
      acceptance_criteria: extractBoldSection(body, "Acceptance Criteria"),
      references: extractBoldSection(body, "References"),
      must_not_do: extractBoldSection(body, "Must NOT do"),
      dependencies: parseDependencies(body),
    };
    tasks.push(task);
  }

  return tasks;
}

function extractBoldSection(body: string, label: string): string {
  const regex = new RegExp(`\\*\\*${escapeRegex(label)}\\*\\*:\\s*(.+?)(?=\\n\\s*\\*\\*|$)`, "s");
  const m = regex.exec(body);
  return m ? m[1].trim() : "";
}

function parseDependencies(body: string): string[] | undefined {
  const m = /\*\*Depends on\*\*:\s*(.+)/i.exec(body);
  if (!m) return undefined;
  const deps = m[1].match(/todo:\d+/g);
  return deps || undefined;
}

// ---------------------------------------------------------------------------
// Handoff Files — Per-loop instance
// ---------------------------------------------------------------------------

export async function writeHandoff(
  workdir: string,
  loopId: string,
  handoff: HandoffFile
): Promise<string> {
  const dir = handoffsDir(workdir, loopId);
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

export async function readHandoff(
  workdir: string,
  loopId: string,
  taskKey: string
): Promise<HandoffFile | null> {
  const fileName = `${taskKey.replace(":", "-")}-handoff.md`;
  const filePath = join(handoffsDir(workdir, loopId), fileName);
  if (!existsSync(filePath)) return null;

  const raw = await readFile(filePath, "utf-8");
  return parseHandoff(raw);
}

export async function readLatestHandoff(
  workdir: string,
  loopId: string
): Promise<HandoffFile | null> {
  const dir = handoffsDir(workdir, loopId);
  if (!existsSync(dir)) return null;

  const files = (await readdir(dir)).filter((f) => f.endsWith("-handoff.md"));

  if (files.length === 0) return null;

  files.sort((a, b) => {
    const numA = parseInt((a.match(/todo-(\d+)-handoff\.md$/)?.[1] || "0"), 10);
    const numB = parseInt((b.match(/todo-(\d+)-handoff\.md$/)?.[1] || "0"), 10);
    return numA - numB;
  });

  const latest = files[files.length - 1];
  const raw = await readFile(join(dir, latest), "utf-8");
  return parseHandoff(raw);
}

function parseHandoff(raw: string): HandoffFile {
  // Parse frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";

  const meta: HandoffMeta = {
    task_key: extractFmValue(fm, "task_key"),
    task_title: extractFmValue(fm, "task_title").replace(/^"|"$/g, ""),
    status: extractFmValue(fm, "status") as HandoffMeta["status"],
    attempts: parseInt(extractFmValue(fm, "attempts") || "1", 10),
    completed_at: extractFmValue(fm, "completed_at").replace(/^"|"$/g, ""),
  };

  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

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

function extractFmValue(fm: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
  return m ? m[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Notepad System — Per-loop instance
// ---------------------------------------------------------------------------

export async function readNotepad(
  workdir: string,
  loopId: string,
  noteType: "learnings" | "decisions" | "issues"
): Promise<string> {
  const p = join(notepadsDir(workdir, loopId), `${noteType}.md`);
  if (!existsSync(p)) return "";
  return readFile(p, "utf-8");
}

export async function appendNotepad(
  workdir: string,
  loopId: string,
  noteType: "learnings" | "decisions" | "issues",
  content: string
): Promise<void> {
  const dir = notepadsDir(workdir, loopId);
  await ensureDir(dir);
  const p = join(dir, `${noteType}.md`);

  const existing = existsSync(p) ? await readFile(p, "utf-8") : "";
  const timestamp = new Date().toISOString().slice(0, 19);
  const appended = `${existing}\n\n### [${timestamp}]\n${content}`.trim();
  await writeFile(p, appended + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}
