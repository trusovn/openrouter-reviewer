import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContextBundle } from "./collectors.js";
import type { OrReviewConfig } from "./config.js";
import type { ModelExecutionResult, NormalizedFinding } from "./openrouter.js";

export type RunReport = {
  runId: string;
  mode: string;
  instruction: string;
  findings: NormalizedFinding[];
  models: Array<{ alias: string; modelId: string; ok: boolean; error?: string }>;
  contextHash: string;
};

export type WrittenReport = {
  runId: string;
  runDir: string;
  reportMdPath: string;
  reportJsonPath: string;
};

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

export function createRunId(): string {
  return `${timestamp()}-${randomBytes(3).toString("hex")}`;
}

export function makeReport(runId: string, bundle: ContextBundle, results: ModelExecutionResult[]): RunReport {
  return {
    runId,
    mode: bundle.mode,
    instruction: bundle.instruction,
    findings: results.flatMap((result) => result.findings),
    models: results.map((result) => ({ alias: result.alias, modelId: result.modelId, ok: result.ok, error: result.error })),
    contextHash: createHash("sha256").update(bundle.context).digest("hex")
  };
}

export function renderMarkdown(report: RunReport): string {
  const lines = [`# OpenRouter Review ${report.runId}`, "", `Mode: ${report.mode}`, "", "## Models"];
  for (const model of report.models) {
    lines.push(`- ${model.alias} (${model.modelId}): ${model.ok ? "ok" : `failed - ${model.error ?? "unknown error"}`}`);
  }
  lines.push("", "## Findings");
  if (report.findings.length === 0) lines.push("- No findings.");
  for (const finding of report.findings) {
    lines.push(
      `### ${finding.id}: ${finding.severity} ${finding.category}`,
      "",
      `- Location: ${finding.location}`,
      `- Confidence: ${finding.confidence}`,
      `- Finding: ${finding.finding}`,
      `- Evidence: ${finding.evidence}`,
      `- Recommendation: ${finding.recommendation}`,
      ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeRunReport(repoRoot: string, config: OrReviewConfig, bundle: ContextBundle, results: ModelExecutionResult[]): Promise<WrittenReport> {
  const runId = createRunId();
  const runDir = path.resolve(repoRoot, config.reports.dir, runId);
  await mkdir(path.join(runDir, "raw"), { recursive: true });

  const report = makeReport(runId, bundle, results);
  const reportMdPath = path.join(runDir, "report.md");
  const reportJsonPath = path.join(runDir, "report.json");
  await writeFile(reportMdPath, renderMarkdown(report), "utf8");
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "context-preview.md"), `${bundle.preview}\n`, "utf8");

  for (const result of results) {
    await writeFile(path.join(runDir, "raw", `${result.alias}.json`), `${JSON.stringify(result.raw, null, 2)}\n`, "utf8");
  }

  return { runId, runDir, reportMdPath, reportJsonPath };
}

