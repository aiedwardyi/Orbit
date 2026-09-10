import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createProxyHandler } from "../src/proxy.ts";

let harness: Server;
let companion: Server;
let base: string;
let credential = "a".repeat(48);
const received: string[] = [];

beforeAll(async () => {
  harness = createServer((req, res) => {
    received.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"bots":[]}');
  });
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  companion = createServer(createProxyHandler({
    harnessPort: z.object({ port: z.number() }).parse(harness.address()).port,
    harnessToken: () => credential,
    authenticate: (token) => token === "paired-device" ? { id: "fixture", cloudDesktopAccess: false } : null,
    redeem: () => ({ error: "not paired" }),
    serverName: () => "Fixture",
  }));
  await new Promise<void>((resolve) => companion.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${z.object({ port: z.number() }).parse(companion.address()).port}`;
});

afterAll(async () => {
  for (const server of [companion, harness]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("companion app authentication", () => {
  it("authenticates the device before using the private upstream credential", async () => {
    expect((await fetch(`${base}/api/bots`)).status).toBe(401);
    expect((await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
    expect(received).toEqual([]);
    const response = await fetch(`${base}/api/bots`, { headers: { authorization: "Bearer paired-device" } });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(credential);
    expect(received).toEqual([`Bearer ${credential}`]);
  });

  it("uses a replacement credential on the next forwarded request", async () => {
    credential = "b".repeat(48);
    expect((await fetch(`${base}/api/bots`, { headers: { authorization: "Bearer paired-device" } })).status).toBe(200);
    expect(received.at(-1)).toBe(`Bearer ${credential}`);
  });
});
