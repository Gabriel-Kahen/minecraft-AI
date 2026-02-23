import type { PlannerRequestV1, PlannerResponseV1 } from "../../../../contracts/planner";
import { SUBGOAL_NAMES } from "../../../../contracts/skills";
import { buildFallbackPlan, type BasePosition } from "./fallback-planner";
import { VertexGeminiClient } from "./gemini-client";
import { PlannerRateLimiter } from "./rate-limiter";
import { SchemaValidator } from "./schema-validator";
import { enforceSubgoalPrerequisites } from "./subgoal-guard";
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
  feasibilityRepromptEnabled?: boolean;
  feasibilityRepromptMaxAttempts?: number;
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

interface PromptOptions {
  mode: "initial" | "repair";
  previousSubgoals?: PlannerResponseV1["subgoals"];
  guardedSubgoals?: PlannerResponseV1["subgoals"];
  guardNotes?: string[];
}

const compact = <T>(values: Array<T | null | undefined | false>): T[] =>
  values.filter((value): value is T => Boolean(value));

const summarizeInventory = (request: PlannerRequestV1): string => {
  const keyItems = Object.entries(request.snapshot.inventory_summary.key_items)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([name, count]) => `${name}:${count}`);

  const tools = Object.entries(request.snapshot.inventory_summary.tools)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([name, count]) => `${name}:${count}`);

  return compact([
    tools.length > 0 ? `tools=[${tools.join(", ")}]` : null,
    keyItems.length > 0 ? `items=[${keyItems.join(", ")}]` : null,
    `food=${request.snapshot.inventory_summary.food_total}`
  ]).join(" ");
};

const summarizeNearby = (request: PlannerRequestV1): string => {
  const resources = [...request.snapshot.nearby_summary.resources]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8)
    .map((resource) => `${resource.type}@${Math.round(resource.distance)}`);

  const pois = [...request.snapshot.nearby_summary.points_of_interest]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6)
    .map((poi) => `${poi.type}@${Math.round(poi.distance)}`);

  const hostiles = [...request.snapshot.nearby_summary.hostiles]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6)
    .map((hostile) => `${hostile.type}@${Math.round(hostile.distance)}`);

  return compact([
    resources.length > 0 ? `resources=[${resources.join(", ")}]` : null,
    pois.length > 0 ? `poi=[${pois.join(", ")}]` : null,
    hostiles.length > 0 ? `hostiles=[${hostiles.join(", ")}]` : null
  ]).join(" ");
};

const summarizeRecentFailures = (request: PlannerRequestV1): string => {
  const failures = [...request.history]
    .filter((entry) => entry.outcome === "FAILURE")
    .slice(-8)
    .map((entry) => `${entry.subgoal_name}:${entry.error_code ?? "UNKNOWN"}`);
  return failures.length > 0 ? failures.join(", ") : "none";
};

const subgoalSignature = (subgoal: PlannerResponseV1["subgoals"][number]): string =>
  JSON.stringify({
    name: subgoal.name,
    params: subgoal.params,
    success_criteria: subgoal.success_criteria
  });

const plansEquivalent = (
  left: PlannerResponseV1["subgoals"],
  right: PlannerResponseV1["subgoals"]
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (subgoalSignature(left[index]!) !== subgoalSignature(right[index]!)) {
      return false;
    }
  }
  return true;
};

const buildPrompt = (request: PlannerRequestV1, options: PromptOptions): string => {
  const inventorySummary = summarizeInventory(request);
  const nearbySummary = summarizeNearby(request);
  const failureSummary = summarizeRecentFailures(request);

  const repairSection =
    options.mode === "repair"
      ? [
          "Your prior plan failed deterministic feasibility checks and was auto-adjusted.",
          "Repair objective: return a plan that already satisfies dependencies without guard rewrites.",
          `Previous model subgoals: ${JSON.stringify(options.previousSubgoals ?? [])}`,
          `Guard-adjusted subgoals: ${JSON.stringify(options.guardedSubgoals ?? [])}`,
          `Guard notes: ${(options.guardNotes ?? []).slice(0, 24).join(", ") || "none"}`
        ]
      : [];

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
    "- combat_engage: use params.target_mode as one of hostile|animal|auto",
    "Execution semantics (executor handles micro-steps inside each subgoal):",
    "- craft: gather prerequisites, ensure/place/use crafting table, then craft",
    "- collect: locate source block, pathfind/mine, repeat until count",
    "- goto_nearest: find nearest target block then pathfind to it",
    "Reasoning protocol (do internally, do NOT output chain-of-thought):",
    "1) Build projected inventory state from current inventory + expected subgoal outcomes.",
    "2) Validate every subgoal precondition against that projected state.",
    "3) If any precondition is missing, prepend prerequisite subgoals first.",
    "4) Re-simulate after each subgoal and remove impossible/out-of-order actions.",
    "Progression rules:",
    "- Respect tool and recipe dependencies implied by the current inventory and world state.",
    "- If an action needs prerequisites, include prerequisite subgoals first.",
    "- Prefer 2-4 coherent subgoals that continue one mission to completion.",
    "Use short deterministic subgoals (max 4), keep params concrete and executable.",
    "Planning context summary:",
    `- inventory: ${inventorySummary}`,
    `- nearby: ${nearbySummary || "none"}`,
    `- recent_failures: ${failureSummary}`,
    ...repairSection,
    "Request payload:",
    JSON.stringify(request)
  ].join("\n");
};

