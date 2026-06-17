import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config.js";

type Pricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

type ResolvedPricingConfig = {
  pricingSource: "openrouter" | "pinned";
  models: Array<{ alias: string; id: string; pricing?: Pricing }>;
};

type ResolvePricing = (options: {
  cwd: string;
  config: ResolvedPricingConfig;
  metadataClient: {
    listModels: () => Promise<Array<{ id: string; pricing: Pricing }>>;
  };
  now?: () => Date;
  ttlMs?: number;
  forceRefresh?: boolean;
}) => Promise<{ config: ResolvedPricingConfig; cacheStatus: "hit" | "miss" | "refreshed"; warnings: string[] }>;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "or-review-pricing-"));
}

async function importPricing(): Promise<{ resolvePricing: ResolvePricing }> {
  expect(existsSync(path.resolve(import.meta.dirname, "..", "src", "pricing.ts"))).toBe(true);
  const modulePath = "../src/pricing.js";
  return import(modulePath) as Promise<{ resolvePricing: ResolvePricing }>;
}

describe("OpenRouter pricing resolution", () => {
  it("fetches OpenRouter pricing, writes cache, and reuses fresh cached pricing", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      pricingSource: "openrouter",
      models: [{ alias: "a", id: "provider/model-a" }],
      budget: { maxUsdPerRun: 0.25, maxOutputTokensPerModel: 100 }
    }) as unknown as ResolvedPricingConfig;
    const metadataClient = {
      listModels: vi.fn(async () => [
        {
          id: "provider/model-a",
          pricing: { inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 1.5 }
        }
      ])
    };
    const { resolvePricing } = await importPricing();

    const first = await resolvePricing({
      cwd,
      config,
      metadataClient,
      now: () => new Date("2026-06-17T12:00:00Z"),
      ttlMs: 60 * 60 * 1000
    });
    const second = await resolvePricing({
      cwd,
      config,
      metadataClient: {
        listModels: vi.fn(async () => {
          throw new Error("fresh cache should avoid metadata fetch");
        })
      },
      now: () => new Date("2026-06-17T12:30:00Z"),
      ttlMs: 60 * 60 * 1000
    });

    expect(first.cacheStatus).toBe("miss");
    expect(second.cacheStatus).toBe("hit");
    expect(first.config.models[0]?.pricing).toEqual({ inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 1.5 });
    expect(second.config.models[0]?.pricing).toEqual({ inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 1.5 });
    expect(metadataClient.listModels).toHaveBeenCalledOnce();
    expect(await readFile(path.join(cwd, ".or-review", "cache", "openrouter-models.json"), "utf8")).toContain("provider/model-a");
  });

  it("refreshes expired cache and fails closed when pricing cannot be resolved", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      pricingSource: "openrouter",
      models: [{ alias: "missing", id: "provider/missing" }],
      budget: { maxUsdPerRun: 0.25, maxOutputTokensPerModel: 100 }
    }) as unknown as ResolvedPricingConfig;
    const { resolvePricing } = await importPricing();

    await expect(
      resolvePricing({
        cwd,
        config,
        metadataClient: { listModels: vi.fn(async () => []) },
        now: () => new Date("2026-06-17T12:00:00Z"),
        ttlMs: 60 * 60 * 1000
      })
    ).rejects.toThrow(/pricing.*provider\/missing/i);
  });

  it("uses pinned pricing without fetching OpenRouter metadata", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      pricingSource: "pinned",
      models: [
        {
          alias: "pinned",
          id: "provider/model",
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }
        }
      ],
      budget: { maxUsdPerRun: 0.25, maxOutputTokensPerModel: 100 }
    }) as unknown as ResolvedPricingConfig;
    const metadataClient = { listModels: vi.fn(async () => []) };
    const { resolvePricing } = await importPricing();

    const result = await resolvePricing({ cwd, config, metadataClient });

    expect(result.config.models[0]?.pricing).toEqual({ inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 });
    expect(result.cacheStatus).toBe("hit");
    expect(metadataClient.listModels).not.toHaveBeenCalled();
  });
});
