import { describe, expect, it } from "vitest";
import { SchemaValidator } from "../src/planner/schema-validator";
import type { PlannerRequestV1, PlannerResponseV1 } from "../../../contracts/planner";
import type { SnapshotV1 } from "../../../contracts/snapshot";

const snapshot: SnapshotV1 = {
  bot_id: "bot-1",
  time: { tick: 10, day_phase: "day" },
  player: {
    position: { x: 0, y: 64, z: 0 },
    dimension: "overworld",
    health: 20,
    hunger: 20,
    status_effects: []
  },
  inventory_summary: {
    food_total: 4,
    tools: { stone_pickaxe: 1 },
    blocks: 10,
    key_items: { oak_log: 12 }
  },
  nearby_summary: {
    hostiles: [],
    resources: [],
    points_of_interest: []
  },
  task_context: {
    current_goal: null,
    current_subgoal: null,
    progress_counters: {}
  }
};

describe("SchemaValidator", () => {
  const validator = new SchemaValidator();

  it("accepts valid request/response", () => {
    const request: PlannerRequestV1 = {
      bot_id: "bot-1",
      snapshot,
      history: [],
      available_subgoals: ["goto", "collect", "explore"]
    };

    const response: PlannerResponseV1 = {
      next_goal: "collect_logs",
      subgoals: [
        {
          name: "collect",
          params: { block: "oak_log", count: 16 },
          success_criteria: { item_count_gte: 16 }
        }
      ]
    };

    expect(() => validator.validatePlannerRequest(request)).not.toThrow();
    expect(() => validator.validatePlannerResponse(response)).not.toThrow();
    expect(() => validator.validateSnapshot(snapshot)).not.toThrow();
  });

  it("rejects unknown subgoal", () => {
    const invalid: PlannerResponseV1 = {
      next_goal: "invalid",
      subgoals: [
        {
          name: "invalid_subgoal" as never,
          params: {},
          success_criteria: {}
        }
      ]
    };

    expect(() => validator.validatePlannerResponse(invalid)).toThrow();
  });
});
