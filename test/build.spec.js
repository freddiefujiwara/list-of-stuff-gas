import { describe, it, expect, vi } from "vitest";
import { build, runIfMain } from "../build.js";

describe("build", () => {
  it("should return true on successful build", async () => {
    const mockEsbuild = {
      build: vi.fn().mockResolvedValue({}),
    };
    const mockGasPlugin = vi.fn();
    const result = await build(mockEsbuild, mockGasPlugin);
    expect(result).toBe(true);
    expect(mockEsbuild.build).toHaveBeenCalled();
  });

  it("should return false on failed build", async () => {
    const mockEsbuild = {
      build: vi.fn().mockRejectedValue(new Error("Build error")),
    };
    const mockGasPlugin = vi.fn();
    const result = await build(mockEsbuild, mockGasPlugin);
    expect(result).toBe(false);
    expect(mockEsbuild.build).toHaveBeenCalled();
  });
});

describe("runIfMain", () => {
  it("should call buildFn when it's the main module", () => {
    const buildFn = vi.fn();
    const current = { id: "build.js" };
    runIfMain({ main: current, current, buildFn });
    expect(buildFn).toHaveBeenCalled();
  });

  it("should not call buildFn when it's not the main module", () => {
    const buildFn = vi.fn();
    const main = { id: "other.js" };
    const current = { id: "build.js" };
    runIfMain({ main, current, buildFn });
    expect(buildFn).not.toHaveBeenCalled();
  });
});
