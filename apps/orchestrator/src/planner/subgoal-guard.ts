import type { PlannerSubgoal } from "../../../../contracts/planner";
import type { SnapshotV1 } from "../../../../contracts/snapshot";

export interface GuardResult {
  subgoals: PlannerSubgoal[];
  notes: string[];
}

const PICKAXE_REQUIRED_BLOCKS = new Set([
  "stone",
  "cobblestone",
  "coal_ore",
  "deepslate_coal_ore",
  "iron_ore",
  "deepslate_iron_ore"
]);

const countItem = (snapshot: SnapshotV1, itemName: string): number =>
  snapshot.inventory_summary.key_items[itemName] ?? 0;

const hasAnyPickaxe = (snapshot: SnapshotV1): boolean => {
  if (Object.keys(snapshot.inventory_summary.tools).some((tool) => tool.endsWith("_pickaxe"))) {
    return true;
  }

  return Object.entries(snapshot.inventory_summary.key_items).some(
    ([itemName, count]) => count > 0 && itemName.endsWith("_pickaxe")
  );
};

const parseTargetName = (params: Record<string, unknown>): string =>
  String(
    params.item ??
      params.block ??
      params.resource ??
      params.resource_type ??
      params.type ??
      ""
  );

const requiresPickaxe = (subgoal: PlannerSubgoal): boolean => {
  if (subgoal.name !== "collect" && subgoal.name !== "goto_nearest") {
    return false;
  }

  const target = parseTargetName(subgoal.params);
  return PICKAXE_REQUIRED_BLOCKS.has(target);
};

const grantsPickaxe = (subgoal: PlannerSubgoal): boolean => {
  if (subgoal.name !== "craft" && subgoal.name !== "withdraw") {
    return false;
  }

  const itemName = parseTargetName(subgoal.params);
  return itemName.endsWith("_pickaxe");
};

const chooseLogType = (snapshot: SnapshotV1): string => {
  const nearby = snapshot.nearby_summary.resources.find((resource) => resource.type.endsWith("_log"));
  if (nearby) {
    return nearby.type;
  }

  const inInventory = Object.entries(snapshot.inventory_summary.key_items).find(
    ([itemName, count]) => count > 0 && itemName.endsWith("_log")
  );
  if (inInventory?.[0]) {
    return inInventory[0];
  }

  return "oak_log";
};

const plankTypeFromLog = (logType: string): string => {
  if (logType.endsWith("_log")) {
    return `${logType.slice(0, -4)}_planks`;
  }
  return "oak_planks";
};

const buildBootstrapSubgoals = (snapshot: SnapshotV1): PlannerSubgoal[] => {
  const logType = chooseLogType(snapshot);
  const plankType = plankTypeFromLog(logType);
  const subgoals: PlannerSubgoal[] = [];

  if (countItem(snapshot, logType) < 3) {
    subgoals.push({
      name: "goto_nearest",
      params: { resource: logType, max_distance: 48 },
      success_criteria: { found: true }
    });
    subgoals.push({
      name: "collect",
      params: { block: logType, count: 3 },
      success_criteria: { item_count_gte: 3 }
    });
  }

  if (countItem(snapshot, plankType) < 9) {
    subgoals.push({
      name: "craft",
      params: { item: plankType, count: 3 },
      success_criteria: { crafted: 3 }
    });
  }

  if (countItem(snapshot, "crafting_table") < 1) {
    subgoals.push({
      name: "craft",
      params: { item: "crafting_table", count: 1 },
      success_criteria: { crafted: 1 }
    });
  }

  if (countItem(snapshot, "stick") < 2) {
    subgoals.push({
      name: "craft",
      params: { item: "stick", count: 1 },
      success_criteria: { crafted: 1 }
    });
  }

  subgoals.push({
    name: "craft",
    params: { item: "wooden_pickaxe", count: 1 },
    success_criteria: { crafted: 1 }
  });

  return subgoals;
};

export const enforceSubgoalPrerequisites = (
  snapshot: SnapshotV1,
  subgoals: PlannerSubgoal[]
): GuardResult => {
  const guarded: PlannerSubgoal[] = [];
  const notes: string[] = [];
  let projectedHasPickaxe = hasAnyPickaxe(snapshot);

  for (const subgoal of subgoals) {
    if (requiresPickaxe(subgoal) && !projectedHasPickaxe) {
      guarded.push(...buildBootstrapSubgoals(snapshot));
      projectedHasPickaxe = true;
      notes.push(`inserted_pickaxe_bootstrap_before_${subgoal.name}`);
    }

    guarded.push(subgoal);
    if (grantsPickaxe(subgoal)) {
      projectedHasPickaxe = true;
    }
  }

  return {
    subgoals: guarded,
    notes
  };
};
