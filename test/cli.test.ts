import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { ModelExecutionResult } from "../src/openrouter.js";

const originalApiKey = process.env.OPENROUTER_API_KEY;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "or-review-cli-"));
}

async function writeConfig(cwd: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    path.join(cwd, "or-review.config.json"),
    JSON.stringify(
      {
        models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }],
        provider: { dataCollection: "deny", zdr: false },
        budget: { maxUsdPerRun: 1, maxOutputTokensPerModel: 2000 },
        limits: { maxFileBytes: 200000, maxContextChars: 120000 },
        reports: { dir: ".or-review/runs" },
        assessmentLedger: { path: path.join(cwd, "ledger.jsonl") },
        ...overrides
      },
      null,
      2
    ),
    "utf8"
  );
}

function successfulResult(): ModelExecutionResult[] {
  return [
    {
      alias: "a",
      modelId: "model-a",
      ok: true,
      raw: { ok: true },
      findings: [
        {
          id: "a-1",
          modelAlias: "a",
          severity: "low",
          category: "test",
          location: "fixture",
          finding: "finding",
          evidence: "evidence",
          recommendation: "recommendation",
          confidence: 0.5
        }
      ]
    }
  ];
}

function failedResults(): ModelExecutionResult[] {
  return [
    {
      alias: "a",
      modelId: "model-a",
      ok: false,
      raw: { error: "a failed" },
      findings: [],
      error: "a failed"
    },
    {
      alias: "b",
      modelId: "model-b",
      ok: false,
      raw: { error: "b failed" },
      findings: [],
      error: "b failed"
    }
  ];
}

function mixedResults(): ModelExecutionResult[] {
  return [
    ...successfulResult(),
    {
      alias: "b",
      modelId: "model-b",
      ok: false,
      raw: { error: "b failed" },
      findings: [],
      error: "b failed"
    }
  ];
}

async function parse(cwd: string, args: string[], logs: string[], executeModels = vi.fn(async () => successfulResult())) {
  const program = createProgram({ cwd, executeModels, log: (message) => logs.push(message) });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return executeModels;
}

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalApiKey;
});

