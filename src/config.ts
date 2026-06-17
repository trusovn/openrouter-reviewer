import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { UserError } from "./errors.js";

export const modelConfigSchema = z.object({
  alias: z.string().min(1),
  id: z.string(),
  perspective: z.string().optional(),
  maxUsdPerRun: z.number().nonnegative().optional(),
  pricing: z
    .object({
      inputUsdPerMillionTokens: z.number().nonnegative(),
      outputUsdPerMillionTokens: z.number().nonnegative()
    })
    .optional()
});

export const configSchema = z
  .object({
    pricingSource: z.enum(["openrouter", "pinned"]).default("openrouter"),
    models: z.array(modelConfigSchema).min(1),
    provider: z
      .object({
        dataCollection: z.literal("deny").default("deny"),
        zdr: z.literal(false).default(false)
      })
      .default({ dataCollection: "deny", zdr: false }),
    budget: z
      .object({
        maxUsdPerRun: z.number().nonnegative().default(0.25),
        maxOutputTokensPerModel: z.number().int().positive().default(2000)
      })
      .default({ maxUsdPerRun: 0.25, maxOutputTokensPerModel: 2000 }),
    limits: z
      .object({
        maxFileBytes: z.number().int().positive().default(200_000),
        maxContextChars: z.number().int().positive().default(120_000)
      })
      .default({ maxFileBytes: 200_000, maxContextChars: 120_000 }),
    reports: z
      .object({
        dir: z.string().min(1).default(".or-review/runs")
      })
      .default({ dir: ".or-review/runs" }),
    assessmentLedger: z
      .object({
        path: z.string().min(1).optional()
      })
      .default({})
  })
  .superRefine((config, context) => {
    if (config.pricingSource !== "pinned") return;
    for (const [index, model] of config.models.entries()) {
      if (!model.pricing) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pricing is required when pricingSource is pinned",
          path: ["models", index, "pricing"]
        });
      }
    }
  });

export type OrReviewConfig = z.infer<typeof configSchema>;

export type CliConfigOverrides = {
  configPath?: string;
  envFile?: string;
  maxUsdPerRun?: number;
  maxOutputTokensPerModel?: number;
  maxFileBytes?: number;
  maxContextChars?: number;
  reportsDir?: string;
  assessmentLedgerPath?: string;
};

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, "or-review.config.json");
}

export function userConfigPath(): string {
  return path.join(homedir(), ".config", "or-review", "config.json");
}

export function defaultAssessmentLedgerPath(): string {
  return path.join(homedir(), ".local", "share", "or-review", "assessments.jsonl");
}

export async function readConfigFile(configPath: string): Promise<OrReviewConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return configSchema.parse(parsed);
}

export async function loadConfig(cwd: string, overrides: CliConfigOverrides = {}): Promise<OrReviewConfig> {
  const configPath =
    overrides.configPath ??
    (existsSync(projectConfigPath(cwd)) ? projectConfigPath(cwd) : existsSync(userConfigPath()) ? userConfigPath() : undefined);

  if (!configPath) {
    throw new UserError("No config found. Run `or-review init` or pass --config before collecting context.");
  }

  const config = await readConfigFile(path.resolve(cwd, configPath));
  return applyCliOverrides(config, overrides);
}

export function parseEnvFile(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

export async function loadEnvironment(
  cwd: string,
  options: { envFile?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<NodeJS.ProcessEnv> {
  const env = { ...(options.env ?? process.env) };
  const envPath = options.envFile ? path.resolve(cwd, options.envFile) : path.join(cwd, ".env");

  if (!existsSync(envPath)) {
    if (options.envFile) throw new UserError(`Env file not found: ${envPath}`);
    return env;
  }

  const values = parseEnvFile(await readFile(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value;
      if (!options.env) process.env[key] = value;
    }
  }
  return env;
}

export function applyCliOverrides(config: OrReviewConfig, overrides: CliConfigOverrides): OrReviewConfig {
  const merged: OrReviewConfig = {
    ...config,
    budget: { ...config.budget },
    limits: { ...config.limits },
    reports: { ...config.reports },
    assessmentLedger: { ...config.assessmentLedger }
  };

  if (overrides.maxUsdPerRun !== undefined) merged.budget.maxUsdPerRun = overrides.maxUsdPerRun;
  if (overrides.maxOutputTokensPerModel !== undefined) merged.budget.maxOutputTokensPerModel = overrides.maxOutputTokensPerModel;
  if (overrides.maxFileBytes !== undefined) merged.limits.maxFileBytes = overrides.maxFileBytes;
  if (overrides.maxContextChars !== undefined) merged.limits.maxContextChars = overrides.maxContextChars;
  if (overrides.reportsDir !== undefined) merged.reports.dir = overrides.reportsDir;
  if (overrides.assessmentLedgerPath !== undefined) merged.assessmentLedger.path = overrides.assessmentLedgerPath;

  return configSchema.parse(merged);
}

export function assertReviewConfigReady(config: OrReviewConfig): void {
  const missingModelId = config.models.find((model) => model.id.trim() === "");
  if (missingModelId) {
    throw new UserError(`Model ${missingModelId.alias} is missing an OpenRouter model id. Edit or-review.config.json before running a review.`);
  }
}

export async function writeInitialConfig(cwd: string, destination = projectConfigPath(cwd)): Promise<string> {
  const resolved = path.resolve(cwd, destination);
  if (existsSync(resolved)) {
    throw new UserError(`Config already exists at ${resolved}`);
  }

  const skeleton = {
    $schemaNote: "Remove this note if desired. Fill models with explicit OpenRouter model IDs before first review.",
    pricingSource: "openrouter",
    models: [
      {
        alias: "primary-reviewer",
        id: "",
        perspective: "general code and artifact reviewer",
        maxUsdPerRun: 0.1
      }
    ],
    provider: {
      dataCollection: "deny",
      zdr: false
    },
    budget: {
      maxUsdPerRun: 0.25,
      maxOutputTokensPerModel: 2000
    },
    limits: {
      maxFileBytes: 200000,
      maxContextChars: 120000
    },
    reports: {
      dir: ".or-review/runs"
    },
    assessmentLedger: {}
  };

  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(skeleton, null, 2)}\n`, "utf8");
  return resolved;
}

export function requireApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new UserError("OPENROUTER_API_KEY is required before any OpenRouter network call.");
  }
  return apiKey;
}
