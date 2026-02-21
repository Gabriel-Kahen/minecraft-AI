import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, findNearestBlock, success } from "./helpers";

export const withdrawSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const itemName = String(params.item ?? params.type ?? params.resource ?? "");
  const count = Number(params.count ?? params.amount ?? params.qty ?? 1);
  if (!itemName) {
    return failure("DEPENDS_ON_ITEM", "withdraw requires item name", false);
  }

  const chestBlock = findNearestBlock(ctx, "chest", 16);
  if (!chestBlock) {
    return failure("DEPENDS_ON_ITEM", "no chest nearby for withdraw", true);
  }

  const mcData = require("minecraft-data")(ctx.bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) {
    return failure("DEPENDS_ON_ITEM", `unknown item ${itemName}`, false);
  }

  try {
    const chest = await ctx.bot.openChest(chestBlock);
    await chest.withdraw(item.id, null, count);
    chest.close();
    return success(`withdrew ${count} ${itemName}`, { withdrew: count });
  } catch (error) {
    return asSkillFailure(error, "DEPENDS_ON_ITEM");
  }
};
