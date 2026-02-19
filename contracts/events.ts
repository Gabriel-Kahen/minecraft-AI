import type { FailureCode, SkillResultV1, SubgoalName } from "./skills";

export interface BotEventV1 {
  ts: string;
  botId: string;
  type:
    | "CONNECTED"
    | "DISCONNECTED"
    | "GOAL_ASSIGNED"
    | "SUBGOAL_STARTED"
    | "SUBGOAL_FINISHED"
    | "PLANNER_CALLED"
    | "PLANNER_RATE_LIMITED"
    | "PLANNER_FALLBACK"
    | "INTERRUPT"
    | "INCIDENT";
  payload: Record<string, unknown>;
}

export interface SubgoalAttemptRecord {
  id: string;
  botId: string;
  subgoal: SubgoalName;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  result: SkillResultV1;
}

export interface PlannerCallRecord {
  id: string;
  botId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "SUCCESS" | "ERROR" | "RATE_LIMITED" | "FALLBACK";
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface IncidentRecord {
  id: string;
  botId: string;
  ts: string;
  category: "DEATH" | "RECONNECT" | "STUCK" | "COMBAT" | "UNKNOWN";
  errorCode?: FailureCode;
  details: string;
}

export interface RunMetricsV1 {
  ts: string;
  activeBots: number;
  llmCallsPerHour: number;
  failureRate: number;
  reconnects: number;
  memoryRssMb: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}
