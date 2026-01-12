import path from "path";
import { describe, expect, it, vi } from "vitest";

import { build, runIfMain } from "../build";

describe("build", () => {
  it("writes Code.gs without export statements and copies manifest", () => {
    const fsModule = {
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(
        () =>
          [
            "export function doGet() {}",
            "export const value = 1;",
            'export { doGet as handler };',
          ].join("\n")
      ),
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
    };
    const rootDir = "/repo";

    build({ rootDir, fsModule, pathModule: path });

    expect(fsModule.mkdirSync).toHaveBeenCalledWith(
      path.join(rootDir, "dist"),
      { recursive: true }
    );
    expect(fsModule.readFileSync).toHaveBeenCalledWith(
      path.join(rootDir, "src", "Code.js"),
      "utf8"
    );
    expect(fsModule.writeFileSync).toHaveBeenCalledWith(
      path.join(rootDir, "dist", "Code.gs"),
      [
        "function doGet() {}",
        "const value = 1;",
        "{ doGet as handler };",
      ].join("\n")
    );
    expect(fsModule.copyFileSync).toHaveBeenCalledWith(
      path.join(rootDir, "appsscript.json"),
      path.join(rootDir, "dist", "appsscript.json")
    );
  });

  it("runs build when main matches current module", () => {
    const buildFn = vi.fn();
    const main = {};
    const current = main;

    const result = runIfMain({ main, current, buildFn });

    expect(buildFn).toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
