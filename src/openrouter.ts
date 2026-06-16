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
  if (typeof message === "string") return JSON.parse(message);
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

  const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(responseBody || `OpenRouter HTTP ${response.status}`);
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
          if (!String((error as Error).message).toLowerCase().includes("response_format")) throw error;
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
          error: (error as Error).message
        };
      }
    })
  );
}