interface ModelPlan {
  parsed: PlannerResponseV1;
  normalizedSubgoals: PlannerResponseV1["subgoals"];
  notes: string[];
  tokensIn?: number;
  tokensOut?: number;
}

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

    const callModelWithPrompt = async (prompt: string): Promise<ModelPlan> => {
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
          return {
            parsed,
            normalizedSubgoals: normalized.subgoals,
            notes: normalized.notes,
            tokensIn: completion.usage.tokensIn,
            tokensOut: completion.usage.tokensOut
          };
        } catch (error) {
          lastError = error;
          if (attempt >= this.options.maxRetries) {
            break;
          }
          await sleep(withJitter(80 * (attempt + 1)));
        }
      }

      throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? "unknown planner error")));
    };

    let lastError: unknown;

    try {
      const feasibilityRepromptEnabled = this.options.feasibilityRepromptEnabled ?? true;
      const feasibilityRepromptMaxAttempts = Math.max(0, this.options.feasibilityRepromptMaxAttempts ?? 1);

      let modelPlan = await callModelWithPrompt(buildPrompt(request, { mode: "initial" }));
      let totalTokensIn = modelPlan.tokensIn ?? 0;
      let totalTokensOut = modelPlan.tokensOut ?? 0;
      let notes = [...modelPlan.notes];

      let guarded = enforceSubgoalPrerequisites(
        request.snapshot,
        modelPlan.normalizedSubgoals,
        this.options.mcVersion
      );
      notes.push(...guarded.notes);

      const initialPlanWasAdjusted = !plansEquivalent(modelPlan.normalizedSubgoals, guarded.subgoals);
      if (initialPlanWasAdjusted) {
        notes.push("guard_adjusted_initial_plan");
      }

      if (
        feasibilityRepromptEnabled &&
        feasibilityRepromptMaxAttempts > 0 &&
        initialPlanWasAdjusted
      ) {
        for (let repromptAttempt = 0; repromptAttempt < feasibilityRepromptMaxAttempts; repromptAttempt += 1) {
          const repromptBudget = this.limiter.consume(request.bot_id);
          if (!repromptBudget.allowed) {
            notes.push(`feasibility_reprompt_skipped_${repromptBudget.reason ?? "RATE_LIMITED"}`);
            break;
          }

          const repairedPrompt = buildPrompt(request, {
            mode: "repair",
            previousSubgoals: modelPlan.normalizedSubgoals,
            guardedSubgoals: guarded.subgoals,
            guardNotes: guarded.notes
          });

          try {
            const repaired = await callModelWithPrompt(repairedPrompt);
            modelPlan = repaired;
            totalTokensIn += repaired.tokensIn ?? 0;
            totalTokensOut += repaired.tokensOut ?? 0;
            notes.push(`feasibility_reprompt_attempt_${repromptAttempt + 1}`);
            notes.push(...repaired.notes);

            guarded = enforceSubgoalPrerequisites(
              request.snapshot,
              repaired.normalizedSubgoals,
              this.options.mcVersion
            );
            notes.push(...guarded.notes);

            if (plansEquivalent(repaired.normalizedSubgoals, guarded.subgoals)) {
              notes.push("feasibility_reprompt_resolved");
              break;
            }

            notes.push("feasibility_reprompt_still_adjusted");
          } catch (error) {
            notes.push(`feasibility_reprompt_error_${repromptAttempt + 1}`);
            lastError = error;
          }
        }
      }

      if (guarded.subgoals.length === 0) {
        throw new Error("guarded planner output empty");
      }

      const payload: PlannerResponseV1 = {
        ...modelPlan.parsed,
        subgoals: guarded.subgoals
      };

      return {
        status: "SUCCESS",
        response: payload,
        tokensIn: totalTokensIn || undefined,
        tokensOut: totalTokensOut || undefined,
        notes
      };
    } catch (error) {
      lastError = error;
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
