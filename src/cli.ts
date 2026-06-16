#!/usr/bin/env node
import { Command } from "commander";
import { assertWithinBudget, estimateRunCost } from "./budget.js";
import { collectDiffContext, collectFilesContext, collectSddContext, type ContextBundle } from "./collectors.js";
import { loadConfig, requireApiKey, writeInitialConfig, type CliConfigOverrides, type OrReviewConfig } from "./config.js";
import { UserError } from "./errors.js";
import { executeModels } from "./openrouter.js";
import { recordAssessment } from "./assessments.js";
import { writeRunReport } from "./reports.js";

const packageMetadata = {
  name: "openrouter-reviewer",
  version: "0.1.0"
};

type ReviewOptions = CliConfigOverrides & {
  instruction?: string;
};

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number, received ${value}`);
  return parsed;
}

function addConfigFlags(command: Command): Command {
  return command
    .option("--config <path>", "Config file path", (value) => value)
    .option("--max-usd-per-run <amount>", "Override run budget", parseNumber)
    .option("--max-output-tokens-per-model <tokens>", "Override output token cap", parseNumber)
    .option("--max-file-bytes <bytes>", "Override file size limit", parseNumber)
    .option("--max-context-chars <chars>", "Override context character cap", parseNumber)
    .option("--reports-dir <path>", "Override reports directory")
    .option("--assessment-ledger-path <path>", "Override assessment JSONL ledger path");
}

function cliOverrides(options: Record<string, unknown>): CliConfigOverrides {
  return {
    configPath: options.config as string | undefined,
    maxUsdPerRun: options.maxUsdPerRun as number | undefined,
    maxOutputTokensPerModel: options.maxOutputTokensPerModel as number | undefined,
    maxFileBytes: options.maxFileBytes as number | undefined,
    maxContextChars: options.maxContextChars as number | undefined,
    reportsDir: options.reportsDir as string | undefined,
    assessmentLedgerPath: options.assessmentLedgerPath as string | undefined
  };
}

async function runReview(
  cwd: string,
  options: ReviewOptions,
  collect: (config: OrReviewConfig) => Promise<ContextBundle>
): Promise<void> {
  if (!options.instruction) throw new UserError("--instruction is required.");
  const config = await loadConfig(cwd, cliOverrides(options));
  const bundle = await collect(config);
  const estimate = estimateRunCost(config, bundle);
  assertWithinBudget(config, estimate);
  const apiKey = requireApiKey();
  const results = await executeModels(config, bundle, apiKey);
  const written = await writeRunReport(cwd, config, bundle, results);
  console.log(`Run: ${written.runDir}`);
  console.log(`Markdown: ${written.reportMdPath}`);
  console.log(`JSON: ${written.reportJsonPath}`);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("or-review")
    .description("Ask OpenRouter models to review SDD artifacts, diffs, or explicit files.")
    .version(packageMetadata.version)
    .showHelpAfterError();

  program
    .command("init")
    .description("Create an or-review config skeleton.")
    .option("--output <path>", "Config path to write")
    .action(async (options: { output?: string }) => {
      const written = await writeInitialConfig(process.cwd(), options.output);
      console.log(`Wrote ${written}`);
    });

  addConfigFlags(program.command("sdd"))
    .description("Review SDD artifacts for a feature.")
    .requiredOption("--feature <slug>", "Feature slug under docs/features")
    .requiredOption("--instruction <goal>", "Review instruction")
    .action(async (options: ReviewOptions & { feature: string }) => {
      await runReview(process.cwd(), options, (config) => collectSddContext(process.cwd(), options.feature, options.instruction ?? "", config));
    });

  addConfigFlags(program.command("diff"))
    .description("Review a git diff.")
    .option("--base <ref>", "Base ref", "HEAD")
    .requiredOption("--instruction <goal>", "Review instruction")
    .action(async (options: ReviewOptions & { base: string }) => {
      await runReview(process.cwd(), options, (config) => collectDiffContext(process.cwd(), options.base, options.instruction ?? "", config));
    });

  addConfigFlags(program.command("files"))
    .description("Review explicit files.")
    .requiredOption("--file <path...>", "File path(s) to review")
    .requiredOption("--instruction <goal>", "Review instruction")
    .action(async (options: ReviewOptions & { file: string[] }) => {
      await runReview(process.cwd(), options, (config) => collectFilesContext(process.cwd(), options.file, options.instruction ?? "", config));
    });

  addConfigFlags(program.command("assess <run-id>"))
    .description("Record lead-agent usefulness feedback for a review run.")
    .requiredOption("--model <alias>", "Model alias")
    .requiredOption("--usefulness <score>", "Usefulness score 1-5", parseNumber)
    .requiredOption("--note <text>", "Assessment note")
    .action(async (runId: string, options: CliConfigOverrides & { model: string; usefulness: number; note: string }) => {
      const config = await loadConfig(process.cwd(), cliOverrides(options));
      const result = await recordAssessment(process.cwd(), config, {
        runId,
        modelAlias: options.model,
        usefulness: options.usefulness,
        note: options.note
      });
      console.log(`Assessment: ${result.runDir}/assessment.json`);
      console.log(`Ledger: ${result.ledgerPath}`);
    });

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createProgram().parseAsync(process.argv).catch((error: unknown) => {
    if (error instanceof UserError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
