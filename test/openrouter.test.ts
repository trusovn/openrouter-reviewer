import { describe, expect, it } from "vitest";
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

describe("OpenRouter execution", () => {
  it("normalizes successful structured JSON and sends privacy settings", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return ok({ choices: [{ message: { content: JSON.stringify({ findings: [{ severity: "high", category: "bug", location: "x", finding: "f", evidence: "e", recommendation: "r", confidence: 0.8 }] }) } }] });
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]?.findings[0]?.id).toBe("a-1");
    expect(bodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          max_tokens: 123,
          provider: { data_collection: "deny", zdr: false }
        })
      ])
    );
  });

  it("retries structured output rejection and marks invalid JSON failures partially", async () => {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1 || call === 3) return new Response("response_format rejected", { status: 400 });
      if (call === 2) return ok({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] });
      return ok({ choices: [{ message: { content: "not json" } }] });
    };

    const results = await executeModels(config, bundle, "key", fetchImpl as typeof fetch);

    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
  });
});

