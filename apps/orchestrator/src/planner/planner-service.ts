import type { PlannerRequestV1, PlannerResponseV1 } from "../../../../contracts/planner";
import { SUBGOAL_NAMES } from "../../../../contracts/skills";
import { buildFallbackPlan, type BasePosition } from "./fallback-planner";
import { VertexGeminiClient } from "./gemini-client";
import { PlannerRateLimiter } from "./rate-limiter";
import { SchemaValidator } from "./schema-validator";
import { sleep, withJitter } from "../utils/time";

export interface PlannerResult {
  response: PlannerResponseV1;
  status: "SUCCESS" | "RATE_LIMITED" | "FALLBACK";
  tokensIn?: number;
  tokensOut?: number;
}

export interface PlannerServiceOptions {
  timeoutMs: number;
  maxRetries: number;
  basePosition: BasePosition;
}

const extractJson = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("model did not return JSON");
};

const buildPrompt = (request: PlannerRequestV1): string => {
  return [
    "You are a Minecraft planner for a headless execution system.",
    "Return JSON only and strictly match this shape:",
    '{"next_goal": string, "subgoals": [{"name": string, "params": object, "success_criteria": object, "role_suggestion"?: string|null, "risk_flags"?: string[], "constraints"?: object}], "role_suggestion"?: string|null, "risk_flags"?: string[], "constraints"?: object}',
    `Allowed subgoal names: ${SUBGOAL_NAMES.join(", ")}`,
    "Use short deterministic subgoals (max 4), keep params concrete and executable.",
    "For any construction intent, use build_blueprint. Do not reference stock templates or hardcoded blueprint files.",
    "Request payload:",
    JSON.stringify(request)
  ].join("\n");
};

export class PlannerService {
  private readonly client: VertexGeminiClient;

  private readonly validator: SchemaValidator;

  private readonly limiter: PlannerRateLimiter;

  private readonly options: PlannerServiceOptions;

  constructor(
    client: VertexGeminiClient,
    validator: SchemaValidator,
    limiter: PlannerRateLimiter,
    options: PlannerServiceOptions
  ) {
    this.client = client;
    this.validator = validator;
    this.limiter = limiter;
    this.options = options;
  }

  callsInLastHour(botId?: string): number {
    return this.limiter.callsInLastHour(botId);
  }

  async plan(request: PlannerRequestV1): Promise<PlannerResult> {
    this.validator.validatePlannerRequest(request);

    const budget = this.limiter.consume(request.bot_id);
    if (!budget.allowed) {
      return {
        status: "RATE_LIMITED",
        response: buildFallbackPlan(
          request.snapshot,
          `RATE_LIMIT_${budget.reason ?? "UNKNOWN"}`,
          this.options.basePosition
        )
      };
    }

    const prompt = buildPrompt(request);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const completion = await this.client.generateJson(prompt, this.options.timeoutMs);
        const payload = JSON.parse(extractJson(completion.text)) as PlannerResponseV1;
        this.validator.validatePlannerResponse(payload);
        return {
          status: "SUCCESS",
          response: payload,
          tokensIn: completion.usage.tokensIn,
          tokensOut: completion.usage.tokensOut
        };
      } catch (error) {
        lastError = error;
        if (attempt >= this.options.maxRetries) {
          break;
        }
        await sleep(withJitter(300 * (attempt + 1)));
      }
    }

    return {
      status: "FALLBACK",
      response: buildFallbackPlan(
        request.snapshot,
        `PLANNER_ERROR:${lastError instanceof Error ? lastError.message : "unknown"}`,
        this.options.basePosition
      )
    };
  }
}
