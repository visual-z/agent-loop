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

import { readFile, writeFile, mkdir, readdir, rename, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, relative } from "path";
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

export function workerPromptsDir(workdir: string, loopId: string): string {
  return join(loopInstanceDir(workdir, loopId), "worker-prompts");
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

/**
 * Mark a task as in-progress. Multi-task safe: `state.current_task` is
 * preserved as a "primary" pointer (back-compat for compaction context and
 * UIs), but the source of truth for which tasks are running is
 * `task_sessions[k].status === "in-progress"`. We only assign current_task if
 * nothing else is currently primary.
 */
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
  if (!state.current_task) state.current_task = taskKey;
  state.iteration += 1;
}

/**
 * If a terminal transition removed the "primary" current_task pointer,
 * promote any remaining in-progress task as the new primary so compaction
 * context and legacy UIs still show something meaningful.
 */
function reassignPrimaryCurrent(state: BoulderState, vacatedKey: string): void {
  if (state.current_task !== vacatedKey) return;
  const stillRunning = inProgressTaskKeys(state);
  state.current_task = stillRunning[0] ?? null;
}

/** Mark task as done */
export function markTaskDone(state: BoulderState, taskKey: string): void {
  const t = state.task_sessions[taskKey];
  if (!t) throw new Error(`Unknown task: ${taskKey}`);
  t.status = "done";
  t.completed_at = new Date().toISOString();
  state.consecutive_failures = 0;
  reassignPrimaryCurrent(state, taskKey);
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

  reassignPrimaryCurrent(state, taskKey);
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

  reassignPrimaryCurrent(state, taskKey);
}

/**
 * Compare two task keys ("todo:1" < "todo:2" < ... < "todo:10") by index.
 * String compare alone gets wrong order at 10+.
 */
