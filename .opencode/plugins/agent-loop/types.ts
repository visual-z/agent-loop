// =============================================================================
// Agent Loop — Core Types
// =============================================================================

/** Task lifecycle states */
export type TaskStatus =
  | "pending"
  | "in-progress"
  | "done"
  | "failed"
  | "blocked"
  | "skipped";

/** Overall loop states */
export type LoopStatus =
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "halted";

/** A single task session entry in boulder.json */
export interface TaskSession {
  task_key: string; // "todo:1", "todo:2", etc.
  task_title: string;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  started_at?: string;
  completed_at?: string;
  last_error?: string;
  worker_session_id?: string;
  dependencies?: string[]; // task_keys this depends on
}

/** Backpressure gate result */
export interface GateResult {
  passed: boolean;
  build: { passed: boolean; output: string } | null;
  test: { passed: boolean; output: string } | null;
  lint: { passed: boolean; output: string } | null;
  timestamp: string;
}

/** Aggregate stats */
export interface LoopStats {
  total_tasks: number;
  done: number;
  in_progress: number;
  failed: number;
  blocked: number;
  skipped: number;
  pending: number;
  backpressure_failures: number;
  total_attempts: number;
}

/** Plugin runtime state across orchestrator sessions */
export interface LoopRuntimeState {
  active: boolean;
  session_id: string | null;
  iteration: number;
  max_iterations_per_session: number;
  total_iterations: number;
  max_total_iterations: number;
  started_at: string;
  last_continued_at: string | null;
  last_state_hash: string | null;
  stall_count: number;
  stall_threshold: number;
  pending_save_progress: boolean;
  context_pressure_threshold: number;
}

/** Pointer file (.agent-loop/active-loop.json) — tracks which loop is active */
export interface ActiveLoopPointer {
  loop_id: string;
  activated_at: string;
}

/** Summary of a loop instance for listing */
export interface LoopSummary {
  loop_id: string;
  plan_name: string;
  status: LoopStatus;
  progress: string;
  started_at: string;
  updated_at: string;
}

/** The boulder.json root shape */
export interface BoulderState {
  // Identity
  loop_id: string; // unique ID for this loop instance (= plan name)
  active_plan: string; // path to plan file
  plan_name: string;
  started_at: string;
  updated_at: string;

  // Loop control
  iteration: number;
  max_iterations: number;
  status: LoopStatus;
  completion_promise: string;

  // Current execution
  current_task: string | null; // "todo:3" or null
  orchestrator_session_id: string | null;
  last_worker_session_id: string | null;

  // Task registry
  task_sessions: Record<string, TaskSession>;

  // Stats
  stats: LoopStats;

  // Error escalation
  consecutive_failures: number;
  max_consecutive_failures: number;
}

/** Frontmatter in handoff files */
export interface HandoffMeta {
  task_key: string;
  task_title: string;
  status: "done" | "failed" | "blocked";
  attempts: number;
  completed_at: string;
}

/** Parsed handoff file */
export interface HandoffFile {
  meta: HandoffMeta;
  what_was_done: string;
  key_decisions: string;
  files_changed: string;
  test_results: string;
  learnings: string;
  final_response: string;
  blocked_issues: string;
  next_task_context: string;
}

/** Plan TODO item parsed from markdown */
export interface PlanTask {
  index: number; // 1-based
  key: string; // "todo:1"
  title: string;
  description: string; // full block under the TODO
  task_type?: "spike" | "impl" | "verify";
  parallel_group?: string | null;
  file_paths?: string[];
  acceptance_criteria: string;
  references: string;
  must_not_do: string;
  dependencies?: string[]; // parsed dependency keys
}

/** Parsed plan file */
export interface Plan {
  name: string;
  path: string;
  tldr: string;
  context: string;
  objectives: string;
  verification_strategy: string;
  tasks: PlanTask[];
}

/**
 * Worker dispatch payload — the minimal context a worker receives.
 */
export interface WorkerPayload {
  task: PlanTask;
  notepad_learnings: string;
  notepad_decisions: string;
  notepad_issues: string;
  previous_handoff_context: string; // "Next Task Context" from previous handoff
  relevant_file_paths: string[];
  project_conventions: string; // brief summary of project patterns
  backpressure_command: string; // what to run for verification
}

/** Continuation prompt injected after worker completes */
export interface ContinuationContext {
  completed_task_key: string;
  completed_task_title: string;
  handoff_summary: string;
  gate_result: GateResult;
  next_task_key: string | null;
  next_task_title: string | null;
  iteration: number;
  progress: string; // "3/8 tasks complete"
  /** All task_keys whose dependencies are satisfied right now */
  ready_tasks?: { task_key: string; task_title: string }[];
  /** Tasks currently in flight */
  in_progress_tasks?: { task_key: string; task_title: string }[];
}
