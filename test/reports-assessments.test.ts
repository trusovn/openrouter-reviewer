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

  it("rejects invalid assessment inputs", async () => {
    const cwd = await tempDir();
    const config = configSchema.parse({
      models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }]
    });

    await expect(recordAssessment(cwd, config, { runId: "missing", modelAlias: "a", usefulness: 9, note: "x" })).rejects.toThrow("1 to 5");
  });
});
