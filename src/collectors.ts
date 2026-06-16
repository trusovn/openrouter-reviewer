import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { OrReviewConfig } from "./config.js";
import { UserError } from "./errors.js";
import { assembleContext, buildContextPreview, safeReadFile, type PreparedInput } from "./safety.js";

export type ReviewMode = "sdd" | "diff" | "files";

export type ContextBundle = {
  mode: ReviewMode;
  instruction: string;
  context: string;
  preview: string;
  inputs: PreparedInput[];
};

async function collectExistingFiles(repoRoot: string, candidates: string[], config: OrReviewConfig): Promise<PreparedInput[]> {
  const results: PreparedInput[] = [];
  for (const candidate of candidates) {
    results.push(await safeReadFile(repoRoot, candidate, config.limits));
  }
  return results;
}

async function listFilesRecursive(root: string, relativeDir: string): Promise<string[]> {
  const absoluteDir = path.join(root, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(root, rel)));
    if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

function finalize(mode: ReviewMode, instruction: string, rawInputs: PreparedInput[], config: OrReviewConfig): ContextBundle {
  const assembled = assembleContext(rawInputs, config.limits.maxContextChars);
  return {
    mode,
    instruction,
    context: assembled.context,
    preview: buildContextPreview(assembled.inputs),
    inputs: assembled.inputs
  };
}

export async function collectSddContext(repoRoot: string, feature: string, instruction: string, config: OrReviewConfig): Promise<ContextBundle> {
  const featureRoot = path.join("docs", "features", feature);
  const candidates = [
    "docs/architecture-map.md",
    ...(await listFilesRecursive(repoRoot, "docs/adr")),
    path.join(featureRoot, "CONTEXT.md"),
    path.join(featureRoot, ".size"),
    path.join(featureRoot, "spec.md"),
    path.join(featureRoot, "sad.md"),
    path.join(featureRoot, "data-model.md"),
    ...(await listFilesRecursive(repoRoot, path.join(featureRoot, "contracts"))),
    path.join(featureRoot, "tasks.json"),
    ...(await listFilesRecursive(repoRoot, path.join(featureRoot, "tasks")))
  ];
  return finalize("sdd", instruction, await collectExistingFiles(repoRoot, candidates, config), config);
}

function gitOutput(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

export async function collectDiffContext(repoRoot: string, base: string, instruction: string, config: OrReviewConfig): Promise<ContextBundle> {
  const stat = gitOutput(repoRoot, ["diff", "--stat", base]);
  const diff = gitOutput(repoRoot, ["diff", base]);
  const inputs: PreparedInput[] = [
    { path: `git diff --stat ${base}`, included: true, content: stat },
    { path: `git diff ${base}`, included: true, content: diff }
  ];
  return finalize("diff", instruction, inputs, config);
}

export async function collectFilesContext(repoRoot: string, files: string[], instruction: string, config: OrReviewConfig): Promise<ContextBundle> {
  if (files.length === 0) throw new UserError("Pass at least one --file for files review.");
  return finalize("files", instruction, await collectExistingFiles(repoRoot, files, config), config);
}

