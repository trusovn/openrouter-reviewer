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

  it("redacts diff secrets and skips secret-like changed files", async () => {
    const cwd = await tempDir();
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(path.join(cwd, ".gitignore"), "ignored.log\n", "utf8");
    await writeFile(path.join(cwd, "app.txt"), "safe\n", "utf8");
    await writeFile(path.join(cwd, ".env"), "API_KEY=old-secret\n", "utf8");
    await writeFile(path.join(cwd, "ignored.log"), "ignored base\n", "utf8");
    await writeFile(path.join(cwd, "large.txt"), "small\n", "utf8");
    execFileSync("git", ["add", "app.txt", ".env", ".gitignore", "large.txt"], { cwd });
    execFileSync("git", ["add", "-f", "ignored.log"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
    await writeFile(path.join(cwd, "app.txt"), "safe\nAPI_KEY=new-secret\n", "utf8");
    await writeFile(path.join(cwd, ".env"), "API_KEY=raw-env-secret\n", "utf8");
    await writeFile(path.join(cwd, "ignored.log"), "ignored raw\n", "utf8");
    await writeFile(path.join(cwd, "large.txt"), "x".repeat(40), "utf8");

    const bundle = await collectDiffContext(cwd, "HEAD", "review", configSchema.parse({ ...config, limits: { maxFileBytes: 30, maxContextChars: 120000 } }));

    expect(bundle.context).not.toContain("new-secret");
    expect(bundle.context).not.toContain("raw-env-secret");
    expect(bundle.context).not.toContain("ignored raw");
    expect(bundle.context).not.toContain("x".repeat(40));
    expect(bundle.context).toContain("API_KEY=[REDACTED]");
    expect(bundle.preview).toContain("git diff HEAD -- app.txt (redacted)");
    expect(bundle.preview).toContain("git diff HEAD -- .env: secret-like file name");
    expect(bundle.preview).toContain("git diff HEAD -- ignored.log: gitignored");
    expect(bundle.preview).toContain("git diff HEAD -- large.txt: larger than maxFileBytes (30)");
  });

  it("does not enumerate SDD feature paths outside the repo root", async () => {
    const cwd = await tempDir();
    const bundle = await collectSddContext(cwd, "../../..", "review", config);

    expect(bundle.context).toBe("");
    expect(bundle.preview).not.toContain("../../..");
  });

  it("collects only explicit files", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "a.txt"), "include", "utf8");
    await writeFile(path.join(cwd, "b.txt"), "exclude", "utf8");

    const bundle = await collectFilesContext(cwd, ["a.txt"], "review", config);

    expect(bundle.context).toContain("include");
    expect(bundle.context).not.toContain("exclude");
  });

  it("excludes explicit .env files from review context", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, ".env"), "OPENROUTER_API_KEY=secret\n", "utf8");
    await writeFile(path.join(cwd, ".env.local"), "OPENROUTER_API_KEY=local-secret\n", "utf8");
    await writeFile(path.join(cwd, "safe.txt"), "include", "utf8");

    const bundle = await collectFilesContext(cwd, [".env", ".env.local", "safe.txt"], "review", config);

    expect(bundle.context).toContain("include");
    expect(bundle.context).not.toContain("secret");
    expect(bundle.preview).toContain(".env: secret-like file name");
    expect(bundle.preview).toContain(".env.local: secret-like file name");
  });
});
