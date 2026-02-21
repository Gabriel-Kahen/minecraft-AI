import type { PlannerSubgoal } from "../../../../contracts/planner";

export interface NormalizedSubgoals {
  subgoals: PlannerSubgoal[];
  notes: string[];
}

const asPositiveInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
};

const asFiniteNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const pickString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const normalizeCollect = (subgoal: PlannerSubgoal): PlannerSubgoal | null => {
  const target = pickString(
    subgoal.params.item,
    subgoal.params.block,
    subgoal.params.resource,
    subgoal.params.resource_type,
    subgoal.params.type
  );
  if (!target) {
    return null;
  }

  const params: Record<string, unknown> = {
    block: target,
    count: asPositiveInt(
      subgoal.params.count ?? subgoal.params.amount ?? subgoal.params.qty,
      1
    )
  };
  if (Number.isFinite(Number(subgoal.params.max_distance))) {
    params.max_distance = asPositiveInt(subgoal.params.max_distance, 48);
  }
  return {
    ...subgoal,
    params
  };
};

const normalizeGotoNearest = (subgoal: PlannerSubgoal): PlannerSubgoal | null => {
  const target = pickString(
    subgoal.params.block,
    subgoal.params.resource,
    subgoal.params.resource_type,
    subgoal.params.type
  );
  if (!target) {
    return null;
  }

  return {
    ...subgoal,
    params: {
      block: target,
      max_distance: asPositiveInt(subgoal.params.max_distance, 48)
    }
  };
};

const normalizeCraftLike = (
  subgoal: PlannerSubgoal,
  key: "item" | "input"
): PlannerSubgoal | null => {
  const target = pickString(
    subgoal.params.item,
    subgoal.params.output,
    subgoal.params.result,
    subgoal.params.type,
    subgoal.params.input,
    subgoal.params.resource
  );
  if (!target) {
    return null;
  }

  const params: Record<string, unknown> = {
    [key]: target,
    count: asPositiveInt(
      subgoal.params.count ?? subgoal.params.amount ?? subgoal.params.qty,
      1
    )
  };
  if (key === "input" && typeof subgoal.params.fuel === "string") {
    params.fuel = subgoal.params.fuel;
  }
  return {
    ...subgoal,
    params
  };
};

const normalizeGoto = (subgoal: PlannerSubgoal): PlannerSubgoal | null => {
  const location =
    typeof subgoal.params.location === "object" && subgoal.params.location
      ? (subgoal.params.location as Record<string, unknown>)
      : null;

  const x = asFiniteNumber(subgoal.params.x ?? location?.x, Number.NaN);
  const y = asFiniteNumber(subgoal.params.y ?? location?.y, Number.NaN);
  const z = asFiniteNumber(subgoal.params.z ?? location?.z, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }

  return {
    ...subgoal,
    params: {
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      range: asPositiveInt(subgoal.params.range, 2)
    }
  };
};

export const normalizePlannerSubgoals = (
  subgoals: PlannerSubgoal[]
): NormalizedSubgoals => {
  const normalized: PlannerSubgoal[] = [];
  const notes: string[] = [];

  for (let index = 0; index < subgoals.length; index += 1) {
    const subgoal = subgoals[index];
    let mapped: PlannerSubgoal | null = subgoal;

    switch (subgoal.name) {
      case "collect":
        mapped = normalizeCollect(subgoal);
        break;
      case "goto_nearest":
        mapped = normalizeGotoNearest(subgoal);
        break;
      case "craft":
      case "withdraw":
        mapped = normalizeCraftLike(subgoal, "item");
        break;
      case "smelt":
        mapped = normalizeCraftLike(subgoal, "input");
        break;
      case "goto":
        mapped = normalizeGoto(subgoal);
        break;
      default:
        mapped = subgoal;
    }

    if (!mapped) {
      notes.push(`dropped_invalid_subgoal_${index}_${subgoal.name}`);
      continue;
    }

    normalized.push(mapped);
    if (mapped !== subgoal) {
      notes.push(`normalized_subgoal_${index}_${subgoal.name}`);
    }
  }

  return {
    subgoals: normalized,
    notes
  };
};
