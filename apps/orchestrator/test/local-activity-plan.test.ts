import { describe, expect, it } from "vitest";
import { buildLocalActivityPlan } from "../src/core/local-activity-plan";
import type { SnapshotV1 } from "../../../contracts/snapshot";

const baseSnapshot = (): SnapshotV1 => ({
  bot_id: "bot-1",
  time: { tick: 100, day_phase: "day" },
  player: {
    position: { x: 0, y: 64, z: 0 },
    dimension: "overworld",
    health: 20,
    hunger: 20,
    status_effects: []
  },
  inventory_summary: {
    food_total: 0,
    tools: {},
    blocks: 0,
    key_items: {}
  },
  nearby_summary: {
    hostiles: [],
    resources: [{ type: "oak_log", distance: 5, position: { x: 2, y: 64, z: 2 } }],
    points_of_interest: []
  },
  task_context: {
    current_goal: null,
    current_subgoal: null,
    progress_counters: {},
    last_error: null
  }
});

describe("buildLocalActivityPlan", () => {
  it("chooses autonomous progression for empty inventory", () => {
    const plan = buildLocalActivityPlan(baseSnapshot(), "1.20.4");
    expect(plan.reason.startsWith("acquire_") || plan.reason === "explore_for_resources").toBe(true);
    expect(plan.subgoals[0]?.name).toBe("goto_nearest");
    expect(plan.subgoals[1]?.name).toBe("collect");
  });

  it("chooses combat guard when health is low", () => {
    const snapshot = baseSnapshot();
    snapshot.player.health = 6;
    const plan = buildLocalActivityPlan(snapshot, "1.20.4");
    expect(plan.reason).toBe("survival_stabilization");
    expect(plan.subgoals[0]?.name).toBe("combat_guard");
  });
});
