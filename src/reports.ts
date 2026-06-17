import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContextBundle } from "./collectors.js";
import type { OrReviewConfig } from "./config.js";
import type { AttemptDiagnostic, ModelExecutionResult, ModelFailureKind, NormalizedFinding } from "./openrouter.js";

export type ModelReport = {
  alias: string;
  modelId: string;
  ok: boolean;
  error?: string;
  failureKind?: ModelFailureKind;
  attempts?: number;
  retryAfterSeconds?: number;
};

export type RunReport = {
  runId: string;
  mode: string;
  instruction: string;
  findings: NormalizedFinding[];
  models: ModelReport[];
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
    models: results.map((result) => {
      const model: ModelReport = {
        alias: result.alias,
        modelId: result.modelId,
        ok: result.ok,
        error: result.error,
        failureKind: result.failureKind,
      };
      if (result.attempts !== undefined) {
        model.attempts = result.attempts;
      }
      if (result.retryAfterSeconds !== undefined) {
        model.retryAfterSeconds = result.retryAfterSeconds;
      }
      return model;
    }),
    contextHash: createHash("sha256").update(bundle.context).digest("hex"),
  };
}

export function renderMarkdown(report: RunReport): string {
  const lines = [`# OpenRouter Review ${report.runId}`, "", `Mode: ${report.mode}`, "", "## Models"];
  for (const model of report.models) {
    if (model.ok) {
      lines.push(`- ${model.alias} (${model.modelId}): ok`);
    } else {
      const parts: string[] = [];
      if (model.failureKind && model.failureKind !== "unknown") {
        parts.push(model.failureKind);
      }
      if (model.error) {
        parts.push(model.error);
      }
      lines.push(`- ${model.alias} (${model.modelId}): failed - ${parts.join(" - ") || "unknown error"}`);
    }
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
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeRunReport(
  repoRoot: string,
  config: OrReviewConfig,
  bundle: ContextBundle,
  results: ModelExecutionResult[]
): Promise<WrittenReport> {
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
    const rawContent = result.raw ?? null;
    if (result.ok) {
      await writeFile(
        path.join(runDir, "raw", `${result.alias}.json`),
        `${JSON.stringify(rawContent, null, 2)}\n`,
        "utf8"
      );
    } else if (result.attemptDiagnostics && result.attemptDiagnostics.length > 0) {
      const diagnostic: {
        ok: false;
        failureKind?: ModelFailureKind;
        attempts: AttemptDiagnostic[];
        message?: string;
        retryAfterSeconds?: number;
      } = {
        ok: false,
        failureKind: result.failureKind,
        attempts: result.attemptDiagnostics,
        message: result.error,
        retryAfterSeconds: result.retryAfterSeconds,
      };
      await writeFile(
        path.join(runDir, "raw", `${result.alias}.json`),
        `${JSON.stringify(diagnostic, null, 2)}\n`,
        "utf8"
      );
    } else if (result.raw !== null && result.raw !== undefined) {
      await writeFile(
        path.join(runDir, "raw", `${result.alias}.json`),
        `${JSON.stringify(rawContent, null, 2)}\n`,
        "utf8"
      );
    } else {
      const diagnostic = {
        ok: false,
        failureKind: result.failureKind,
        attempts: result.attempts,
        message: result.error,
        retryAfterSeconds: result.retryAfterSeconds,
      };
      await writeFile(
        path.join(runDir, "raw", `${result.alias}.json`),
        `${JSON.stringify(diagnostic, null, 2)}\n`,
        "utf8"
      );
    }
  }

  return { runId, runDir, reportMdPath, reportJsonPath };
}
