import type { ContextBundle } from "./collectors.js";
import type { OrReviewConfig } from "./config.js";

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

export type ModelFailureKind =
  | "rate_limited"
  | "invalid_structured_output"
  | "structured_output_unsupported"
  | "api_error"
  | "network_error"
  | "unknown";

export type AttemptDiagnostic = {
  mode: "structured" | "json_prompt";
  status?: number;
  retryAfterSeconds?: number;
  message?: string;
  retried: boolean;
};

export type ModelExecutionResult = {
  alias: string;
  modelId: string;
  ok: boolean;
  raw: unknown;
  findings: NormalizedFinding[];
  error?: string;
  failureKind?: ModelFailureKind;
  attempts?: number;
  retryAfterSeconds?: number;
  attemptDiagnostics?: AttemptDiagnostic[];
};

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

type FetchLike = typeof fetch;
type RequestMode = "structured" | "json_prompt";

type RetryPolicy = {
  maxRetries: number;
  defaultBackoffMs: (attempt: number) => number;
  maxBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
};

type ExecuteModelsOptions = {
  retryPolicy?: RetryPolicy;
};

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 2,
  defaultBackoffMs: (attempt) => attempt * 1_000,
  maxBackoffMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date()
};

class OpenRouterHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string = "",
    readonly headers: Headers = new Headers()
  ) {
    super(message);
  }
}

class InvalidStructuredOutputError extends Error {
  constructor(message: string) {
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

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidStructuredOutputError("Model response content was not valid JSON.");
  }
  return validateModelReviewResponse(parsed);
}

function validateModelReviewResponse(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { findings?: unknown }).findings)) {
    throw new InvalidStructuredOutputError("Model response JSON must be an object with a findings array.");
  }
  return value as Record<string, unknown>;
}

function parseModelJson(raw: unknown): Record<string, unknown> {
  const choice = (raw as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  if (!choice?.message || !("content" in choice.message)) {
    throw new InvalidStructuredOutputError("Model response did not include choices[0].message.content; content was null or missing.");
  }

  const content = choice.message.content;
  if (content === null) {
    throw new InvalidStructuredOutputError("Model response content was null or missing; content was null.");
  }
  if (typeof content === "string") {
    if (content.trim() === "") {
      throw new InvalidStructuredOutputError("Model response content was empty.");
    }
    return parseJsonObject(content);
  }
  if (typeof content === "object") {
    return validateModelReviewResponse(content);
  }
  throw new InvalidStructuredOutputError("Model response content was not a string.");
}

function normalize(alias: string, parsed: Record<string, unknown>): NormalizedFinding[] {
  const findings = parsed.findings as unknown[];
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
  if (!(error instanceof OpenRouterHttpError) || error.status < 400 || error.status >= 500) {
    return false;
  }
  const message = `${error.message} ${error.body}`.toLowerCase();
  return (
    message.includes("response_format") ||
    message.includes("json_schema") ||
    message.includes("structured output")
  );
}

function isFreeModel(model: OrReviewConfig["models"][number]): boolean {
  return (
    model.id.includes(":free") ||
    (model.pricing?.inputUsdPerMillionTokens === 0 && model.pricing?.outputUsdPerMillionTokens === 0)
  );
}

function providerRoutingFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("no endpoints") || lower.includes("provider") || lower.includes("routing");
}

function retryAfterFromHeader(headerValue: string | null, now: Date): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - now.getTime()) / 1_000));
  }
  return undefined;
}

function asPositiveSeconds(value: unknown): number | undefined {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function findRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;
  return (
    asPositiveSeconds(object.retry_after_seconds) ??
    asPositiveSeconds(object.retry_after) ??
    findRetryAfterSeconds(object.error) ??
    findRetryAfterSeconds(object.metadata)
  );
}

function parseRetryAfterSeconds(body: string, headers: Headers, policy: RetryPolicy): number | undefined {
  const headerSeconds = retryAfterFromHeader(headers.get("retry-after"), policy.now());
  if (headerSeconds !== undefined) return headerSeconds;
  try {
    return findRetryAfterSeconds(JSON.parse(body));
  } catch {
    return undefined;
  }
}

function extractErrorMessage(body: string, fallback: string): string {
  if (!body.trim()) return fallback;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error === "object" && parsed.error !== null) {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Plain-text provider errors are useful as-is.
  }
  return body;
}

function buildRateLimitMessage(
  model: OrReviewConfig["models"][number],
  config: OrReviewConfig,
  attempts: number,
  retryAfterSeconds: number | undefined,
  providerMessage: string
): string {
  const retryCount = Math.max(0, attempts - 1);
  const retryPart = retryAfterSeconds === undefined ? "" : `; retry_after_seconds=${retryAfterSeconds}`;
  const providerPart = providerMessage ? ` ${providerMessage}` : "";
  const hint =
    config.provider.dataCollection === "deny" && isFreeModel(model)
      ? "\nHint: free model endpoints may be unavailable under dataCollection: deny."
      : "";
  return `OpenRouter/provider rate limit hit for this model. Retried ${retryCount} time(s)${retryPart}.${providerPart}${hint}`;
}

