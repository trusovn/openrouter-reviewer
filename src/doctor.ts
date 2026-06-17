import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

type CheckSeverity = "error" | "warning" | "info";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  severity: CheckSeverity;
  message: string;
};

type Pricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

type ModelConfig = {
  alias: string;
  id: string;
  maxUsdPerRun?: number;
  pricing?: Pricing;
};

type DoctorConfig = {
  pricingSource?: "openrouter" | "pinned";
  models: ModelConfig[];
  provider: {
    dataCollection: "allow" | "deny";
    zdr: boolean;
  };
  budget: {
    maxUsdPerRun: number;
    maxOutputTokensPerModel: number;
  };
};

type ModelMetadata = {
  id: string;
  pricing?: Pricing;
  endpoints?: unknown;
};

type MetadataClient = {
  listModels: () => Promise<ModelMetadata[]>;
};

export type RunDoctorOptions = {
  cwd: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  metadataClient?: MetadataClient;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
};

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";

function check(name: string, ok: boolean, severity: CheckSeverity, message: string): DoctorCheck {
  return { name, ok, severity, message };
}

function configPathFor(cwd: string, configPath?: string): string {
  return path.resolve(cwd, configPath ?? "or-review.config.json");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parsePricing(value: unknown): Pricing | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = record.inputUsdPerMillionTokens;
  const output = record.outputUsdPerMillionTokens;
  if (typeof input !== "number" || typeof output !== "number" || input < 0 || output < 0) return undefined;
  return { inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output };
}

function parseConfig(raw: unknown): { config?: DoctorConfig; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = [];
  const record = asRecord(raw);
  if (!record) {
    return { checks: [check("config", false, "error", "Config must be a JSON object.")] };
  }

  const modelsValue = record.models;
  if (!Array.isArray(modelsValue) || modelsValue.length === 0) {
    checks.push(check("config", false, "error", "Config must include at least one model."));
  }

  const models: ModelConfig[] = Array.isArray(modelsValue)
    ? modelsValue.map((item, index) => {
        const model = asRecord(item) ?? {};
        return {
          alias: typeof model.alias === "string" && model.alias.length > 0 ? model.alias : `model-${index + 1}`,
          id: typeof model.id === "string" ? model.id : "",
          maxUsdPerRun: typeof model.maxUsdPerRun === "number" ? model.maxUsdPerRun : undefined,
          pricing: parsePricing(model.pricing)
        };
      })
    : [];

  const provider = asRecord(record.provider);
  const dataCollection = provider?.dataCollection === "allow" ? "allow" : "deny";
  const budget = asRecord(record.budget);
  const maxUsdPerRun = typeof budget?.maxUsdPerRun === "number" ? budget.maxUsdPerRun : 0.25;
  const maxOutputTokensPerModel =
    typeof budget?.maxOutputTokensPerModel === "number" && Number.isInteger(budget.maxOutputTokensPerModel)
      ? budget.maxOutputTokensPerModel
      : 2000;

  const pricingSource = record.pricingSource === "pinned" ? "pinned" : "openrouter";

  if (maxUsdPerRun < 0) {
    checks.push(check("budget", false, "error", "budget.maxUsdPerRun must be greater than or equal to 0."));
  }
  if (maxOutputTokensPerModel <= 0) {
    checks.push(check("budget", false, "error", "budget.maxOutputTokensPerModel must be a positive integer."));
  }
  for (const model of models) {
    if (model.maxUsdPerRun !== undefined && model.maxUsdPerRun < 0) {
      checks.push(check("budget", false, "error", `Model ${model.alias} maxUsdPerRun must be greater than or equal to 0.`));
    }
  }

  return {
    config: {
      pricingSource,
      models,
      provider: { dataCollection, zdr: provider?.zdr === true },
      budget: { maxUsdPerRun, maxOutputTokensPerModel }
    },
    checks
  };
}

