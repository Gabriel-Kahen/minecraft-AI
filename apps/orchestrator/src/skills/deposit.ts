import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, findNearestBlock, success } from "./helpers";

const ESSENTIAL_ITEMS = new Set(["bread", "cooked_beef", "stone_sword", "stone_pickaxe", "torch"]);

export const depositSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const strategy = String(params.strategy ?? "all_non_essential");

  const chestBlock = findNearestBlock(ctx, "chest", 16);
  if (!chestBlock) {
    return failure("DEPENDS_ON_ITEM", "no chest nearby for deposit", true);
  }

  try {
    const chest = await ctx.bot.openChest(chestBlock);
    const items = ctx.bot.inventory?.items?.() ?? [];
    let moved = 0;

    for (const item of items) {
      const keep = strategy === "all_non_essential" && ESSENTIAL_ITEMS.has(item.name);
      if (keep) {
        continue;
      }
      await chest.deposit(item.type, item.metadata ?? null, item.count);
      moved += item.count;
    }

    chest.close();
    return success(`deposited ${moved} items`, { deposited: moved });
  } catch (error) {
    return asSkillFailure(error, "INVENTORY_FULL");
  }
};
