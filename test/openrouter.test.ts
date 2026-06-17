import { afterEach, describe, expect, it } from "vitest";
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

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function responseWithFindings(findings: unknown[] = []): Response {
  return ok({ choices: [{ message: { content: JSON.stringify({ findings }) } }] });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
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
      return responseWithFindings([{ severity: "high", category: "bug", location: "x", finding: "f", evidence: "e", recommendation: "r", confidence: 0.8 }]);
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

    expect(urls).toEqual(["http://127.0.0.1:4567/v1/chat/completions", "http://127.0.0.1:4567/v1/chat/completions"]);
  });

  it("retries structured output rejection and marks invalid JSON failures partially", async () => {
    const attempts = new Map<string, number>();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = requestBody(init);
      bodies.push(body);
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
    expect(results[1]?.error).toBe("Model response content was not valid JSON.");
    expect(attempts).toEqual(
      new Map([
        ["model-a", 2],
        ["model-b", 2]
      ])
    );
    expect(bodies.filter((body) => body.response_format !== undefined)).toHaveLength(2);
    expect(bodies.filter((body) => body.response_format === undefined)).toHaveLength(2);
    for (const body of bodies) {
      expect(body.max_tokens).toBe(123);
      expect(body.provider).toEqual({ data_collection: "deny", zdr: false });
    }
  });

  it("keeps successful models when another model has an API failure", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = requestBody(init);
      if (body.model === "model-a") return new Response("upstream failed", { status: 500 });
      return responseWithFindings([{ severity: "low", category: "style", location: "y", finding: "f", evidence: "e", recommendation: "r", confidence: 0.5 }]);
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]).toMatchObject({ alias: "a", ok: false, error: "upstream failed" });
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
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      } else {
        releaseFirst();
      }
      inFlight -= 1;
      return responseWithFindings();
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxInFlight).toBe(2);
  });
});
