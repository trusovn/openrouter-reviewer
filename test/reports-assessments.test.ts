import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ContextBundle } from "../src/collectors.js";
import { configSchema } from "../src/config.js";
import { recordAssessment } from "../src/assessments.js";
import { writeRunReport } from "../src/reports.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "or-review-report-"));
}

const bundle: ContextBundle = {
  mode: "files",
  instruction: "review",
  context: "context",
  preview: "# Context Preview\n",
  inputs: []
};

describe("reports and assessments", () => {
  it("writes markdown, json, raw output, partial failure details, and assessments", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "reviewed.txt"), "unchanged", "utf8");
    const config = configSchema.parse({
      models: [
        { alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
        { alias: "b", id: "model-b", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }
      ],
      reports: { dir: ".or-review/runs" },
      assessmentLedger: { path: path.join(cwd, "ledger.jsonl") }
    });

    const written = await writeRunReport(cwd, config, bundle, [
      {
        alias: "a",
        modelId: "model-a",
        ok: false,
        raw: { raw: true },
        error: "boom",
        findings: []
      },
      {
        alias: "b",
        modelId: "model-b",
        ok: true,
        raw: { raw: true },
        findings: []
      }
    ]);
    const reportJson = JSON.parse(await readFile(written.reportJsonPath, "utf8")) as { models: Array<{ ok: boolean; error?: string }> };
    expect(await readFile(written.reportMdPath, "utf8")).toContain("failed - boom");
    expect(reportJson.models[0]).toMatchObject({ ok: false, error: "boom" });
    expect(await readFile(path.join(written.runDir, "raw", "a.json"), "utf8")).toContain("raw");

    const before = await readFile(path.join(cwd, "reviewed.txt"), "utf8");
    await recordAssessment(cwd, config, { runId: written.runId, modelAlias: "a", usefulness: 4, note: "useful" });
    await recordAssessment(cwd, config, { runId: written.runId, modelAlias: "b", usefulness: 5, note: "very useful" });
    await recordAssessment(cwd, config, { runId: written.runId, modelAlias: "a", usefulness: 3, note: "less useful" });
    const after = await readFile(path.join(cwd, "reviewed.txt"), "utf8");
    const assessmentJson = JSON.parse(await readFile(path.join(written.runDir, "assessment.json"), "utf8")) as {
      assessments: Array<{ modelAlias: string; note: string }>;
    };

    expect(after).toBe(before);
    expect(assessmentJson.assessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelAlias: "a", note: "less useful" }),
        expect.objectContaining({ modelAlias: "b", note: "very useful" })
      ])
    );
    expect(assessmentJson.assessments).toHaveLength(2);
    expect((await readFile(path.join(cwd, "ledger.jsonl"), "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("includes typed model failure metadata in json and markdown reports", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      models: [
        { alias: "rate", id: "model-rate", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
        { alias: "invalid", id: "model-invalid", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }
      ],
      reports: { dir: ".or-review/runs" }
    });

    const written = await writeRunReport(cwd, config, bundle, [
      {
        alias: "rate",
        modelId: "model-rate",
        ok: false,
        raw: null,
        findings: [],
        error: "OpenRouter/provider rate limited this model. Retried 2 time(s); retry_after_seconds=3.",
        failureKind: "rate_limited",
        attempts: 3,
        retryAfterSeconds: 3
      },
      {
        alias: "invalid",
        modelId: "model-invalid",
        ok: false,
        raw: { choices: [{ message: { content: null } }] },
        findings: [],
        error: "Model returned invalid structured output: Model response content was null. See raw/invalid.json.",
        failureKind: "invalid_structured_output",
        attempts: 1
      }
    ]);

    const reportJson = JSON.parse(await readFile(written.reportJsonPath, "utf8")) as {
      models: Array<{ failureKind?: string; attempts?: number; retryAfterSeconds?: number }>;
    };
    expect(reportJson.models[0]).toMatchObject({
      failureKind: "rate_limited",
      attempts: 3,
      retryAfterSeconds: 3
    });
    expect(reportJson.models[1]).toMatchObject({
      failureKind: "invalid_structured_output",
      attempts: 1
    });

    const markdown = await readFile(written.reportMdPath, "utf8");
    expect(markdown).toContain(
      "rate (model-rate): failed - rate_limited - OpenRouter/provider rate limited this model. Retried 2 time(s); retry_after_seconds=3."
    );
    expect(markdown).toContain(
      "invalid (model-invalid): failed - invalid_structured_output - Model returned invalid structured output"
    );
  });

  it("writes failed raw output as safe attempt diagnostics", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      models: [{ alias: "rate", id: "model-rate", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }],
      reports: { dir: ".or-review/runs" }
    });

    const written = await writeRunReport(cwd, config, bundle, [
      {
        alias: "rate",
        modelId: "model-rate",
        ok: false,
        raw: null,
        findings: [],
        error: "OpenRouter/provider rate limited this model. Retried 2 time(s); retry_after_seconds=3.",
        failureKind: "rate_limited",
        attempts: 3,
        retryAfterSeconds: 3,
        attemptDiagnostics: [
          {
            mode: "structured",
            status: 429,
            retryAfterSeconds: 3,
            message: "Provider returned rate limit from Venice",
            retried: true
          },
          {
            mode: "structured",
            status: 429,
            retryAfterSeconds: 3,
            message: "Provider returned rate limit from Venice",
            retried: false
          }
        ]
      } as never
    ]);

    const rawText = await readFile(path.join(written.runDir, "raw", "rate.json"), "utf8");
    const rawJson = JSON.parse(rawText) as {
      ok?: boolean;
      failureKind?: string;
      attempts?: Array<{ mode?: string; status?: number; retryAfterSeconds?: number; message?: string; retried?: boolean }>;
    };

    expect(rawJson).toMatchObject({
      ok: false,
      failureKind: "rate_limited",
      attempts: [
        {
          mode: "structured",
          status: 429,
          retryAfterSeconds: 3,
          message: "Provider returned rate limit from Venice",
          retried: true
        },
        {
          mode: "structured",
          status: 429,
          retryAfterSeconds: 3,
          message: "Provider returned rate limit from Venice",
          retried: false
        }
      ]
    });
    expect(rawText).not.toContain("Authorization");
    expect(rawText).not.toContain("Bearer");
    expect(rawText).not.toContain("sk-or-");
    expect(rawText).not.toContain(bundle.context);
    expect(rawText).not.toContain(bundle.instruction);
  });

  it("renders invalid structured output failures without implementation TypeErrors", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      models: [{ alias: "invalid", id: "model-invalid", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }],
      reports: { dir: ".or-review/runs" }
    });

    const written = await writeRunReport(cwd, config, bundle, [
      {
        alias: "invalid",
        modelId: "model-invalid",
        ok: false,
        raw: { choices: [{ message: { content: null } }] },
        findings: [],
        error: "Model returned invalid structured output: Model response content was null. See raw/invalid.json.",
        failureKind: "invalid_structured_output",
        attempts: 1
      }
    ]);

    const markdown = await readFile(written.reportMdPath, "utf8");
    const json = await readFile(written.reportJsonPath, "utf8");
    expect(markdown).toContain("invalid structured output");
    expect(markdown).not.toContain("Cannot read properties");
    expect(json).not.toContain("Cannot read properties");
  });

  it("rejects invalid assessment inputs", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }]
    });

    await expect(recordAssessment(cwd, config, { runId: "missing", modelAlias: "a", usefulness: 9, note: "x" })).rejects.toThrow("1 to 5");
  });
});
