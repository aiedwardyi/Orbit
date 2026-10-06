import { describe, expect, it, vi } from "vitest";

import { openEngineSignIn } from "./engine-signin.mjs";

function deps(command = "codex login") {
  return {
    resolve: vi.fn(async () => ({ driverKind: "codex", command })),
    copy: vi.fn(),
    open: vi.fn(async () => true),
    blank: vi.fn(async () => true),
  };
}

describe("engine sign-in", () => {
  it("resolves an id before running the registry command", async () => {
    const d = deps();
    expect(await openEngineSignIn("codex", d)).toBe("running");
    expect(d.resolve).toHaveBeenCalledExactlyOnceWith("codex");
    expect(d.open).toHaveBeenCalledExactlyOnceWith({ driverKind: "codex", command: "codex login" });
    expect(d.copy).not.toHaveBeenCalled();
  });

  it.each(["codex login", "codex;whoami", { instanceId: "codex", command: "whoami" }, null])("rejects command-bearing input %j", async (input) => {
    const d = deps();
    await expect(openEngineSignIn(input, d)).rejects.toThrow();
    expect(d.open).not.toHaveBeenCalled();
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it("rejects an unknown id", async () => {
    const d = deps();
    d.resolve.mockResolvedValue(null);
    await expect(openEngineSignIn("missing", d)).rejects.toThrow();
    expect(d.open).not.toHaveBeenCalled();
  });

  it("copies placeholder commands without executing them", async () => {
    const d = deps("mmx auth login --api-key YOUR_MINIMAX_API_KEY");
    expect(await openEngineSignIn("minimax", d)).toBe("opened");
    expect(d.open).not.toHaveBeenCalled();
    expect(d.copy).toHaveBeenCalledExactlyOnceWith("mmx auth login --api-key YOUR_MINIMAX_API_KEY");
    expect(d.blank).toHaveBeenCalledOnce();
  });

  it("copies when launch is unsupported and reports when no terminal opens", async () => {
    const d = deps();
    d.open.mockResolvedValue(false);
    d.blank.mockResolvedValue(false);
    expect(await openEngineSignIn("codex", d)).toBe("copied");
    expect(d.copy).toHaveBeenCalledExactlyOnceWith("codex login");
  });
});
