import { describe, expect, it } from "vitest";
import { assertWithinBudget, estimateRunCost } from "../src/budget.js";
import type { ContextBundle } from "../src/collectors.js";
import { configSchema } from "../src/config.js";

const bundle: ContextBundle = {
  mode: "files",
  instruction: "review",
  context: "x".repeat(4000),
  preview: "",
  inputs: []
};

describe("budget", () => {
  it("accepts within-budget estimates and passes output token caps through estimate", () => {
    const config = configSchema.parse({
      models: [{ alias: "a", id: "model-a", maxUsdPerRun: 1, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }],
      budget: { maxUsdPerRun: 1, maxOutputTokensPerModel: 500 }
    });

    const estimate = estimateRunCost(config, bundle);

    expect(estimate.models[0]?.outputTokens).toBe(500);
    expect(() => assertWithinBudget(config, estimate)).not.toThrow();
  });

  it("fails closed for missing price, model over-budget, and run over-budget", () => {
    expect(() =>
      estimateRunCost(configSchema.parse({ models: [{ alias: "a", id: "model-a" }] }), bundle)
    ).toThrow("missing pricing");

    const modelOver = configSchema.parse({
      models: [{ alias: "a", id: "model-a", maxUsdPerRun: 0.000001, pricing: { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 10 } }]
    });
    expect(() => assertWithinBudget(modelOver, estimateRunCost(modelOver, bundle))).toThrow("model cap");

    const runOver = configSchema.parse({
      models: [
        { alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 10 } },
        { alias: "b", id: "model-b", pricing: { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 10 } }
      ],
      budget: { maxUsdPerRun: 0.000001, maxOutputTokensPerModel: 2000 }
    });
    expect(() => assertWithinBudget(runOver, estimateRunCost(runOver, bundle))).toThrow("run cap");
  });
});

