import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

describe("packaging and docs compliance", () => {
  it("is npm-oriented and exposes only publishable package paths", async () => {
    const packageJson = JSON.parse(await readText("package.json")) as {
      packageManager: string;
      bin: Record<string, string>;
      files: string[];
    };

    expect(packageJson.packageManager).toMatch(/^npm@/);
    expect(packageJson.bin["or-review"]).toBe("./dist/src/cli.js");
    expect(packageJson.files).toEqual(["dist/src", "skills/openrouter-review", "README.md"]);
    expect(packageJson.files).not.toContain(".or-review");
    expect(packageJson.files).not.toContain("test");
    expect(packageJson.files).not.toContain("node_modules");
  });

  it("documents install, config, privacy, budget, gitignore, commands, skill, and live smoke", async () => {
    const readme = await readText("README.md");

    for (const expected of [
      "npm install",
      "or-review init",
      "OPENROUTER_API_KEY",
      "\"dataCollection\": \"deny\"",
      "\"zdr\": false",
      "maxUsdPerRun",
      ".or-review/",
      "or-review sdd",
      "or-review diff",
      "or-review files",
      "or-review doctor",
      "or-review assess",
      "skills/openrouter-review/SKILL.md",
      "Live Smoke"
    ]) {
      expect(readme).toContain(expected);
    }
  });

  it("documents reliability hardening behavior for env loading, pricing, failures, and free models", async () => {
    const readme = await readText("README.md");

    for (const expected of [
      ".env",
      "--env-file",
      "\"pricingSource\": \"openrouter\"",
      "\"pricingSource\": \"pinned\"",
      ".or-review/cache/openrouter-models.json",
      "All models failed",
      "partial",
      "dataCollection: deny",
      "maxUsdPerRun\": 0",
      "cheap paid"
    ]) {
      expect(readme).toContain(expected);
    }
  });

  it("keeps the skill template aligned with reliability hardening operations", async () => {
    const skill = await readText("skills/openrouter-review/SKILL.md");

    for (const expected of [
      "--env-file",
      "OPENROUTER_API_KEY",
      "escalated",
      "report.json",
      "exit code 0",
      "dataCollection: deny",
      "free models",
      "cheap paid"
    ]) {
      expect(skill).toContain(expected);
    }
  });

  it("documents large-context operational guidance in README and skill template", async () => {
    const readme = await readText("README.md");
    const skill = await readText("skills/openrouter-review/SKILL.md");

    for (const text of [readme, skill]) {
      for (const expected of [
        "or-review diff --base HEAD",
        "or-review files --file",
        "narrower",
        "invalid structured output",
        "large context"
      ]) {
        expect(text).toContain(expected);
      }
    }
  });

  it("keeps the handoff plan inside this repository", async () => {
    const plan = await readText("docs/plans/openrouter-reviewer.md");

    expect(plan).toContain("# OpenRouter External Review CLI Handoff");
    expect(plan).toContain("This plan should first be saved in this repo as `docs/plans/openrouter-reviewer.md`");
  });
});
