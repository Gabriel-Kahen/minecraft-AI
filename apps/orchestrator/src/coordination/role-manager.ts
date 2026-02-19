import type { BotRole } from "../core/types";

const DEFAULT_ROLES: BotRole[] = ["lumber", "miner", "builder", "scout", "hauler_guard"];

export const roleForBotIndex = (index: number): BotRole =>
  DEFAULT_ROLES[index] ?? DEFAULT_ROLES[index % DEFAULT_ROLES.length];
