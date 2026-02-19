import type { LockManager } from "../coordination";
import type { ExplorerLimiter } from "../coordination";
import type { JsonlLogger } from "../store";

export interface SkillExecutionContext {
  botId: string;
  bot: any;
  lockManager: LockManager;
  explorerLimiter: ExplorerLimiter;
  logger: JsonlLogger;
  base: {
    x: number;
    y: number;
    z: number;
    radius: number;
  };
  lockHeartbeatMs: number;
  blueprintRoot: string;
}
