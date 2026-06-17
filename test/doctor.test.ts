import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type DoctorCheck = {
  name: string;
  ok: boolean;
  severity: "error" | "warning" | "info";
  message: string;
};

type ModelMetadata = {
  id: string;
  pricing?: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
  endpoints?: Array<{ dataCollection: "allow" | "deny" }>;
};

type RunDoctor = (options: {
  cwd: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  metadataClient?: { listModels: () => Promise<ModelMetadata[]> };
}) => Promise<{ ok: boolean; checks: DoctorCheck[] }>;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "or-review-doctor-"));
}

async function importDoctor(): Promise<{ runDoctor: RunDoctor }> {
  expect(existsSync(path.resolve(import.meta.dirname, "..", "src", "doctor.ts"))).toBe(true);
  const modulePath = "../src/doctor.js";
  return import(modulePath) as Promise<{ runDoctor: RunDoctor }>;
}

async function writeConfig(cwd: string, config: unknown): Promise<void> {
  await writeFile(path.join(cwd, "or-review.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function messages(result: { checks: DoctorCheck[] }): string {
  return result.checks.map((check) => check.message).join("\n");
}

describe("doctor preflight", () => {
  it("reports config parse failures as structured errors and never writes run reports", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "or-review.config.json"), "{ not json", "utf8");
    const { runDoctor } = await importDoctor();

    const result = await runDoctor({ cwd, env: { OPENROUTER_API_KEY: "key" } });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "config", ok: false, severity: "error" }));
    expect(messages(result)).toMatch(/config|json|parse/i);
    expect(existsSync(path.join(cwd, ".or-review", "runs"))).toBe(false);
  });

  it("checks model ids, pricing resolution, api key availability, and OpenRouter reachability", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, {
      pricingSource: "openrouter",
      models: [{ alias: "blank", id: "" }],
      provider: { dataCollection: "deny", zdr: false },
      budget: { maxUsdPerRun: 0, maxOutputTokensPerModel: 100 }
    });
    const metadataClient = { listModels: vi.fn(async () => [] as ModelMetadata[]) };
    const { runDoctor } = await importDoctor();

    const result = await runDoctor({ cwd, env: {}, metadataClient });

    expect(result.ok).toBe(false);
    expect(messages(result)).toMatch(/model id/i);
    expect(messages(result)).toMatch(/pricing/i);
    expect(messages(result)).toMatch(/OPENROUTER_API_KEY/i);
    expect(metadataClient.listModels).toHaveBeenCalledOnce();
  });

  it("fails when OpenRouter metadata cannot be reached", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, {
      pricingSource: "openrouter",
      models: [{ alias: "a", id: "provider/model" }],
      provider: { dataCollection: "deny", zdr: false },
      budget: { maxUsdPerRun: 0.1, maxOutputTokensPerModel: 100 }
    });
    const { runDoctor } = await importDoctor();

    const result = await runDoctor({
      cwd,
      env: { OPENROUTER_API_KEY: "key" },
      metadataClient: { listModels: vi.fn(async () => Promise.reject(new Error("network down"))) }
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "openrouter", ok: false, severity: "error" }));
    expect(messages(result)).toMatch(/network down|reachable/i);
  });

  it("allows warning-only diagnostics and warns about free models under dataCollection deny", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, {
      pricingSource: "openrouter",
      models: [{ alias: "free", id: "provider/free:free", maxUsdPerRun: 0 }],
      provider: { dataCollection: "deny", zdr: false },
      budget: { maxUsdPerRun: 0, maxOutputTokensPerModel: 100 }
    });
    const { runDoctor } = await importDoctor();

    const result = await runDoctor({
      cwd,
      env: { OPENROUTER_API_KEY: "key" },
      metadataClient: {
        listModels: vi.fn(async () => {
          const models: ModelMetadata[] = [
            {
              id: "provider/free:free",
              pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
              endpoints: [{ dataCollection: "deny" }]
            }
          ];
          return models;
        })
      }
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringMatching(/free.*dataCollection: deny/i) }));
  });
});
