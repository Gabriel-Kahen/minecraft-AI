import type { SnapshotV1 } from "../../../../contracts/snapshot";
import type { PlannerSubgoal } from "../../../../contracts/planner";
import { buildAutonomousProgressionPlan } from "../planner";

export interface LocalActivityPlan {
  reason: string;
  subgoals: PlannerSubgoal[];
}

export const buildLocalActivityPlan = (
  snapshot: SnapshotV1,
  mcVersion: string
): LocalActivityPlan => {
  const nearbyHostile = snapshot.nearby_summary.hostiles[0];
  if (snapshot.player.health <= 8 || (nearbyHostile && nearbyHostile.distance < 6)) {
    return {
      reason: "survival_stabilization",
      subgoals: [
        {
          name: "combat_guard",
          params: { radius: 10, duration_ms: 5000 },
          success_criteria: { no_hostiles_within: 8 }
        }
      ]
    };
  }

  return buildAutonomousProgressionPlan(snapshot, mcVersion, 8);
};
