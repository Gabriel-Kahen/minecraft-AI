import type { FailureCode } from "./skills";

export interface SnapshotV1 {
  bot_id: string;
  time: {
    tick: number;
    day_phase: "dawn" | "day" | "dusk" | "night";
  };
  player: {
    position: {
      x: number;
      y: number;
      z: number;
    };
    dimension: string;
    health: number;
    hunger: number;
    status_effects: string[];
  };
  inventory_summary: {
    food_total: number;
    tools: Record<string, number>;
    blocks: number;
    key_items: Record<string, number>;
  };
  nearby_summary: {
    hostiles: Array<{
      type: string;
      distance: number;
    }>;
    resources: Array<{
      type: string;
      distance: number;
      position: {
        x: number;
        y: number;
        z: number;
      };
    }>;
    points_of_interest: Array<{
      type: string;
      distance: number;
      position: {
        x: number;
        y: number;
        z: number;
      };
    }>;
  };
  task_context: {
    current_goal: string | null;
    current_subgoal: string | null;
    progress_counters: Record<string, number>;
    last_error?: {
      code: FailureCode;
      details: string;
    } | null;
  };
}
