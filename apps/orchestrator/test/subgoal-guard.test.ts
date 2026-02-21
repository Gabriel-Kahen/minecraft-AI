import { describe, expect, it } from "vitest";
import { enforceSubgoalPrerequisites } from "../src/planner/subgoal-guard";
import type { PlannerSubgoal } from "../../../contracts/planner";
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

describe("enforceSubgoalPrerequisites", () => {
  it("injects dependency chain before mining tool-gated resources", () => {
    const snapshot = baseSnapshot();
    const plan: PlannerSubgoal[] = [
      {
        name: "collect",
        params: { type: "stone", amount: 10 },
        success_criteria: { item_count_gte: 10 }
      }
    ];

    const guarded = enforceSubgoalPrerequisites(snapshot, plan);

    expect(guarded.notes.length).toBeGreaterThan(0);
    expect(
      guarded.subgoals.some(
        (subgoal) => subgoal.name === "craft" && String(subgoal.params.item).endsWith("_pickaxe")
      )
    ).toBe(true);
    expect(guarded.subgoals.at(-1)?.name).toBe("collect");
  });

  it("does not inject when a pickaxe is already available", () => {
    const snapshot = baseSnapshot();
    snapshot.inventory_summary.tools.wooden_pickaxe = 1;

    const plan: PlannerSubgoal[] = [
      {
        name: "collect",
        params: { block: "stone", count: 10 },
        success_criteria: { item_count_gte: 10 }
      }
    ];

    const guarded = enforceSubgoalPrerequisites(snapshot, plan);
    expect(guarded.notes).toEqual([]);
    expect(guarded.subgoals).toHaveLength(1);
    expect(guarded.subgoals[0]?.name).toBe("collect");
  });
});
