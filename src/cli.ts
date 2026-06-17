#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { assertWithinBudget, estimateRunCost } from "./budget.js";
import { collectDiffContext, collectFilesContext, collectSddContext, type ContextBundle } from "./collectors.js";
import {
  assertReviewConfigReady,
  loadConfig,
  loadEnvironment,
  requireApiKey,
  writeInitialConfig,
  type CliConfigOverrides,
  type OrReviewConfig
} from "./config.js";
import { UserError } from "./errors.js";
import { executeModels } from "./openrouter.js";
import { recordAssessment } from "./assessments.js";
import { writeRunReport } from "./reports.js";
import { createOpenRouterMetadataClient, resolvePricing, type MetadataClient } from "./pricing.js";
import { runDoctor } from "./doctor.js";

const packageMetadata = {
  name: "openrouter-reviewer",
  version: "0.1.0"
};

type ReviewOptions = CliConfigOverrides & {
  instruction?: string;
};

export type CliDependencies = {
  cwd?: string;
  executeModels?: typeof executeModels;
  metadataClient?: MetadataClient;
  log?: (message: string) => void;
};

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number, received ${value}`);
  return parsed;
}

function addConfigFlags(command: Command, options: { envFile?: boolean } = {}): Command {
  const configured = command.option("--config <path>", "Config file path", (value) => value);
  if (options.envFile) configured.option("--env-file <path>", "Env file path");
  return configured
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
    envFile: options.envFile as string | undefined,
    maxUsdPerRun: options.maxUsdPerRun as number | undefined,
    maxOutputTokensPerModel: options.maxOutputTokensPerModel as number | undefined,
    maxFileBytes: options.maxFileBytes as number | undefined,
    maxContextChars: options.maxContextChars as number | undefined,
    reportsDir: options.reportsDir as string | undefined,
    assessmentLedgerPath: options.assessmentLedgerPath as string | undefined
  };
}

function hasModelPricing(config: OrReviewConfig): boolean {
  return config.models.every((model) => model.pricing !== undefined);
}

async function runReview(
  cwd: string,
  options: ReviewOptions,
  collect: (config: OrReviewConfig) => Promise<ContextBundle>,
  dependencies: CliDependencies
): Promise<void> {
  if (!options.instruction) throw new UserError("--instruction is required.");
  const env = await loadEnvironment(cwd, { envFile: options.envFile });
  const config = await loadConfig(cwd, cliOverrides(options));
  assertReviewConfigReady(config);
  const bundle = await collect(config);
  const apiKey = requireApiKey(env);
  const pricedConfig = hasModelPricing(config)
    ? config
    : (
        await resolvePricing({
          cwd,
          config,
          metadataClient: dependencies.metadataClient ?? createOpenRouterMetadataClient(apiKey)
        })
      ).config;
  const estimate = estimateRunCost(pricedConfig, bundle);
  assertWithinBudget(pricedConfig, estimate);
  const results = await (dependencies.executeModels ?? executeModels)(pricedConfig, bundle, apiKey);
  const written = await writeRunReport(cwd, pricedConfig, bundle, results);
  const log = dependencies.log ?? console.log;
  log(`Run: ${written.runDir}`);
  log(`Markdown: ${written.reportMdPath}`);
  log(`JSON: ${written.reportJsonPath}`);

  if (results.every((result) => !result.ok)) {
    throw new UserError(`All ${results.length} models failed. See ${written.reportMdPath}.`);
  }
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const program = new Command();
  const cwd = dependencies.cwd ?? process.cwd();
  const log = dependencies.log ?? console.log;

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
      const written = await writeInitialConfig(cwd, options.output);
      log(`Wrote ${written}`);
    });

  addConfigFlags(program.command("sdd"), { envFile: true })
    .description("Review SDD artifacts for a feature.")
    .requiredOption("--feature <slug>", "Feature slug under docs/features")
    .requiredOption("--instruction <goal>", "Review instruction")
    .action(async (options: ReviewOptions & { feature: string }) => {
      await runReview(cwd, options, (config) => collectSddContext(cwd, options.feature, options.instruction ?? "", config), dependencies);
    });

  addConfigFlags(program.command("diff"), { envFile: true })
    .description("Review a git diff.")
    .option("--base <ref>", "Base ref", "HEAD")
    .requiredOption("--instruction <goal>", "Review instruction")
    .action(async (options: ReviewOptions & { base: string }) => {
      await runReview(cwd, options, (config) => collectDiffContext(cwd, options.base, options.instruction ?? "", config), dependencies);
    });

  addConfigFlags(program.command("files"), { envFile: true })
    .description("Review explicit files.")
    .requiredOption("--file <path...>", "File path(s) to review")
    .requiredOption("--instruction <goal>", "Review instruction")
    .action(async (options: ReviewOptions & { file: string[] }) => {
      await runReview(cwd, options, (config) => collectFilesContext(cwd, options.file, options.instruction ?? "", config), dependencies);
    });

  program
    .command("doctor")
    .description("Run config, pricing, API key, and OpenRouter diagnostics.")
    .option("--config <path>", "Config file path")
    .option("--env-file <path>", "Env file path")
    .action(async (options: { config?: string; envFile?: string }) => {
      const result = await runDoctor({
        cwd,
        configPath: options.config,
        envFile: options.envFile,
        metadataClient: dependencies.metadataClient
      });
      for (const check of result.checks) {
        const marker = check.severity === "warning" ? "warning" : check.ok ? "ok" : check.severity;
        log(`[${marker}] ${check.name}: ${check.message}`);
      }
      if (!result.ok) {
        throw new UserError("Doctor found error-level issues.");
      }
    });

  addConfigFlags(program.command("assess <run-id>"))
    .description("Record lead-agent usefulness feedback for a review run.")
    .requiredOption("--model <alias>", "Model alias")
    .requiredOption("--usefulness <score>", "Usefulness score 1-5", parseNumber)
    .requiredOption("--note <text>", "Assessment note")
    .action(async (runId: string, options: CliConfigOverrides & { model: string; usefulness: number; note: string }) => {
      const config = await loadConfig(cwd, cliOverrides(options));
      const result = await recordAssessment(cwd, config, {
        runId,
        modelAlias: options.model,
        usefulness: options.usefulness,
        note: options.note
      });
      log(`Assessment: ${result.runDir}/assessment.json`);
      log(`Ledger: ${result.ledgerPath}`);
    });

  return program;
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
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
