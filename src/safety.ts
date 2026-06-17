import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type PreparedInput = {
  path: string;
  content?: string;
  included: boolean;
  skippedReason?: string;
  truncated?: boolean;
  redacted?: boolean;
  originalBytes?: number;
};

export type ContextLimits = {
  maxFileBytes: number;
  maxContextChars: number;
};

const secretNamePattern = /(^|[/\\])(\.env.*|.*(secret|credential|private[_-]?key|token|password).*)$/i;
const sensitiveFieldPattern = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

export function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.15;
}

export function shouldSkipByName(filePath: string): string | undefined {
  const normalized = filePath.replaceAll(path.sep, "/");
  if (secretNamePattern.test(normalized)) return "secret-like file name";
  return undefined;
}

function isInsideRoot(relativePath: string): boolean {
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function isGitIgnored(repoRoot: string, filePath: string): boolean {
  if (!existsSync(path.join(repoRoot, ".git"))) return false;
  const relative = path.relative(repoRoot, path.resolve(repoRoot, filePath));
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", relative], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function redactSecrets(input: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = input.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    () => {
      redacted = true;
      return "[REDACTED_PRIVATE_KEY]";
    }
  );

  text = text.replace(/^(\s*[+-]?\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*).+$/gim, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}[REDACTED]`;
  });

  text = text.replace(/(["']?[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[\w.-]*["']?\s*:\s*)(["']).*?\2/gim, (_match, prefix: string, quote: string) => {
    redacted = true;
    return `${prefix}${quote}[REDACTED]${quote}`;
  });

  text = text.replace(/^(\s*[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[\w.-]*\s*:\s*).+$/gim, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}[REDACTED]`;
  });

  return { text, redacted };
}

export async function safeReadFile(repoRoot: string, filePath: string, limits: ContextLimits): Promise<PreparedInput> {
  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);
  if (!isInsideRoot(relative)) {
    return { path: filePath, included: false, skippedReason: "outside repo root" };
  }
  const nameReason = shouldSkipByName(relative);
  if (nameReason) return { path: relative, included: false, skippedReason: nameReason };
  if (isGitIgnored(repoRoot, relative)) return { path: relative, included: false, skippedReason: "gitignored" };

  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isFile()) return { path: relative, included: false, skippedReason: "not a file" };
  if (info.size > limits.maxFileBytes) {
    return { path: relative, included: false, skippedReason: `larger than maxFileBytes (${limits.maxFileBytes})`, originalBytes: info.size };
  }

  const buffer = await readFile(resolved);
  if (isProbablyBinary(buffer)) return { path: relative, included: false, skippedReason: "binary file", originalBytes: buffer.length };

  const redacted = redactSecrets(buffer.toString("utf8"));
  return {
    path: relative,
    content: redacted.text,
    included: true,
    redacted: redacted.redacted,
    originalBytes: buffer.length
  };
}

export function assembleContext(inputs: PreparedInput[], maxContextChars: number): { context: string; inputs: PreparedInput[] } {
  let remaining = maxContextChars;
  const prepared: PreparedInput[] = [];
  const chunks: string[] = [];

  for (const input of inputs) {
    if (!input.included || input.content === undefined) {
      prepared.push(input);
      continue;
    }

    const header = `\n\n## ${input.path}\n\n`;
    const available = remaining - header.length;
    if (available <= 0) {
      prepared.push({ ...input, included: false, skippedReason: "maxContextChars reached" });
      continue;
    }

    const content = input.content.length > available ? input.content.slice(0, available) : input.content;
    const truncated = content.length < input.content.length;
    chunks.push(`${header}${content}`);
    remaining -= header.length + content.length;
    prepared.push({ ...input, content, truncated });
  }

  return { context: chunks.join("").trimStart(), inputs: prepared };
}

export function buildContextPreview(inputs: PreparedInput[]): string {
  const section = (title: string, rows: string[]) => [`## ${title}`, rows.length ? rows.join("\n") : "- None"].join("\n");
  const included = inputs.filter((input) => input.included).map((input) => `- ${input.path}${input.redacted ? " (redacted)" : ""}${input.truncated ? " (truncated)" : ""}`);
  const skipped = inputs.filter((input) => !input.included).map((input) => `- ${input.path}: ${input.skippedReason ?? "skipped"}`);
  const truncated = inputs.filter((input) => input.truncated).map((input) => `- ${input.path}`);
  const redacted = inputs.filter((input) => input.redacted).map((input) => `- ${input.path}`);
  return ["# Context Preview", section("Included", included), section("Skipped", skipped), section("Truncated", truncated), section("Redacted", redacted)].join("\n\n");
}

export function hasSensitiveFieldName(name: string): boolean {
  return sensitiveFieldPattern.test(name);
}