function parseEnvFile(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function mergedEnv(cwd: string, options: RunDoctorOptions, checks: DoctorCheck[]): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const candidate = options.envFile ? path.resolve(cwd, options.envFile) : path.join(cwd, ".env");
  if (!existsSync(candidate)) {
    if (options.envFile) {
      checks.push(check("env", false, "error", `Env file was not found: ${candidate}`));
    }
    return env;
  }

  try {
    const parsed = parseEnvFile(await readFile(candidate, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch (error) {
    checks.push(check("env", false, "error", `Could not read env file ${candidate}: ${(error as Error).message}`));
  }
  return env;
}

function defaultMetadataClient(env: NodeJS.ProcessEnv): MetadataClient {
  return {
    async listModels(): Promise<ModelMetadata[]> {
      const baseUrl = (env.OPENROUTER_BASE_URL ?? defaultOpenRouterBaseUrl).replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/models`, {
        headers: env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : undefined
      });
      if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}`);
      }
      const body = (await response.json()) as { data?: ModelMetadata[] } | ModelMetadata[];
      return Array.isArray(body) ? body : body.data ?? [];
    }
  };
}

function checkModels(config: DoctorConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const aliases = new Set<string>();
  for (const model of config.models) {
    if (aliases.has(model.alias)) {
      checks.push(check("models", false, "error", `Model alias ${model.alias} is duplicated; aliases must be unique.`));
    }
    aliases.add(model.alias);
    if (model.id.trim() === "") {
      checks.push(check("models", false, "error", `Model ${model.alias} is missing a model id.`));
    }
  }
  if (checks.length === 0) {
    checks.push(check("models", true, "info", `Found ${config.models.length} configured model id(s) with unique aliases.`));
  }
  return checks;
}

function pricingChecks(config: DoctorConfig, metadata: ModelMetadata[]): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const metadataById = new Map(metadata.map((model) => [model.id, model]));

  for (const model of config.models) {
    if (model.id.trim() === "") continue;
    const pricing = config.pricingSource === "pinned" ? model.pricing : metadataById.get(model.id)?.pricing;
    if (!pricing) {
      checks.push(check("pricing", false, "error", `Could not resolve pricing for ${model.alias} (${model.id}).`));
      continue;
    }
    checks.push(check("pricing", true, "info", `Resolved pricing for ${model.alias} (${model.id}).`));
  }

  return checks.length > 0 ? checks : [check("pricing", true, "info", "No model pricing checks were needed.")];
}

function isFreeModel(model: ModelConfig, metadata?: ModelMetadata): boolean {
  const pricing = metadata?.pricing ?? model.pricing;
  return model.id.toLowerCase().includes(":free") || pricing?.inputUsdPerMillionTokens === 0 || pricing?.outputUsdPerMillionTokens === 0;
}

function endpointChecks(config: DoctorConfig, metadata: ModelMetadata[]): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const metadataById = new Map(metadata.map((model) => [model.id, model]));

  for (const model of config.models) {
    if (model.id.trim() === "") continue;
    const details = metadataById.get(model.id);
    if (config.provider.dataCollection === "deny" && isFreeModel(model, details)) {
      checks.push(
        check(
          "endpoints",
          true,
          "warning",
          `Model ${model.alias} appears to be free and may be unavailable with dataCollection: deny.`
        )
      );
    }

    const endpoints = Array.isArray(details?.endpoints)
      ? (details.endpoints as Array<{ dataCollection?: "allow" | "deny"; data_collection?: "allow" | "deny" }>)
      : undefined;
    if (!endpoints || endpoints.length === 0 || config.provider.dataCollection !== "deny") continue;
    const hasDenyEndpoint = endpoints.some((endpoint) => (endpoint.dataCollection ?? endpoint.data_collection) === "deny");
    if (!hasDenyEndpoint) {
      checks.push(check("endpoints", false, "error", `Model ${model.alias} has no endpoint compatible with dataCollection: deny.`));
    }
  }

  return checks.length > 0 ? checks : [check("endpoints", true, "info", "No endpoint compatibility problems found.")];
}

export async function runDoctor(options: RunDoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const resolvedConfigPath = configPathFor(options.cwd, options.configPath);

  let config: DoctorConfig | undefined;
  try {
    const raw = await readFile(resolvedConfigPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = parseConfig(parsed);
    config = result.config;
    checks.push(...result.checks);
    if (result.checks.every((item) => item.ok || item.name !== "config")) {
      checks.push(check("config", true, "info", `Parsed config at ${resolvedConfigPath}.`));
    }
  } catch (error) {
    const reason = error instanceof SyntaxError ? `JSON parse error: ${error.message}` : (error as Error).message;
    checks.push(check("config", false, "error", `Could not parse config at ${resolvedConfigPath}: ${reason}`));
    return { ok: false, checks };
  }

  if (!config) {
    checks.push(check("config", false, "error", "Config could not be loaded."));
    return { ok: false, checks };
  }

  checks.push(...checkModels(config));

  const env = await mergedEnv(options.cwd, options, checks);
  if (env.OPENROUTER_API_KEY) {
    checks.push(check("api-key", true, "info", "OPENROUTER_API_KEY is available."));
  } else {
    checks.push(check("api-key", false, "error", "OPENROUTER_API_KEY is required for OpenRouter reachability checks."));
  }

  let metadata: ModelMetadata[] = [];
  try {
    metadata = await (options.metadataClient ?? defaultMetadataClient(env)).listModels();
    checks.push(check("openrouter", true, "info", `OpenRouter metadata is reachable; received ${metadata.length} model(s).`));
  } catch (error) {
    checks.push(check("openrouter", false, "error", `OpenRouter metadata is not reachable: ${(error as Error).message}`));
  }

  checks.push(...pricingChecks(config, metadata));
  checks.push(...endpointChecks(config, metadata));

  return { ok: !checks.some((item) => !item.ok && item.severity === "error"), checks };
}
