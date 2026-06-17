import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrReviewConfig } from "./config.js";
import { defaultAssessmentLedgerPath } from "./config.js";
import { UserError } from "./errors.js";

export type AssessmentInput = {
  runId: string;
  modelAlias: string;
  usefulness: number;
  note: string;
};

type AssessmentRecord = AssessmentInput & {
  assessedAt: string;
};

type RunAssessmentFile = {
  runId: string;
  assessments: AssessmentRecord[];
};

async function readRunAssessments(assessmentPath: string, runId: string): Promise<RunAssessmentFile> {
  if (!existsSync(assessmentPath)) return { runId, assessments: [] };
  const parsed = JSON.parse(await readFile(assessmentPath, "utf8")) as Partial<RunAssessmentFile> | AssessmentRecord;
  if (Array.isArray((parsed as Partial<RunAssessmentFile>).assessments)) {
    return { runId, assessments: (parsed as RunAssessmentFile).assessments };
  }
  if ("modelAlias" in parsed) {
    return { runId, assessments: [parsed as AssessmentRecord] };
  }
  return { runId, assessments: [] };
}

export async function recordAssessment(repoRoot: string, config: OrReviewConfig, input: AssessmentInput): Promise<{ runDir: string; ledgerPath: string }> {
  if (!Number.isInteger(input.usefulness) || input.usefulness < 1 || input.usefulness > 5) {
    throw new UserError("--usefulness must be an integer from 1 to 5.");
  }
  if (!input.modelAlias) throw new UserError("--model is required.");
  if (!input.note) throw new UserError("--note is required.");

  const runDir = path.resolve(repoRoot, config.reports.dir, input.runId);
  const reportPath = path.join(runDir, "report.json");
  if (!existsSync(reportPath)) throw new UserError(`Unknown run ${input.runId}. Expected ${reportPath}`);

  const report = JSON.parse(await readFile(reportPath, "utf8")) as { models?: Array<{ alias: string }> };
  if (!report.models?.some((model) => model.alias === input.modelAlias)) {
    throw new UserError(`Unknown model alias ${input.modelAlias} for run ${input.runId}.`);
  }

  const assessment = { ...input, assessedAt: new Date().toISOString() };
  const assessmentPath = path.join(runDir, "assessment.json");
  const runAssessments = await readRunAssessments(assessmentPath, input.runId);
  const existingIndex = runAssessments.assessments.findIndex((entry) => entry.modelAlias === input.modelAlias);
  if (existingIndex >= 0) {
    runAssessments.assessments[existingIndex] = assessment;
  } else {
    runAssessments.assessments.push(assessment);
  }
  await writeFile(assessmentPath, `${JSON.stringify(runAssessments, null, 2)}\n`, "utf8");

  const ledgerPath = config.assessmentLedger.path || defaultAssessmentLedgerPath();
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(assessment)}\n`, "utf8");
  return { runDir, ledgerPath };
}
