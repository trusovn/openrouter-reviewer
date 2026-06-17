import type { OrReviewConfig } from "./config.js";
import type { ContextBundle } from "./collectors.js";

export const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "location", "finding", "evidence", "recommendation", "confidence"],
        properties: {
          severity: { type: "string" },
          category: { type: "string" },
          location: { type: "string" },
          finding: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
          confidence: { type: "number" }
        }
      }
    }
  }
} as const;

export type NormalizedFinding = {
  id: string;
  modelAlias: string;
  severity: string;
  category: string;
  location: string;
  finding: string;
  evidence: string;
  recommendation: string;
  confidence: number;
};

export type ModelExecutionResult = {
  alias: string;
  modelId: string;
  ok: boolean;
  raw: unknown;
  findings: NormalizedFinding[];
  error?: string;
};

type FetchLike = typeof fetch;
const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";

class OpenRouterHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function reviewPrompt(bundle: ContextBundle, perspective?: string): string {
  return [
    "You are an external reviewer. Return JSON only with a top-level findings array.",
    perspective ? `Perspective: ${perspective}` : undefined,
    `Instruction: ${bundle.instruction}`,
    "Each finding needs severity, category, location, finding, evidence, recommendation, and confidence.",
    "Context:",
    bundle.context
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseModelJson(raw: unknown): unknown {
  const message = (raw as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof message === "string") {
    try {
      return JSON.parse(message);
    } catch {
      throw new Error("Model response content was not valid JSON.");
    }
  }
  return message;
}

function normalize(alias: string, parsed: unknown): NormalizedFinding[] {
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) throw new Error("Response JSON must contain findings array.");
  return findings.map((item, index) => {
    const value = item as Record<string, unknown>;
    return {
      id: `${alias}-${index + 1}`,
      modelAlias: alias,
      severity: String(value.severity ?? "info"),
      category: String(value.category ?? "general"),
      location: String(value.location ?? "unknown"),
      finding: String(value.finding ?? ""),
      evidence: String(value.evidence ?? ""),
      recommendation: String(value.recommendation ?? ""),
      confidence: Number(value.confidence ?? 0)
    };
  });
}

function isStructuredOutputRejection(error: unknown): boolean {
  if (!(error instanceof OpenRouterHttpError) || error.status < 400 || error.status >= 500) return false;
  const message = error.message.toLowerCase();
  return message.includes("response_format") || message.includes("json_schema") || message.includes("structured output");
}

function isFreeModel(modelId: string, pricing: OrReviewConfig["models"][number]["pricing"]): boolean {
  return modelId.includes(":free") || (pricing?.inputUsdPerMillionTokens === 0 && pricing.outputUsdPerMillionTokens === 0);
}

function normalizeExecutionError(error: unknown, config: OrReviewConfig, model: OrReviewConfig["models"][number]): string {
  const message = (error as Error).message;
  const lower = message.toLowerCase();
  const providerRoutingFailure = lower.includes("no endpoints") || lower.includes("provider") || lower.includes("routing");
  if (config.provider.dataCollection === "deny" && isFreeModel(model.id, model.pricing) && providerRoutingFailure) {
    return `${message}\nHint: free model endpoints may be unavailable under dataCollection: deny.`;
  }
  return message;
}

async function callOpenRouter(
  fetchImpl: FetchLike,
  apiKey: string,
  config: OrReviewConfig,
  model: OrReviewConfig["models"][number],
  bundle: ContextBundle,
  structured: boolean
): Promise<unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [{ role: "user", content: reviewPrompt(bundle, model.perspective) }],
    max_tokens: config.budget.maxOutputTokensPerModel,
    provider: {
      data_collection: config.provider.dataCollection,
      zdr: config.provider.zdr
    }
  };
  if (structured) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "or_review_findings",
        strict: true,
        schema: findingSchema
      }
    };
  } else {
    body.messages = [{ role: "user", content: `${reviewPrompt(bundle, model.perspective)}\n\nReturn valid JSON only.` }];
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? defaultOpenRouterBaseUrl).replace(/\/$/, "");
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new OpenRouterHttpError(responseBody || `OpenRouter HTTP ${response.status}`, response.status);
  }
  return JSON.parse(responseBody);
}

export async function executeModels(
  config: OrReviewConfig,
  bundle: ContextBundle,
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<ModelExecutionResult[]> {
  return Promise.all(
    config.models.map(async (model) => {
      let raw: unknown;
      try {
        try {
          raw = await callOpenRouter(fetchImpl, apiKey, config, model, bundle, true);
        } catch (error) {
          if (!isStructuredOutputRejection(error)) throw error;
          raw = await callOpenRouter(fetchImpl, apiKey, config, model, bundle, false);
        }
        const parsed = parseModelJson(raw);
        return { alias: model.alias, modelId: model.id, ok: true, raw, findings: normalize(model.alias, parsed) };
      } catch (error) {
        return {
          alias: model.alias,
          modelId: model.id,
          ok: false,
          raw: raw ?? null,
          findings: [],
          error: normalizeExecutionError(error, config, model)
        };
      }
    })
  );
}
