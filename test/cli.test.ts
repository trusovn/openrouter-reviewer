import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli.js";

describe("or-review CLI", () => {
  it("lists the command surface in help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: or-review [options] [command]");
    expect(help).toContain("init");
    expect(help).toContain("sdd");
    expect(help).toContain("diff");
    expect(help).toContain("files");
    expect(help).toContain("assess");
  });

  it("declares required command flags", () => {
    const help = createProgram().commands.find((command) => command.name() === "files")?.helpInformation();

    expect(help).toContain("--file <path...>");
    expect(help).toContain("--instruction <goal>");
  });
});
