import { rollingHourWindowStart } from "../utils/time";

interface LimitDecision {
  allowed: boolean;
  reason?: "BOT_CAP" | "GLOBAL_CAP";
  retryAfterMs?: number;
}

export class PlannerRateLimiter {
  private readonly perBotCap: number;

  private readonly globalCap: number;

  private readonly botCalls = new Map<string, number[]>();

  private readonly globalCalls: number[] = [];

  constructor(perBotCap: number, globalCap: number) {
    this.perBotCap = perBotCap;
    this.globalCap = globalCap;
  }

  consume(botId: string): LimitDecision {
    const now = Date.now();
    this.prune(now);

    const botTimestamps = this.botCalls.get(botId) ?? [];
    if (botTimestamps.length >= this.perBotCap) {
      const earliest = botTimestamps[0] ?? now;
      return {
        allowed: false,
        reason: "BOT_CAP",
        retryAfterMs: Math.max(1000, earliest + 60 * 60 * 1000 - now)
      };
    }

    if (this.globalCalls.length >= this.globalCap) {
      const earliest = this.globalCalls[0] ?? now;
      return {
        allowed: false,
        reason: "GLOBAL_CAP",
        retryAfterMs: Math.max(1000, earliest + 60 * 60 * 1000 - now)
      };
    }

    botTimestamps.push(now);
    this.botCalls.set(botId, botTimestamps);
    this.globalCalls.push(now);

    return { allowed: true };
  }

  callsInLastHour(botId?: string): number {
    this.prune(Date.now());
    if (!botId) {
      return this.globalCalls.length;
    }
    return (this.botCalls.get(botId) ?? []).length;
  }

  private prune(now: number): void {
    const threshold = rollingHourWindowStart(now);

    while (this.globalCalls.length > 0 && this.globalCalls[0]! < threshold) {
      this.globalCalls.shift();
    }

    for (const [botId, timestamps] of this.botCalls.entries()) {
      while (timestamps.length > 0 && timestamps[0]! < threshold) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.botCalls.delete(botId);
      }
    }
  }
}
