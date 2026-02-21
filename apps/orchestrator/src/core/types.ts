import type { ActionHistoryEntry, PlannerSubgoal } from "../../../../contracts/planner";
import type { FailureCode } from "../../../../contracts/skills";

export type PlannerTrigger =
  | "IDLE"
  | "SUBGOAL_COMPLETED"
  | "SUBGOAL_FAILED"
  | "ATTACKED"
  | "DEATH"
  | "STUCK"
  | "NIGHTFALL"
  | "INVENTORY_FULL"
  | "TOOL_MISSING"
  | "RECONNECT";

export interface RuntimeSubgoal extends PlannerSubgoal {
  id: string;
  assignedAt: string;
}

export interface RuntimeTaskState {
  currentGoal: string | null;
  currentSubgoal: RuntimeSubgoal | null;
  queue: RuntimeSubgoal[];
  progressCounters: Record<string, number>;
  lastError: {
    code: FailureCode;
    details: string;
  } | null;
  busy: boolean;
  plannerCooldownUntil: number;
  pendingTriggers: PlannerTrigger[];
  history: ActionHistoryEntry[];
}
