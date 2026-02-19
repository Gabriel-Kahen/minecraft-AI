import type { SkillResultV1 } from "../../../../contracts/skills";
import type { SkillExecutionContext } from "./context";
import { asSkillFailure, failure, findNearestBlock, success } from "./helpers";

export const smeltSkill = async (
  ctx: SkillExecutionContext,
  params: Record<string, unknown>
): Promise<SkillResultV1> => {
  const inputName = String(params.input ?? "");
  const fuelName = String(params.fuel ?? "coal");
  const count = Number(params.count ?? 1);

  if (!inputName) {
    return failure("DEPENDS_ON_ITEM", "smelt requires input item name", false);
  }

  const mcData = require("minecraft-data")(ctx.bot.version);
  const input = mcData.itemsByName[inputName];
  const fuel = mcData.itemsByName[fuelName];
  if (!input || !fuel) {
    return failure("DEPENDS_ON_ITEM", "unknown input or fuel", false);
  }

  const furnaceBlock = findNearestBlock(ctx, "furnace", 12);
  if (!furnaceBlock) {
    return failure("DEPENDS_ON_ITEM", "no furnace nearby", true);
  }

  try {
    const furnace = await ctx.bot.openFurnace(furnaceBlock);
    await furnace.putInput(input.id, null, count);
    await furnace.putFuel(fuel.id, null, Math.max(1, Math.ceil(count / 8)));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await furnace.takeOutput();
    furnace.close();
    return success(`smelted ${count} ${inputName}`);
  } catch (error) {
    return asSkillFailure(error, "DEPENDS_ON_ITEM");
  }
};
