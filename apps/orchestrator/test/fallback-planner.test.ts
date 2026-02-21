import { describe, expect, it } from "vitest";
import { buildFallbackPlan } from "../src/planner/fallback-planner";
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

describe("buildFallbackPlan", () => {
  it("returns an autonomous progression plan for empty inventory", () => {
    const snapshot = baseSnapshot();
    const plan = buildFallbackPlan(snapshot, "TEST_REASON", { x: 0, y: 64, z: 0, radius: 16 }, "1.20.4");
    expect(plan.next_goal.startsWith("acquire_") || plan.next_goal === "explore_for_resources").toBe(true);
    expect(plan.subgoals[0]?.name).toBe("goto_nearest");
    expect(plan.subgoals[1]?.name).toBe("collect");
  });

  it("still returns executable progression when tools already exist", () => {
    const snapshot = baseSnapshot();
    snapshot.inventory_summary.key_items.oak_log = 8;
    snapshot.inventory_summary.key_items.oak_planks = 16;
    snapshot.inventory_summary.key_items.stick = 8;
    snapshot.inventory_summary.key_items.crafting_table = 1;
    snapshot.inventory_summary.key_items.wooden_pickaxe = 1;
    snapshot.inventory_summary.tools.wooden_pickaxe = 1;

    const plan = buildFallbackPlan(snapshot, "TEST_REASON", { x: 0, y: 64, z: 0, radius: 16 }, "1.20.4");
    expect(plan.subgoals.length).toBeGreaterThan(0);
    expect(["goto_nearest", "collect", "craft", "explore"]).toContain(plan.subgoals[0]?.name);
  });
});
