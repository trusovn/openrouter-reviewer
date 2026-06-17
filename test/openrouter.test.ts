import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextBundle } from "../src/collectors.js";
import { configSchema } from "../src/config.js";
import { executeModels } from "../src/openrouter.js";

const bundle: ContextBundle = {
  mode: "files",
  instruction: "review",
  context: "context",
  preview: "",
  inputs: []
};

const config = configSchema.parse({
  models: [
      { alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
      { alias: "b", id: "model-b", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }
    ],
  budget: { maxUsdPerRun: 1, maxOutputTokensPerModel: 123 }
});

const singleModelConfig = configSchema.parse({
  models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }],
  budget: { maxUsdPerRun: 1, maxOutputTokensPerModel: 123 }
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function responseWithFindings(findings: unknown[] = []): Response {
  return ok({ choices: [{ message: { content: JSON.stringify({ findings }) } }] });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function retryPolicy() {
  return {
    maxRetries: 2,
    maxBackoffMs: 30_000,
    defaultBackoffMs: (attempt: number) => attempt * 1_000,
    sleep: vi.fn(async () => {}),
    now: () => new Date("2026-06-17T00:00:00.000Z")
  };
}

function executeSingleModelWithRetryPolicy(fetchImpl: typeof fetch, policy: ReturnType<typeof retryPolicy>) {
  const executeWithOptions = executeModels as unknown as (
    configArg: typeof singleModelConfig,
    bundleArg: ContextBundle,
    apiKey: string,
    fetchArg: typeof fetch,
    options: { retryPolicy: ReturnType<typeof retryPolicy> }
  ) => ReturnType<typeof executeModels>;

  return executeWithOptions(singleModelConfig, bundle, "key", fetchImpl, { retryPolicy: policy });
}

describe("OpenRouter execution", () => {
  const originalBaseUrl = process.env.OPENROUTER_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = originalBaseUrl;
  });

  it("normalizes successful structured JSON and sends privacy settings on each request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init));
      return responseWithFindings([
        { severity: "high", category: "bug", location: "x", finding: "f", evidence: "e", recommendation: "r", confidence: 0.8 }
      ]);
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]?.findings[0]?.id).toBe("a-1");
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.max_tokens).toBe(123);
      expect(body.provider).toEqual({ data_collection: "deny", zdr: false });
      expect(body.response_format).toBeDefined();
    }
  });

  it("uses OPENROUTER_BASE_URL when provided for mocked acceptance servers", async () => {
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:4567/v1/";
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      urls.push(String(url));
      return responseWithFindings();
    };

    await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(urls).toEqual([
      "http://127.0.0.1:4567/v1/chat/completions",
      "http://127.0.0.1:4567/v1/chat/completions"
    ]);
  });

  it("retries structured output rejection and marks invalid JSON failures partially", async () => {
    const attempts = new Map<string, number>();
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = requestBody(init);
      const model = String(body.model);
      const nextAttempt = (attempts.get(model) ?? 0) + 1;
      attempts.set(model, nextAttempt);

      if (nextAttempt === 1) return new Response("response_format rejected", { status: 400 });
      if (model === "model-a") return responseWithFindings();
      return ok({ choices: [{ message: { content: "not json" } }] });
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.error).toContain("not valid JSON");
    expect(results[1]?.failureKind).toBe("invalid_structured_output");
    expect(attempts.get("model-a")).toBe(2);
  });

  it("keeps successful models when another model has an API failure", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = requestBody(init);
      if (body.model === "model-a") return new Response("upstream failed", { status: 500 });
      return responseWithFindings([
        { severity: "low", category: "style", location: "y", finding: "f", evidence: "e", recommendation: "r", confidence: 0.5 }
      ]);
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ alias: "a", ok: false, error: "upstream failed" });
    expect(results[0]?.failureKind).toBe("unknown");
    expect(results[1]?.ok).toBe(true);
    expect(results[1]?.findings).toHaveLength(1);
  });

  it("preserves free-model provider routing failures with a dataCollection deny hint", async () => {
    const freeConfig = configSchema.parse({
      models: [{ alias: "free", id: "provider/free:free", pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } }],
      provider: { dataCollection: "deny", zdr: false },
      budget: { maxUsdPerRun: 0, maxOutputTokensPerModel: 123 }
    });
    const fetchImpl = async () => new Response("No endpoints found for provider/free:free", { status: 400 });

    const results = await executeModels(freeConfig, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ alias: "free", ok: false });
    expect(results[0]?.error).toContain("No endpoints found for provider/free:free");
    expect(results[0]?.error).toMatch(/free model.*dataCollection: deny/i);
  });

  it("starts configured model requests concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst: (() => void) | undefined;

    const fetchImpl = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (!releaseFirst) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      } else { releaseFirst(); }
      inFlight -= 1;
      return responseWithFindings();
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxInFlight).toBe(2);
  });

  it("handles null model content as invalid_structured_output", async () => {
    const fetchImpl = async () => ok({ choices: [{ message: { content: null } }] });

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ ok: false, failureKind: "invalid_structured_output" });
    expect(results[0]?.error).toContain("null or missing");
  });

  it("handles non-object JSON as invalid_structured_output", async () => {
    const fetchImpl = async () => ok({ choices: [{ message: { content: 42 } }] });

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ ok: false, failureKind: "invalid_structured_output" });
    expect(results[0]?.error).toContain("not a string");
  });

  it("handles missing content field as null", async () => {
    const fetchImpl = async () => ok({ choices: [{ message: {} }] });

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ ok: false, failureKind: "invalid_structured_output" });
    expect(results[0]?.error).toContain("null or missing");
  });

  it("handles 429 rate limiting with retry_after_seconds body", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: { retry_after_seconds: 0.01 } }), { status: 429 });
      }
      return responseWithFindings();
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0]?.attempts).toBeGreaterThan(1);
  });

  it("retries 429 once using Retry-After header before succeeding", async () => {
    const policy = retryPolicy();
    const responses = [
      new Response(JSON.stringify({ error: { message: "Provider returned rate limit from Venice" } }), {
        status: 429,
        headers: { "Retry-After": "2" }
      }),
      responseWithFindings()
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? responseWithFindings());

    const results = await executeSingleModelWithRetryPolicy(fetchImpl as typeof fetch, policy);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(policy.sleep).toHaveBeenCalledWith(2_000);
    expect(results[0]).toMatchObject({ ok: true, attempts: 2, retryAfterSeconds: 2 });
  });

  it("retries 429 once using nested provider retry_after_seconds before succeeding", async () => {
    const policy = retryPolicy();
    const responses = [
      new Response(
        JSON.stringify({
          error: {
            message: "Provider returned rate limit from Venice",
            metadata: { retry_after_seconds: 3 }
          }
        }),
        { status: 429 }
      ),
      responseWithFindings()
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? responseWithFindings());

    const results = await executeSingleModelWithRetryPolicy(fetchImpl as typeof fetch, policy);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(policy.sleep).toHaveBeenCalledWith(3_000);
    expect(results[0]).toMatchObject({ ok: true, attempts: 2, retryAfterSeconds: 3 });
  });

  it("handles repeated 429 and marks as rate_limited", async () => {
    const fetchImpl = async () => new Response("rate limit exceeded", { status: 429 });

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ ok: false, failureKind: "rate_limited" });
    expect(results[0]?.error).toContain("rate limit");
  });

  it("exhausts bounded 429 retries with rate_limited metadata", async () => {
    const policy = retryPolicy();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Provider returned rate limit from Venice",
              metadata: { retry_after_seconds: 3 }
            }
          }),
          { status: 429 }
        )
    );

    const results = await executeSingleModelWithRetryPolicy(fetchImpl as typeof fetch, policy);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(policy.sleep).toHaveBeenCalledTimes(2);
    expect(results[0]).toMatchObject({
      ok: false,
      failureKind: "rate_limited",
      attempts: 3,
      retryAfterSeconds: 3
    });
    expect(results[0]?.error).toContain("Retried 2 time(s)");
  });

  it("handles free-model 429 with dataCollection deny hint", async () => {
    const freeConfig = configSchema.parse({
      models: [{ alias: "free", id: "provider/free:free", pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } }],
      provider: { dataCollection: "deny", zdr: false },
      budget: { maxUsdPerRun: 0, maxOutputTokensPerModel: 123 }
    });
    const fetchImpl = async () => new Response("rate limit", { status: 429 });

    const results = await executeModels(freeConfig, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ ok: false, failureKind: "rate_limited" });
    expect(results[0]?.error).toMatch(/rate limit/i);
    expect(results[0]?.error).toMatch(/dataCollection: deny/);
  });

  it.each([
    {
      name: "empty choices",
      raw: { choices: [] },
      message: "did not include choices[0].message.content"
    },
    {
      name: "missing message",
      raw: { choices: [{}] },
      message: "did not include choices[0].message.content"
    },
    {
      name: "null content",
      raw: { choices: [{ message: { content: null } }] },
      message: "content was null"
    },
    {
      name: "empty content",
      raw: { choices: [{ message: { content: "" } }] },
      message: "content was empty"
    },
    {
      name: "non-json content",
      raw: { choices: [{ message: { content: "not json" } }] },
      message: "not valid JSON"
    },
    {
      name: "json null content",
      raw: { choices: [{ message: { content: "null" } }] },
      message: "JSON must be an object with a findings array"
    },
    {
      name: "null findings",
      raw: { choices: [{ message: { content: "{\"findings\": null}" } }] },
      message: "JSON must be an object with a findings array"
    }
  ])("returns invalid_structured_output for $name", async ({ raw, message }) => {
    const fetchImpl = async () => ok(raw);

    const results = await executeModels(singleModelConfig, bundle, "key", fetchImpl as typeof fetch);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      alias: "a",
      ok: false,
      failureKind: "invalid_structured_output",
      findings: []
    });
    expect(results[0]?.error).toContain(message);
  });

  it("accepts valid empty findings", async () => {
    const fetchImpl = async () => ok({ choices: [{ message: { content: "{\"findings\": []}" } }] });

    const results = await executeModels(singleModelConfig, bundle, "key", fetchImpl as typeof fetch);

    expect(results).toEqual([
      expect.objectContaining({
        alias: "a",
        ok: true,
        findings: []
      })
    ]);
  });
});
