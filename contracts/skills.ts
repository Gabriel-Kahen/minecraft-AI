export const FAILURE_CODES = [
  "RESOURCE_NOT_FOUND",
  "PATHFIND_FAILED",
  "NO_TOOL_AVAILABLE",
  "INVENTORY_FULL",
  "INTERRUPTED_BY_HOSTILES",
  "PLACEMENT_FAILED",
  "STUCK_TIMEOUT",
  "DEPENDS_ON_ITEM",
  "COMBAT_LOST_TARGET",
  "BOT_DIED"
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export const SUBGOAL_NAMES = [
  "explore",
  "goto",
  "goto_nearest",
  "collect",
  "craft",
  "smelt",
  "deposit",
  "withdraw",
  "build_blueprint",
  "combat_engage",
  "combat_guard"
] as const;

export type SubgoalName = (typeof SUBGOAL_NAMES)[number];

export interface SkillRequestV1<TParams extends Record<string, unknown> = Record<string, unknown>> {
  botId: string;
  subgoal: {
    name: SubgoalName;
    params: TParams;
    success_criteria: Record<string, unknown>;
  };
  deadlineAt: string;
}

export interface SkillFailure {
  outcome: "FAILURE";
  errorCode: FailureCode;
  details: string;
  retryable: boolean;
}

export interface SkillSuccess {
  outcome: "SUCCESS";
  details: string;
  metrics?: Record<string, number>;
}

export type SkillResultV1 = SkillSuccess | SkillFailure;
