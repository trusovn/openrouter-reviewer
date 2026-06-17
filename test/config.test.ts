import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCliOverrides, assertReviewConfigReady, configSchema, loadConfig, requireApiKey, writeInitialConfig } from "../src/config.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "or-review-config-"));
}

describe("config", () => {
  it("parses dotenv syntax without overriding shell precedence", async () => {
    const configModule = (await import("../src/config.js")) as {
      parseEnvFile?: (source: string) => Record<string, string>;
    };

    expect(configModule.parseEnvFile).toBeTypeOf("function");
    expect(
      configModule.parseEnvFile?.(`
# comment
OPENROUTER_API_KEY='from-dotenv'
OPENROUTER_BASE_URL="https://example.test/v1"
UNQUOTED=value
EMPTY=
`)
    ).toEqual({
      OPENROUTER_API_KEY: "from-dotenv",
      OPENROUTER_BASE_URL: "https://example.test/v1",
      UNQUOTED: "value",
      EMPTY: ""
    });
  });

  it("writes an init skeleton that validates without hardcoded model ids", async () => {
    const cwd = await tempDir();
    const configPath = await writeInitialConfig(cwd);
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const config = configSchema.parse(parsed);

    expect(config.models[0]?.id).toBe("");
    expect(config.provider).toEqual({ dataCollection: "deny", zdr: false });
    expect(() => assertReviewConfigReady(config)).toThrow("missing an OpenRouter model id");
  });

  it("loads project config and applies CLI overrides last", async () => {
    const cwd = await tempDir();
    await writeFile(
      path.join(cwd, "or-review.config.json"),
      JSON.stringify({
        models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }],
        provider: { dataCollection: "deny", zdr: false },
        budget: { maxUsdPerRun: 0.25, maxOutputTokensPerModel: 2000 },
        limits: { maxFileBytes: 200000, maxContextChars: 120000 },
        reports: { dir: ".or-review/runs" },
        assessmentLedger: {}
      }),
      "utf8"
    );

    const config = await loadConfig(cwd, { maxUsdPerRun: 0.5, maxContextChars: 42, reportsDir: "reports" });

    expect(config.budget.maxUsdPerRun).toBe(0.5);
    expect(config.limits.maxContextChars).toBe(42);
    expect(config.reports.dir).toBe("reports");
  });

  it("reports missing config and missing api key before network work", async () => {
    await expect(loadConfig(await tempDir())).rejects.toThrow("No config found");
    expect(() => requireApiKey({})).toThrow("OPENROUTER_API_KEY");
  });

  it("validates direct override helper", () => {
    const config = configSchema.parse({
      models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }]
    });

    expect(applyCliOverrides(config, { maxFileBytes: 10, assessmentLedgerPath: "/tmp/ledger.jsonl" }).limits.maxFileBytes).toBe(10);
    expect(() => assertReviewConfigReady(config)).not.toThrow();
  });

  it("defaults to OpenRouter pricing and requires pinned pricing only in pinned mode", () => {
    const defaultConfig = configSchema.parse({
      models: [{ alias: "a", id: "model-a" }]
    }) as { pricingSource?: string; models: Array<{ pricing?: unknown }> };

    expect(defaultConfig.pricingSource).toBe("openrouter");
    expect(defaultConfig.models[0]?.pricing).toBeUndefined();

    const pinnedConfig = configSchema.parse({
      pricingSource: "pinned",
      models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } }]
    }) as { pricingSource?: string };
    expect(pinnedConfig.pricingSource).toBe("pinned");

    expect(() =>
      configSchema.parse({
        pricingSource: "pinned",
        models: [{ alias: "a", id: "model-a" }]
      })
    ).toThrow("pricing");
  });

  it("accepts zero-dollar caps while still rejecting negative caps", () => {
    const config = configSchema.parse({
      models: [{ alias: "free", id: "provider/free:free", maxUsdPerRun: 0 }],
      budget: { maxUsdPerRun: 0, maxOutputTokensPerModel: 100 }
    });

    expect(config.models[0]?.maxUsdPerRun).toBe(0);
    expect(config.budget.maxUsdPerRun).toBe(0);
    expect(() => configSchema.parse({ models: [{ alias: "a", id: "model-a", maxUsdPerRun: -0.01 }] })).toThrow();
    expect(() => configSchema.parse({ models: [{ alias: "a", id: "model-a" }], budget: { maxUsdPerRun: -0.01 } })).toThrow();
  });
});
