import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { harnessFetch, spawnHarness } from "./harness-auth.ts";

const servers: Server[] = [];
const children: ChildProcess[] = [];

// Resets the first `resets` connections with a TCP RST, then answers 200.
async function resettingServer(resets: number) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.method ?? "");
    if (seen.length <= resets) return void req.socket.resetAndDestroy();
    res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a TCP listen reports an AddressInfo, never a pipe name.
  return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("harnessFetch", () => {
  it("retries a reset GET once and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { seen, origin } = await resettingServer(1);
    const response = await harnessFetch(`${origin}/api/ping`);
    expect(await response.text()).toBe("ok");
    expect(seen).toEqual(["GET", "GET"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z harnessFetch ECONNRESET GET \/api\/ping/);
  });

  it("retries a reset HEAD", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { seen, origin } = await resettingServer(1);
    expect((await harnessFetch(`${origin}/x`, { method: "HEAD" })).status).toBe(200);
    expect(seen).toEqual(["HEAD", "HEAD"]);
  });

  it("rejects a GET reset twice, with a single retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { seen, origin } = await resettingServer(2);
    await expect(harnessFetch(`${origin}/x`)).rejects.toThrow("fetch failed");
    expect(seen).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never retries a reset POST", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { seen, origin } = await resettingServer(1);
    await expect(harnessFetch(`${origin}/x`, { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
    expect(seen).toEqual(["POST"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not retry a refused connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { origin } = await resettingServer(0);
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    const real = vi.spyOn(globalThis, "fetch");
    await expect(harnessFetch(`${origin}/x`)).rejects.toThrow("fetch failed");
    expect(real).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("puts the server's stderr tail in the warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { origin } = await resettingServer(1);
    const child = spawnHarness(process.execPath, ["-e", "console.error('boom one'); console.error('boom two'); setInterval(() => {}, 1000)"], {
      env: { ...process.env, OMB_PORT: new URL(origin).port },
    });
    children.push(child);
    let output = "";
    await new Promise<void>((resolve) => child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("boom two")) resolve();
    }));
    await harnessFetch(`${origin}/x`);
    expect(warn.mock.calls[0][0]).toContain("boom one | boom two");
  });
});
