import type { PlannerResponseV1 } from "../../../../contracts/planner";
import type { SnapshotV1 } from "../../../../contracts/snapshot";
import { buildAutonomousProgressionPlan } from "./subgoal-guard";

export interface BasePosition {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export const buildFallbackPlan = (
  snapshot: SnapshotV1,
  reason: string,
  base: BasePosition,
  mcVersion: string
): PlannerResponseV1 => {
  const lowHealth = snapshot.player.health <= 8;
  const hostiles = snapshot.nearby_summary.hostiles;
  const inventoryLoad =
    snapshot.inventory_summary.blocks +
    Object.values(snapshot.inventory_summary.key_items).reduce((sum, count) => sum + count, 0);

  if (lowHealth) {
    return {
      next_goal: "stabilize_and_recover",
      risk_flags: [reason, "LOW_HEALTH"],
      subgoals: [
        {
          name: "goto",
          params: { x: base.x, y: base.y, z: base.z, range: base.radius },
          success_criteria: { within_range: base.radius }
        },
        {
          name: "combat_guard",
          params: { radius: 12, duration_ms: 6000 },
          success_criteria: { no_hostiles_within: 12 }
        }
      ]
    };
  }

  if (inventoryLoad >= 120) {
    return {
      next_goal: "deposit_inventory",
      risk_flags: [reason, "INVENTORY_PRESSURE"],
      subgoals: [
        {
          name: "goto",
          params: { x: base.x, y: base.y, z: base.z, range: base.radius },
          success_criteria: { within_range: base.radius }
        },
        {
          name: "deposit",
          params: { strategy: "all_non_essential" },
          success_criteria: { free_slots_min: 16 }
        }
      ]
    };
  }

  if (hostiles.length > 0 && hostiles[0] && hostiles[0].distance < 10) {
    return {
      next_goal: "clear_local_threats",
      risk_flags: [reason, "HOSTILES_NEARBY"],
      subgoals: [
        {
          name: "combat_engage",
          params: { max_targets: 2, max_distance: 18 },
          success_criteria: { hostiles_within: 10, equals: 0 }
        }
      ]
    };
  }

  const progression = buildAutonomousProgressionPlan(snapshot, mcVersion, 8);
  return {
    next_goal: progression.reason,
    subgoals: progression.subgoals,
    risk_flags: [reason]
  };
};
