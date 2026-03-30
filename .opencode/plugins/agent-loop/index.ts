// =============================================================================
// Agent Loop Plugin — Package entry point
// =============================================================================

export { AgentLoopPlugin, default } from "./plugin";
export type {
  BoulderState,
  TaskSession,
  TaskStatus,
  LoopStatus,
  LoopRuntimeState,
  HandoffFile,
  HandoffMeta,
  PlanTask,
  Plan,
  WorkerPayload,
  ContinuationContext,
  GateResult,
  LoopStats,
} from "./types";
