import type { PlannerRequestV1, PlannerResponseV1 } from "../../../../contracts/planner";
import { SUBGOAL_NAMES } from "../../../../contracts/skills";
import { buildFallbackPlan, type BasePosition } from "./fallback-planner";
import { VertexGeminiClient } from "./gemini-client";
import { PlannerRateLimiter } from "./rate-limiter";
import { SchemaValidator } from "./schema-validator";
import { normalizePlannerSubgoals } from "./subgoal-normalizer";
import { sleep, withJitter } from "../utils/time";

export interface PlannerResult {
  response: PlannerResponseV1;
  status: "SUCCESS" | "RATE_LIMITED" | "FALLBACK";
  tokensIn?: number;
  tokensOut?: number;
  notes?: string[];
}

export interface PlannerServiceOptions {
  timeoutMs: number;
  maxRetries: number;
  basePosition: BasePosition;
  mcVersion: string;
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
    "Each bot is an independent player. Do not assign static team roles.",
    "Return JSON only and strictly match this shape:",
    '{"next_goal": string, "subgoals": [{"name": string, "params": object, "success_criteria": object, "risk_flags"?: string[], "constraints"?: object}], "risk_flags"?: string[], "constraints"?: object}',
    `Allowed subgoal names: ${SUBGOAL_NAMES.join(", ")}`,
    "Parameter key rules:",
    "- collect: use params.item OR params.block, plus params.count",
    "- goto_nearest: use params.block OR params.resource",
    "- craft/withdraw: use params.item and params.count",
    "- smelt: use params.input, optional params.fuel, and params.count",
    "Progression rules:",
    "- Respect tool and recipe dependencies implied by the current inventory and world state.",
    "- If an action needs prerequisites, include prerequisite subgoals first.",
    "- Prefer 2-4 coherent subgoals that continue one mission to completion.",
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
          this.options.basePosition,
          this.options.mcVersion
        )
      };
    }

    const prompt = buildPrompt(request);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const completion = await this.client.generateJson(prompt, this.options.timeoutMs);
        const parsed = JSON.parse(extractJson(completion.text)) as PlannerResponseV1;
        this.validator.validatePlannerResponse(parsed);
        const normalized = normalizePlannerSubgoals(parsed.subgoals);
        if (normalized.subgoals.length === 0) {
          throw new Error("planner produced no executable subgoals");
        }

        const payload: PlannerResponseV1 = {
          ...parsed,
          subgoals: normalized.subgoals
        };

        return {
          status: "SUCCESS",
          response: payload,
          tokensIn: completion.usage.tokensIn,
          tokensOut: completion.usage.tokensOut,
          notes: normalized.notes
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
        this.options.basePosition,
        this.options.mcVersion
      )
    };
  }
}
