import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type Pricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

export type PricingModelConfig = {
  alias: string;
  id: string;
  pricing?: Pricing;
};

export type PricingConfig = {
  pricingSource?: "openrouter" | "pinned";
  models: PricingModelConfig[];
};

export type OpenRouterMetadataModel = {
  id: string;
  pricing?: Pricing;
  endpoints?: unknown;
};

export type MetadataClient = {
  listModels: () => Promise<OpenRouterMetadataModel[]>;
};

export type ResolvePricingOptions<TConfig extends PricingConfig = PricingConfig> = {
  cwd: string;
  config: TConfig;
  metadataClient: MetadataClient;
  now?: () => Date;
  ttlMs?: number;
  forceRefresh?: boolean;
};

export type ResolvePricingResult<TConfig extends PricingConfig = PricingConfig> = {
  config: TConfig;
  cacheStatus: "hit" | "miss" | "refreshed";
  warnings: string[];
};

const defaultTtlMs = 24 * 60 * 60 * 1000;
const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";

type MetadataCache = {
  timestamp: string;
  models: OpenRouterMetadataModel[];
};

function cachePath(cwd: string): string {
  return path.join(cwd, ".or-review", "cache", "openrouter-models.json");
}

function hasPricing(model: PricingModelConfig): boolean {
  return (
    model.pricing !== undefined &&
    Number.isFinite(model.pricing.inputUsdPerMillionTokens) &&
    Number.isFinite(model.pricing.outputUsdPerMillionTokens)
  );
}

function pricingSource(config: PricingConfig): "openrouter" | "pinned" {
  if (config.pricingSource) return config.pricingSource;
  return config.models.every(hasPricing) ? "pinned" : "openrouter";
}

function isFresh(cache: MetadataCache, now: Date, ttlMs: number): boolean {
  const timestamp = Date.parse(cache.timestamp);
  return Number.isFinite(timestamp) && now.getTime() - timestamp <= ttlMs;
}

async function readCache(cwd: string): Promise<MetadataCache | undefined> {
  try {
    const raw = await readFile(cachePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as MetadataCache;
    if (!Array.isArray(parsed.models) || typeof parsed.timestamp !== "string") return undefined;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeCache(cwd: string, cache: MetadataCache): Promise<void> {
  const destination = cachePath(cwd);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function attachPricing<TConfig extends PricingConfig>(config: TConfig, models: OpenRouterMetadataModel[]): TConfig {
  const metadataById = new Map(models.map((model) => [model.id, model]));
  const resolvedModels = config.models.map((model) => {
    const pricing = metadataById.get(model.id)?.pricing;
    if (!pricing) {
      throw new Error(`Unable to resolve pricing for model ${model.id}.`);
    }
    return { ...model, pricing };
  });

  return { ...config, models: resolvedModels } as TConfig;
}

export async function resolvePricing<TConfig extends PricingConfig>(
  options: ResolvePricingOptions<TConfig>
): Promise<ResolvePricingResult<TConfig>> {
  const source = pricingSource(options.config);
  if (source === "pinned") {
    return { config: options.config, cacheStatus: "hit", warnings: [] };
  }

  const now = options.now?.() ?? new Date();
  const ttlMs = options.ttlMs ?? defaultTtlMs;
  const cached = options.forceRefresh ? undefined : await readCache(options.cwd);

  if (cached && isFresh(cached, now, ttlMs)) {
    return {
      config: attachPricing(options.config, cached.models),
      cacheStatus: "hit",
      warnings: []
    };
  }

  const models = await options.metadataClient.listModels();
  await writeCache(options.cwd, { timestamp: now.toISOString(), models });

  return {
    config: attachPricing(options.config, models),
    cacheStatus: cached ? "refreshed" : "miss",
    warnings: []
  };
}

export function createOpenRouterMetadataClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = process.env.OPENROUTER_BASE_URL ?? defaultOpenRouterBaseUrl
): MetadataClient {
  return {
    async listModels(): Promise<OpenRouterMetadataModel[]> {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(body || `OpenRouter metadata request failed with HTTP ${response.status}.`);
      }
      const parsed = JSON.parse(body) as { data?: OpenRouterMetadataModel[] };
      return parsed.data ?? [];
    }
  };
}
