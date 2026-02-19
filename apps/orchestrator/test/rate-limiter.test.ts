import { describe, expect, it } from "vitest";
import { PlannerRateLimiter } from "../src/planner/rate-limiter";

describe("PlannerRateLimiter", () => {
  it("enforces per-bot caps", () => {
    const limiter = new PlannerRateLimiter(2, 10);
    expect(limiter.consume("bot-1").allowed).toBe(true);
    expect(limiter.consume("bot-1").allowed).toBe(true);
    const decision = limiter.consume("bot-1");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("BOT_CAP");
  });

  it("enforces global caps", () => {
    const limiter = new PlannerRateLimiter(10, 2);
    expect(limiter.consume("bot-1").allowed).toBe(true);
    expect(limiter.consume("bot-2").allowed).toBe(true);
    const decision = limiter.consume("bot-3");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("GLOBAL_CAP");
  });
});