describe("or-review CLI", () => {
  it("lists the command surface in help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: or-review [options] [command]");
    expect(help).toContain("init");
    expect(help).toContain("sdd");
    expect(help).toContain("diff");
    expect(help).toContain("files");
    expect(help).toContain("doctor");
    expect(help).toContain("assess");
  });

  it("declares required command flags", () => {
    const help = createProgram().commands.find((command) => command.name() === "files")?.helpInformation();

    expect(help).toContain("--file <path...>");
    expect(help).toContain("--instruction <goal>");
    expect(help).toContain("--env-file <path>");
  });

  it("runs files review, prints report paths, and records an assessment", async () => {
    const cwd = await tempDir();
    process.env.OPENROUTER_API_KEY = "test-key";
    await writeConfig(cwd);
    await writeFile(path.join(cwd, "target.txt"), "review me", "utf8");
    const logs: string[] = [];

    const executeModels = await parse(cwd, ["files", "--file", "target.txt", "--instruction", "review"], logs);

    expect(executeModels).toHaveBeenCalledOnce();
    expect(logs.some((line) => line.startsWith("Run: "))).toBe(true);
    expect(logs.some((line) => line.endsWith("report.md"))).toBe(true);
    expect(logs.some((line) => line.endsWith("report.json"))).toBe(true);

    const runId = path.basename(logs.find((line) => line.startsWith("Run: "))?.replace("Run: ", "") ?? "");
    const report = JSON.parse(await readFile(path.join(cwd, ".or-review", "runs", runId, "report.json"), "utf8")) as { findings: unknown[] };
    expect(report.findings).toHaveLength(1);

    const assessLogs: string[] = [];
    await parse(cwd, ["assess", runId, "--model", "a", "--usefulness", "4", "--note", "useful"], assessLogs);

    expect(assessLogs.some((line) => line.includes("assessment.json"))).toBe(true);
    expect(await readFile(path.join(cwd, ".or-review", "runs", runId, "assessment.json"), "utf8")).toContain("useful");
    expect(await readFile(path.join(cwd, "ledger.jsonl"), "utf8")).toContain("useful");
  });

  it("loads OPENROUTER_API_KEY from default .env before review commands require it", async () => {
    const cwd = await tempDir();
    delete process.env.OPENROUTER_API_KEY;
    await writeConfig(cwd);
    await writeFile(path.join(cwd, ".env"), "OPENROUTER_API_KEY=dotenv-key\n", "utf8");
    await writeFile(path.join(cwd, "target.txt"), "review me", "utf8");
    const executeModels = vi.fn(async () => successfulResult());

    await parse(cwd, ["files", "--file", "target.txt", "--instruction", "review"], [], executeModels);

    expect(executeModels).toHaveBeenCalledOnce();
    expect((executeModels.mock.calls as unknown[][])[0]?.[2]).toBe("dotenv-key");
  });

  it("uses an explicit env file instead of default discovery for missing shell values", async () => {
    const cwd = await tempDir();
    delete process.env.OPENROUTER_API_KEY;
    await writeConfig(cwd);
    await writeFile(path.join(cwd, ".env"), "OPENROUTER_API_KEY=default-env-key\n", "utf8");
    await writeFile(path.join(cwd, ".env.local"), "OPENROUTER_API_KEY=explicit-env-key\n", "utf8");
    await writeFile(path.join(cwd, "target.txt"), "review me", "utf8");
    const executeModels = vi.fn(async () => successfulResult());

    await parse(cwd, ["files", "--env-file", ".env.local", "--file", "target.txt", "--instruction", "review"], [], executeModels);

    expect(executeModels).toHaveBeenCalledOnce();
    expect((executeModels.mock.calls as unknown[][])[0]?.[2]).toBe("explicit-env-key");
  });

  it("fails clearly when an explicit env file is missing", async () => {
    const cwd = await tempDir();
    delete process.env.OPENROUTER_API_KEY;
    await writeConfig(cwd);
    await writeFile(path.join(cwd, "target.txt"), "review me", "utf8");
    const executeModels = vi.fn(async () => successfulResult());

    await expect(parse(cwd, ["files", "--env-file", ".env.missing", "--file", "target.txt", "--instruction", "review"], [], executeModels)).rejects.toThrow(
      "Env file not found"
    );
    expect(executeModels).not.toHaveBeenCalled();
  });

  it("runs sdd and diff review commands against fixture repos", async () => {
    const cwd = await tempDir();
    process.env.OPENROUTER_API_KEY = "test-key";
    await writeConfig(cwd);
    await mkdir(path.join(cwd, "docs", "features", "demo"), { recursive: true });
    await writeFile(path.join(cwd, "docs", "architecture-map.md"), "architecture", "utf8");
    await writeFile(path.join(cwd, "docs", "features", "demo", "spec.md"), "spec", "utf8");
    const logs: string[] = [];

    await parse(cwd, ["sdd", "--feature", "demo", "--instruction", "review"], logs);

    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(path.join(cwd, "tracked.txt"), "base\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
    await writeFile(path.join(cwd, "tracked.txt"), "base\nchange\n", "utf8");

    await parse(cwd, ["diff", "--base", "HEAD", "--instruction", "review"], logs);

    const runIds = await readdir(path.join(cwd, ".or-review", "runs"));
    expect(runIds).toHaveLength(2);
  });

  it("rejects missing required flags with a non-zero commander error", async () => {
    const program = createProgram({ cwd: await tempDir(), log: () => undefined });
    program.exitOverride();

    await expect(program.parseAsync(["files", "--instruction", "review"], { from: "user" })).rejects.toThrow(
      'process.exit unexpectedly called with "1"'
    );
  });

  it("writes reports but rejects when every configured model fails", async () => {
    const cwd = await tempDir();
    process.env.OPENROUTER_API_KEY = "test-key";
    await writeConfig(cwd, {
      models: [
        { alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
        { alias: "b", id: "model-b", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }
      ]
    });
    await writeFile(path.join(cwd, "target.txt"), "review me", "utf8");
    const logs: string[] = [];
    const executeModels = vi.fn(async () => failedResults());

    await expect(parse(cwd, ["files", "--file", "target.txt", "--instruction", "review"], logs, executeModels)).rejects.toThrow("All 2 models failed");

    const runIds = await readdir(path.join(cwd, ".or-review", "runs"));
    expect(runIds).toHaveLength(1);
    const report = JSON.parse(await readFile(path.join(cwd, ".or-review", "runs", runIds[0] ?? "", "report.json"), "utf8")) as {
      models: Array<{ ok: boolean; error?: string }>;
    };
    expect(report.models).toEqual([
      { alias: "a", modelId: "model-a", ok: false, error: "a failed" },
      { alias: "b", modelId: "model-b", ok: false, error: "b failed" }
    ]);
    expect(logs.some((line) => line.endsWith("report.md"))).toBe(true);
  });

  it("keeps partial reports successful when at least one configured model succeeds", async () => {
    const cwd = await tempDir();
    process.env.OPENROUTER_API_KEY = "test-key";
    await writeConfig(cwd, {
      models: [
        { alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
        { alias: "b", id: "model-b", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }
      ]
    });
    await writeFile(path.join(cwd, "target.txt"), "review me", "utf8");
    const executeModels = vi.fn(async () => mixedResults());

    await parse(cwd, ["files", "--file", "target.txt", "--instruction", "review"], [], executeModels);

    const runIds = await readdir(path.join(cwd, ".or-review", "runs"));
    const report = JSON.parse(await readFile(path.join(cwd, ".or-review", "runs", runIds[0] ?? "", "report.json"), "utf8")) as {
      findings: unknown[];
      models: Array<{ ok: boolean }>;
    };
    expect(report.findings).toHaveLength(1);
    expect(report.models.map((model) => model.ok)).toEqual([true, false]);
  });

  it("refuses unfilled init config and over-budget runs before model execution", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, { models: [{ alias: "a", id: "", pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } }] });
    await writeFile(path.join(cwd, "target.txt"), "review me", "utf8");
    process.env.OPENROUTER_API_KEY = "test-key";
    const executeModels = vi.fn(async () => successfulResult());

    await expect(parse(cwd, ["files", "--file", "target.txt", "--instruction", "review"], [], executeModels)).rejects.toThrow("missing an OpenRouter model id");
    expect(executeModels).not.toHaveBeenCalled();

    await writeConfig(cwd, {
      models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1000000, outputUsdPerMillionTokens: 1000000 } }],
      budget: { maxUsdPerRun: 0.000001, maxOutputTokensPerModel: 2000 }
    });

    await expect(parse(cwd, ["files", "--file", "target.txt", "--instruction", "review"], [], executeModels)).rejects.toThrow("run cap");
    expect(executeModels).not.toHaveBeenCalled();
  });
});
