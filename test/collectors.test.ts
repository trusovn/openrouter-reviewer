import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectDiffContext, collectFilesContext, collectSddContext } from "../src/collectors.js";
import { configSchema } from "../src/config.js";

async function tempDir(prefix = "or-review-collectors-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

const config = configSchema.parse({
  models: [{ alias: "a", id: "model-a", pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } }],
  limits: { maxFileBytes: 200000, maxContextChars: 120000 }
});

describe("collectors", () => {
  it("collects SDD foundation and existing feature artifacts while listing missing optional files", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "docs", "adr"), { recursive: true });
    await mkdir(path.join(cwd, "docs", "features", "demo", "contracts"), { recursive: true });
    await writeFile(path.join(cwd, "docs", "architecture-map.md"), "architecture", "utf8");
    await writeFile(path.join(cwd, "docs", "adr", "0001-test.md"), "adr", "utf8");
    await writeFile(path.join(cwd, "docs", "features", "demo", "spec.md"), "spec", "utf8");
    await writeFile(path.join(cwd, "docs", "features", "demo", "contracts", "openapi.yaml"), "openapi", "utf8");

    const bundle = await collectSddContext(cwd, "demo", "review", config);

    expect(bundle.context).toContain("architecture");
    expect(bundle.context).toContain("openapi");
    expect(bundle.preview).toContain("docs/features/demo/sad.md: not a file");
  });

  it("collects tracked staged and unstaged diff while ignoring untracked files", async () => {
    const cwd = await tempDir();
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(path.join(cwd, "tracked.txt"), "base\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
    await writeFile(path.join(cwd, "tracked.txt"), "base\nstaged\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    await writeFile(path.join(cwd, "tracked.txt"), "base\nstaged\nunstaged\n", "utf8");
    await writeFile(path.join(cwd, "untracked.txt"), "ignore me\n", "utf8");

    const bundle = await collectDiffContext(cwd, "HEAD", "review", config);

    expect(bundle.context).toContain("staged");
    expect(bundle.context).toContain("unstaged");
    expect(bundle.context).not.toContain("ignore me");
  });

  it("collects only explicit files", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "a.txt"), "include", "utf8");
    await writeFile(path.join(cwd, "b.txt"), "exclude", "utf8");

    const bundle = await collectFilesContext(cwd, ["a.txt"], "review", config);

    expect(bundle.context).toContain("include");
    expect(bundle.context).not.toContain("exclude");
  });
});