function compareTaskKeys(a: string, b: string): number {
  const na = parseInt(a.replace(/^todo:/, ""), 10);
  const nb = parseInt(b.replace(/^todo:/, ""), 10);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/**
 * Return ALL ready task keys (deps satisfied, status pending or retryable
 * failed). Sorted by todo index. The orchestrator can dispatch them in
 * parallel.
 */
export function pickReadyTasks(
  state: BoulderState,
  max?: number
): string[] {
  const ready: string[] = [];
  // Retryable failures first (so retries get scheduled before fresh tasks)
  for (const [key, t] of Object.entries(state.task_sessions)) {
    if (t.status === "failed" && t.attempts < t.max_attempts) {
      if (areDependenciesMet(state, key)) ready.push(key);
    }
  }
  for (const [key, t] of Object.entries(state.task_sessions)) {
    if (t.status === "pending") {
      if (areDependenciesMet(state, key)) ready.push(key);
    }
  }
  ready.sort(compareTaskKeys);
  if (typeof max === "number" && max > 0) return ready.slice(0, max);
  return ready;
}

/** Backwards-compatible single-task picker. */
export function pickNextTask(state: BoulderState): string | null {
  const ready = pickReadyTasks(state, 1);
  return ready[0] ?? null;
}

/** Tasks currently in flight (status === "in-progress"). */
export function inProgressTaskKeys(state: BoulderState): string[] {
  return Object.entries(state.task_sessions)
    .filter(([, t]) => t.status === "in-progress")
    .map(([key]) => key)
    .sort(compareTaskKeys);
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

// ---------------------------------------------------------------------------
// Plan frontmatter — approval gate
// ---------------------------------------------------------------------------

export interface PlanFrontmatter {
  plan_name?: string;
  revision?: number;
  created_at?: string;
  approved_at?: string;
}

export function parsePlanFrontmatter(raw: string): {
  fm: PlanFrontmatter;
  body: string;
  rawFrontmatter: string;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: raw, rawFrontmatter: "" };

  const block = m[1];
  const fm: PlanFrontmatter = {};
  const planName = block.match(/^plan_name:\s*(.+)$/m)?.[1]?.trim();
  const revision = block.match(/^revision:\s*(\d+)/m)?.[1];
  const createdAt = block.match(/^created_at:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  const approvedAt = block.match(/^approved_at:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  if (planName) fm.plan_name = planName;
  if (revision) fm.revision = parseInt(revision, 10);
  if (createdAt) fm.created_at = createdAt;
  if (approvedAt) fm.approved_at = approvedAt;

  return {
    fm,
    body: raw.slice(m[0].length),
    rawFrontmatter: block,
  };
}

export async function readPlanFrontmatter(
  planPath: string
): Promise<PlanFrontmatter> {
  if (!existsSync(planPath)) return {};
  const raw = await readFile(planPath, "utf-8");
  return parsePlanFrontmatter(raw).fm;
}

/**
 * Stamp the plan file with `approved_at`. Idempotent: if already approved,
 * preserves the original timestamp. Returns the timestamp written.
 */
export async function stampPlanApproved(
  planPath: string
): Promise<{ approved_at: string; revision: number }> {
  const raw = await readFile(planPath, "utf-8");
  const { fm, body } = parsePlanFrontmatter(raw);

  if (fm.approved_at) {
    return {
      approved_at: fm.approved_at,
      revision: fm.revision ?? 1,
    };
  }

  const approvedAt = new Date().toISOString();
  const revision = fm.revision ?? 1;

  // Reconstruct frontmatter, preserving order: plan_name, revision, created_at, approved_at
  const lines: string[] = ["---"];
  if (fm.plan_name) lines.push(`plan_name: ${fm.plan_name}`);
  lines.push(`revision: ${revision}`);
  if (fm.created_at) lines.push(`created_at: "${fm.created_at}"`);
  lines.push(`approved_at: "${approvedAt}"`);
  lines.push("---");
  lines.push("");

  const next = lines.join("\n") + body.replace(/^\n+/, "");
  await writeFile(planPath, next, "utf-8");
  return { approved_at: approvedAt, revision };
}

/**
 * Append a round of user feedback for the plan-architect to consume on the
 * next revision. Stored alongside the plan as `{name}.feedback.md`.
 */
export async function appendPlanFeedback(
  planPath: string,
  feedback: string,
  decision: "edit" | "regenerate"
): Promise<string> {
  const feedbackPath = planPath.replace(/\.md$/, ".feedback.md");
  const existing = existsSync(feedbackPath)
    ? await readFile(feedbackPath, "utf-8")
    : "";
  const ts = new Date().toISOString();
  const block = `\n\n### [${ts}] decision=${decision}\n${feedback.trim()}\n`;
  await writeFile(feedbackPath, (existing + block).trimStart() + "\n", "utf-8");
  return feedbackPath;
}

export async function readPlanFeedback(planPath: string): Promise<string> {
  const feedbackPath = planPath.replace(/\.md$/, ".feedback.md");
  if (!existsSync(feedbackPath)) return "";
  return readFile(feedbackPath, "utf-8");
}

export async function readPlanContent(planPath: string): Promise<string> {
  if (!existsSync(planPath)) return "";
  return readFile(planPath, "utf-8");
}

/**
 * Append a round of question/answer pairs from the user, in response to the
 * architect's CLARIFY_REQUEST. Stored alongside the plan as
 * `{name}.clarifications.md`. The next architect dispatch reads this file
 * and reasons over it before producing the plan.
 */
export interface ClarificationPair {
  question: string;
  answer: string;
}

export async function appendPlanClarifications(
  planPath: string,
  pairs: ClarificationPair[]
): Promise<string> {
  const clarPath = planPath.replace(/\.md$/, ".clarifications.md");
  const existing = existsSync(clarPath) ? await readFile(clarPath, "utf-8") : "";
  const ts = new Date().toISOString();
  const block = [
    "",
    "",
    `### [${ts}] clarification round`,
    ...pairs.flatMap((p, i) => [
      `${i + 1}. **Q**: ${p.question.trim()}`,
      `   **A**: ${p.answer.trim()}`,
    ]),
  ].join("\n");
  await writeFile(clarPath, (existing + block).trimStart() + "\n", "utf-8");
  return clarPath;
}

export async function readPlanClarifications(planPath: string): Promise<string> {
  const clarPath = planPath.replace(/\.md$/, ".clarifications.md");
  if (!existsSync(clarPath)) return "";
  return readFile(clarPath, "utf-8");
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
    const acceptanceCriteria = extractBoldSection(body, "Acceptance Criteria");
    const references = extractBoldSection(body, "References");
    const mustNotDo = extractBoldSection(body, "Must NOT do");

    const task: PlanTask = {
      index: rawTodos[i].index,
      key: `todo:${rawTodos[i].index}`,
      title: rawTodos[i].title,
      description: body || rawTodos[i].title,
      task_type: parseTaskType(body),
      parallel_group: parseParallelGroup(body),
      file_paths: extractPlanFilePaths(
        `${rawTodos[i].title}\n${body}\n${acceptanceCriteria}\n${references}\n${mustNotDo}`
      ),
      acceptance_criteria: acceptanceCriteria,
      references,
      must_not_do: mustNotDo,
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

function parseTaskType(body: string): PlanTask["task_type"] {
  const raw = extractBoldSection(body, "Task Type")
    .replace(/[`*_]/g, "")
    .trim()
    .toLowerCase();
  if (!raw) return undefined;

  const values = raw.match(/\b(spike|impl|verify)\b/g) || [];
  const unique = [...new Set(values)];
  return unique.length === 1 ? (unique[0] as PlanTask["task_type"]) : undefined;
}

function parseParallelGroup(body: string): string | null {
  const raw = extractBoldSection(body, "Parallel Group")
    .split("\n")[0]
    .replace(/[`*_]/g, "")
    .trim();
  if (!raw) return null;
  if (/^(none|n\/a|na|null|optional|tbd|-)\b/i.test(raw)) return null;
  return raw;
}

function extractPlanFilePaths(text: string): string[] {
  const patterns = [
    /`([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`/g,
    /`([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-./]*)`/g,
    /(?:^|[\s(])((?:\.\/)?(?:src|lib|app|test|tests|pkg|web|server|client|api|components|\.opencode|bin)\/[a-zA-Z0-9_\-./]+(?:\.[a-zA-Z0-9]+)?)/g,
  ];

  const paths = new Set<string>();
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      let p = (m[1] || m[0]).trim();
      if (p.startsWith("./")) p = p.slice(2);
      if (!p.includes("/") || p.startsWith("http") || p.startsWith("//")) continue;
      paths.add(p.replace(/\/+$/, ""));
    }
  }
  return [...paths];
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

## Final Response
${handoff.final_response}

## Blocked / Known Issues
${handoff.blocked_issues}

## Next Task Context
${handoff.next_task_context}
`;

  await writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function writeWorkerPrompt(
  workdir: string,
  loopId: string,
  taskKey: string,
  prompt: string
): Promise<{ absolute_path: string; relative_path: string }> {
  const dir = workerPromptsDir(workdir, loopId);
  await ensureDir(dir);
  const safeTaskKey = taskKey.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const filePath = join(dir, `${safeTaskKey}-prompt.md`);
  await writeFile(filePath, prompt, "utf-8");
  return {
    absolute_path: filePath,
    relative_path: relative(workdir, filePath),
  };
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

  const ranked: { file: string; parsed: HandoffFile; timestamp: number }[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseHandoff(raw);
    let timestamp = Date.parse(parsed.meta.completed_at);
    if (!Number.isFinite(timestamp)) {
      try {
        timestamp = (await stat(filePath)).mtimeMs;
      } catch {
        timestamp = 0;
      }
    }
    ranked.push({ file, parsed, timestamp });
  }

  ranked.sort((a, b) => {
    const byTime = a.timestamp - b.timestamp;
    if (byTime !== 0) return byTime;
    return compareTaskKeys(a.parsed.meta.task_key, b.parsed.meta.task_key);
  });

  return ranked[ranked.length - 1]?.parsed ?? null;
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
    final_response: extractSection(body, "Final Response"),
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
