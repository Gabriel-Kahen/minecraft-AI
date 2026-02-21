import { describe, expect, it } from "vitest";
import { normalizePlannerSubgoals } from "../src/planner/subgoal-normalizer";
import type { PlannerSubgoal } from "../../../contracts/planner";

describe("normalizePlannerSubgoals", () => {
  it("normalizes alias params into executable collect shape", () => {
    const input: PlannerSubgoal[] = [
      {
        name: "collect",
        params: { type: "stone", amount: 10 },
        success_criteria: { item_count_gte: 10 }
      }
    ];

    const result = normalizePlannerSubgoals(input);
    expect(result.subgoals).toHaveLength(1);
    expect(result.subgoals[0]?.params).toEqual({
      block: "stone",
      count: 10
    });
    expect(result.notes).toContain("normalized_subgoal_0_collect");
  });

  it("drops invalid subgoals with missing required targets", () => {
    const input: PlannerSubgoal[] = [
      {
        name: "goto_nearest",
        params: {},
        success_criteria: { found: true }
      }
    ];

    const result = normalizePlannerSubgoals(input);
    expect(result.subgoals).toEqual([]);
    expect(result.notes).toContain("dropped_invalid_subgoal_0_goto_nearest");
  });

  it("materializes goto coordinates from nested location objects", () => {
    const input: PlannerSubgoal[] = [
      {
        name: "goto",
        params: { location: { x: 10.9, y: 64.1, z: -3.2 } },
        success_criteria: { within_range: 2 }
      }
    ];

    const result = normalizePlannerSubgoals(input);
    expect(result.subgoals[0]?.params).toEqual({
      x: 11,
      y: 64,
      z: -3,
      range: 2
    });
  });
});
