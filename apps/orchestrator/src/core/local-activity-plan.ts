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
  const closeHostileCount = snapshot.nearby_summary.hostiles.filter((hostile) => hostile.distance <= 8).length;
  const lowHealth = snapshot.player.health <= 8;
  const criticalDanger = closeHostileCount >= 2 || (lowHealth && closeHostileCount >= 1);

  if (criticalDanger) {
    return {
      reason: "flee_then_stabilize",
      subgoals: [
        {
          name: "combat_guard",
          params: { radius: 12, duration_ms: 7000 },
          success_criteria: { no_hostiles_within: 8 }
        }
      ]
    };
  }

  if (nearbyHostile && nearbyHostile.distance < 9 && snapshot.player.health >= 11) {
    return {
      reason: "clear_local_hostile",
      subgoals: [
        {
          name: "combat_engage",
          params: { target_mode: "hostile", max_distance: 16, timeout_ms: 9000 },
          success_criteria: { hostiles_within: 8, equals: 0 }
        }
      ]
    };
  }

  const foodPressure =
    snapshot.player.hunger <= 8 &&
    snapshot.inventory_summary.food_total <= 1 &&
    snapshot.player.health >= 12;
  if (foodPressure && closeHostileCount === 0) {
    return {
      reason: "acquire_food_from_animals",
      subgoals: [
        {
          name: "combat_engage",
          params: { target_mode: "animal", max_distance: 28, timeout_ms: 12000 },
          success_criteria: { action_complete: true }
        },
        {
          name: "explore",
          params: { radius: 18, return_to_base: false, max_waypoints: 3, attempt_timeout_ms: 10000 },
          success_criteria: { explored_points_min: 1 }
        }
      ]
    };
  }

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
