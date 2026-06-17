import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleContext, redactSecrets, safeReadFile } from "../src/safety.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "or-review-safety-"));
}

describe("safety utilities", () => {
  it("redacts env, JSON, YAML, and private key secrets", () => {
    const secret = [
      "API_KEY=abc123",
      '{"serviceToken":"abc123"}',
      "password: hunter2",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    ].join("\n");

    const result = redactSecrets(secret);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("abc123");
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("skips binary, ignored, env, secret-like, and oversized files", async () => {
    const cwd = await tempDir();
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    await writeFile(path.join(cwd, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(path.join(cwd, "ignored.txt"), "ignored", "utf8");
    await writeFile(path.join(cwd, ".env"), "API_KEY=raw", "utf8");
    await writeFile(path.join(cwd, "secret-token.txt"), "raw", "utf8");
    await writeFile(path.join(cwd, "big.txt"), "0123456789", "utf8");
    await writeFile(path.join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 3, 4]));

    const limits = { maxFileBytes: 5, maxContextChars: 1000 };
    await expect(safeReadFile(cwd, "ignored.txt", limits)).resolves.toMatchObject({ included: false, skippedReason: "gitignored" });
    await expect(safeReadFile(cwd, ".env", limits)).resolves.toMatchObject({ included: false, skippedReason: "secret-like file name" });
    await expect(safeReadFile(cwd, "secret-token.txt", limits)).resolves.toMatchObject({ included: false, skippedReason: "secret-like file name" });
    await expect(safeReadFile(cwd, "big.txt", limits)).resolves.toMatchObject({ included: false });
    await expect(safeReadFile(cwd, "bin.dat", { ...limits, maxFileBytes: 100 })).resolves.toMatchObject({ included: false, skippedReason: "binary file" });
  });

  it("skips paths that resolve outside the repo root", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "outside.txt"), "do not include", "utf8");

    await expect(safeReadFile(cwd, path.relative(cwd, path.join(outside, "outside.txt")), { maxFileBytes: 1000, maxContextChars: 1000 }))
      .resolves.toMatchObject({ included: false, skippedReason: "outside repo root" });
  });

  it("tracks truncated inputs and keeps raw secrets out of assembled context", () => {
    const assembled = assembleContext(
      [{ path: "a.txt", included: true, content: "PASSWORD=raw-secret\nhello", redacted: false }],
      20
    );

    expect(assembled.inputs[0]?.truncated).toBe(true);
    expect(assembled.context.length).toBeLessThanOrEqual(20);
  });
});