async function callOpenRouter(
  fetchImpl: FetchLike,
  apiKey: string,
  config: OrReviewConfig,
  model: OrReviewConfig["models"][number],
  bundle: ContextBundle,
  mode: RequestMode
): Promise<unknown> {
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? defaultOpenRouterBaseUrl).replace(/\/$/, "");
  const structured = mode === "structured";
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      {
        role: "user",
        content: structured
          ? reviewPrompt(bundle, model.perspective)
          : `${reviewPrompt(bundle, model.perspective)}\n\nReturn valid JSON only.`
      }
    ],
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
  }

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
    throw new OpenRouterHttpError(
      responseBody || `OpenRouter HTTP ${response.status}`,
      response.status,
      responseBody,
      response.headers
    );
  }
  return JSON.parse(responseBody);
}

function failedResult(
  model: OrReviewConfig["models"][number],
  raw: unknown,
  error: string,
  failureKind: ModelFailureKind,
  attempts: number,
  retryAfterSeconds: number | undefined,
  attemptDiagnostics: AttemptDiagnostic[]
): ModelExecutionResult {
  return {
    alias: model.alias,
    modelId: model.id,
    ok: false,
    raw,
    findings: [],
    error,
    failureKind,
    attempts: attempts > 0 ? attempts : undefined,
    retryAfterSeconds,
    attemptDiagnostics: attemptDiagnostics.length > 0 ? attemptDiagnostics : undefined
  };
}

export async function executeModels(
  config: OrReviewConfig,
  bundle: ContextBundle,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  options: ExecuteModelsOptions = {}
): Promise<ModelExecutionResult[]> {
  const retryPolicy = options.retryPolicy ?? defaultRetryPolicy;

  return Promise.all(
    config.models.map(async (model) => {
      let raw: unknown;
      let attempts = 0;
      let rateLimitRetries = 0;
      let lastRetryAfterSeconds: number | undefined;
      let mode: RequestMode = "structured";
      const attemptDiagnostics: AttemptDiagnostic[] = [];

      while (true) {
        attempts += 1;
        try {
          raw = await callOpenRouter(fetchImpl, apiKey, config, model, bundle, mode);
          const parsed = parseModelJson(raw);
          const findings = normalize(model.alias, parsed);
          return {
            alias: model.alias,
            modelId: model.id,
            ok: true,
            raw,
            findings,
            attempts: attempts > 1 ? attempts : undefined,
            retryAfterSeconds: lastRetryAfterSeconds,
            attemptDiagnostics: attemptDiagnostics.length > 0 ? attemptDiagnostics : undefined
          };
        } catch (error) {
          if (error instanceof OpenRouterHttpError && error.status === 429) {
            const retryAfterSeconds = parseRetryAfterSeconds(error.body, error.headers, retryPolicy);
            const canRetry = rateLimitRetries < retryPolicy.maxRetries;
            const providerMessage = extractErrorMessage(error.body, error.message);
            const backoffMs = retryAfterSeconds === undefined
              ? retryPolicy.defaultBackoffMs(rateLimitRetries + 1)
              : retryAfterSeconds * 1_000;
            lastRetryAfterSeconds = retryAfterSeconds;
            attemptDiagnostics.push({
              mode,
              status: error.status,
              retryAfterSeconds,
              message: providerMessage,
              retried: canRetry
            });

            if (canRetry) {
              rateLimitRetries += 1;
              await retryPolicy.sleep(Math.min(backoffMs, retryPolicy.maxBackoffMs));
              continue;
            }

            return failedResult(
              model,
              raw ?? null,
              buildRateLimitMessage(model, config, attempts, retryAfterSeconds, providerMessage),
              "rate_limited",
              attempts,
              retryAfterSeconds,
              attemptDiagnostics
            );
          }

          if (isStructuredOutputRejection(error) && mode === "structured") {
            const httpError = error as OpenRouterHttpError;
            attemptDiagnostics.push({
              mode,
              status: httpError.status,
              message: extractErrorMessage(httpError.body, httpError.message),
              retried: true
            });
            mode = "json_prompt";
            continue;
          }

          if (error instanceof InvalidStructuredOutputError) {
            return failedResult(
              model,
              raw ?? null,
              `Model returned invalid structured output: ${error.message} See raw/${model.alias}.json.`,
              "invalid_structured_output",
              attempts,
              lastRetryAfterSeconds,
              attemptDiagnostics
            );
          }

          if (error instanceof OpenRouterHttpError) {
            const providerMessage = extractErrorMessage(error.body, error.message);
            const hint =
              config.provider.dataCollection === "deny" && isFreeModel(model) && providerRoutingFailure(providerMessage)
                ? "\nHint: free model endpoints may be unavailable under dataCollection: deny."
                : "";
            attemptDiagnostics.push({
              mode,
              status: error.status,
              message: providerMessage,
              retried: false
            });
            return failedResult(model, raw ?? null, `${providerMessage}${hint}`, "unknown", attempts, lastRetryAfterSeconds, attemptDiagnostics);
          }

          if (error instanceof TypeError) {
            return failedResult(model, raw ?? null, error.message, "network_error", attempts, lastRetryAfterSeconds, attemptDiagnostics);
          }

          const message = error instanceof Error ? error.message : "Unknown error.";
          return failedResult(model, raw ?? null, message, "unknown", attempts, lastRetryAfterSeconds, attemptDiagnostics);
        }
      }
    })
  );
}
