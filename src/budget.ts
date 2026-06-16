import type { OrReviewConfig } from "./config.js";
import type { ContextBundle } from "./collectors.js";
import { UserError } from "./errors.js";

export type ModelCostEstimate = {
  alias: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  capUsd?: number;
};

export type RunCostEstimate = {
  models: ModelCostEstimate[];
  totalUsd: number;
};

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function estimateRunCost(config: OrReviewConfig, context: ContextBundle): RunCostEstimate {
  const inputTokens = estimateTokens(context.context.length + context.instruction.length);
  const outputTokens = config.budget.maxOutputTokensPerModel;
  const models = config.models.map((model) => {
    if (!model.pricing) {
      throw new UserError(`Cannot estimate cost for model ${model.alias}: missing pricing.`);
    }
    const inputUsd = (inputTokens / 1_000_000) * model.pricing.inputUsdPerMillionTokens;
    const outputUsd = (outputTokens / 1_000_000) * model.pricing.outputUsdPerMillionTokens;
    return {
      alias: model.alias,
      inputTokens,
      outputTokens,
      estimatedUsd: inputUsd + outputUsd,
      capUsd: model.maxUsdPerRun
    };
  });

  return { models, totalUsd: models.reduce((sum, model) => sum + model.estimatedUsd, 0) };
}

export function assertWithinBudget(config: OrReviewConfig, estimate: RunCostEstimate): void {
  for (const model of estimate.models) {
    if (model.capUsd !== undefined && model.estimatedUsd > model.capUsd) {
      throw new UserError(
        `Estimated cost ${model.estimatedUsd.toFixed(6)} USD exceeds model cap ${model.capUsd.toFixed(6)} USD for ${model.alias}.`
      );
    }
  }
  if (estimate.totalUsd > config.budget.maxUsdPerRun) {
    throw new UserError(
      `Estimated run cost ${estimate.totalUsd.toFixed(6)} USD exceeds run cap ${config.budget.maxUsdPerRun.toFixed(6)} USD.`
    );
  }
}

