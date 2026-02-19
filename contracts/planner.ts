import type { SnapshotV1 } from "./snapshot";
import type { FailureCode, SubgoalName } from "./skills";

export interface ActionHistoryEntry {
  timestamp: string;
  subgoal_name: SubgoalName;
  params: Record<string, unknown>;
  outcome: "SUCCESS" | "FAILURE";
  error_code?: FailureCode | null;
  error_details?: string | null;
  inventory_delta?: Record<string, number>;
  health_delta?: number;
  duration_ms: number;
}

export interface PlannerRequestV1 {
  bot_id: string;
  snapshot: SnapshotV1;
  history: ActionHistoryEntry[];
  available_subgoals: SubgoalName[];
  role_hint?: string | null;
}

export interface PlannerSubgoal {
  name: SubgoalName;
  params: Record<string, unknown>;
  success_criteria: Record<string, unknown>;
  role_suggestion?: string | null;
  risk_flags?: string[];
  constraints?: Record<string, unknown>;
}

export interface PlannerResponseV1 {
  next_goal: string;
  subgoals: PlannerSubgoal[];
  role_suggestion?: string | null;
  risk_flags?: string[];
  constraints?: Record<string, unknown>;
}
