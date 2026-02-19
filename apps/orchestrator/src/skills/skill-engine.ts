import type { PlannerSubgoal } from "../../../../contracts/planner";
import type { SkillResultV1, SubgoalName } from "../../../../contracts/skills";
import { beginHeartbeat, failure } from "./helpers";
import type { SkillExecutionContext } from "./context";
import { buildBlueprintSkill } from "./build-blueprint";
import { collectSkill } from "./collect";
import { combatEngageSkill } from "./combat-engage";
import { combatGuardSkill } from "./combat-guard";
import { craftSkill } from "./craft";
import { depositSkill } from "./deposit";
import { exploreSkill } from "./explore";
import { gotoNearestSkill } from "./goto-nearest";
import { gotoSkill } from "./goto";
import { smeltSkill } from "./smelt";
import { withdrawSkill } from "./withdraw";

const handlerMap: Record<SubgoalName, (ctx: SkillExecutionContext, params: Record<string, unknown>) => Promise<SkillResultV1>> = {
  explore: exploreSkill,
  goto: gotoSkill,
  goto_nearest: gotoNearestSkill,
  collect: collectSkill,
  craft: craftSkill,
  smelt: smeltSkill,
  deposit: depositSkill,
  withdraw: withdrawSkill,
  build_blueprint: buildBlueprintSkill,
  combat_engage: combatEngageSkill,
  combat_guard: combatGuardSkill
};

const lockKeyForSubgoal = (subgoal: PlannerSubgoal): string | null => {
  if (subgoal.name === "collect") {
    const target = String(subgoal.params.item ?? subgoal.params.block ?? "");
    return target ? `resource:${target}` : null;
  }

  if (subgoal.name === "build_blueprint") {
    const anchorX = subgoal.params.anchor_x;
    const anchorY = subgoal.params.anchor_y;
    const anchorZ = subgoal.params.anchor_z;
    if (
      typeof anchorX === "number" &&
      typeof anchorY === "number" &&
      typeof anchorZ === "number"
    ) {
      return `build:${anchorX},${anchorY},${anchorZ}`;
    }
  }

  if (subgoal.name === "deposit" || subgoal.name === "withdraw") {
    return "storage:base";
  }

  return null;
};

export class SkillEngine {
  async execute(ctx: SkillExecutionContext, subgoal: PlannerSubgoal): Promise<SkillResultV1> {
    const handler = handlerMap[subgoal.name];
    if (!handler) {
      return failure("DEPENDS_ON_ITEM", `unsupported subgoal ${subgoal.name}`, false);
    }

    const lockKey = lockKeyForSubgoal(subgoal);
    let lockHeartbeat: { stop: () => void } | null = null;

    if (lockKey) {
      const acquired = ctx.lockManager.acquire(lockKey, ctx.botId);
      if (!acquired) {
        return failure("DEPENDS_ON_ITEM", `resource locked: ${lockKey}`, true);
      }
      lockHeartbeat = beginHeartbeat(ctx, lockKey);
    }

    try {
      return await handler(ctx, subgoal.params);
    } catch (error) {
      if (typeof error === "object" && error && "errorCode" in error) {
        return error as SkillResultV1;
      }
      return failure(
        "DEPENDS_ON_ITEM",
        error instanceof Error ? error.message : "unknown skill execution error"
      );
    } finally {
      lockHeartbeat?.stop();
      if (lockKey) {
        ctx.lockManager.release(lockKey, ctx.botId);
      }
    }
  }
}
