import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { updateGrant } from "./terminal-grant.ts";
import { updateBridgeResponse, updateStateFromMessage } from "./update-proxy.ts";

const TOKEN = "bridge-secret";
let bridge: Server | null = null;

async function startBridge(status = 200): Promise<{ url: string; token: string; calls: string[] }> {
  const calls: string[] = [];
  bridge = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${updateGrant(TOKEN)}`) {
      res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: req.url === "/v1/update/download" ? "downloading" : "available", version: "1.0.53", appVersion: "1.0.52" }));
  });
  await new Promise<void>((resolve) => bridge!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`, token: TOKEN, calls };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (bridge ? bridge.close(() => resolve()) : resolve()));
  bridge = null;
});

describe("update bridge proxy", () => {
  it("reports unavailable without a desktop bridge", async () => {
    expect(await updateBridgeResponse(null, "state")).toEqual({ status: 200, body: { status: "unavailable" } });
    expect(await updateBridgeResponse(null, "install")).toEqual({ status: 200, body: { status: "unavailable" } });
  });

  it("reads state and forwards actions with the update grant", async () => {
    const access = await startBridge();
    expect(await updateBridgeResponse(access, "state")).toEqual({
      status: 200,
      body: { status: "available", version: "1.0.53", appVersion: "1.0.52" },
    });
    expect((await updateBridgeResponse(access, "download")).body.status).toBe("downloading");
    expect(access.calls).toEqual(["GET /v1/update/state", "POST /v1/update/download"]);
  });

  it("does not pass a bridge denial through as state", async () => {
    const access = await startBridge();
    expect(await updateBridgeResponse({ ...access, token: "stale-secret" }, "check")).toEqual({
      status: 502,
      body: { error: "update bridge: HTTP 401" },
    });
  });

  it("reports unavailable when the bridge has no updater", async () => {
    const access = await startBridge(404);
    expect(await updateBridgeResponse(access, "state")).toEqual({ status: 200, body: { status: "unavailable" } });
  });

  it("reports an unreachable bridge", async () => {
    const access = await startBridge();
    await new Promise<void>((resolve) => bridge!.close(() => resolve()));
    bridge = null;
    expect(await updateBridgeResponse(access, "state")).toEqual({ status: 502, body: { error: "update bridge unreachable" } });
  });

  it("accepts only update-state parent port messages", () => {
    const state = { status: "downloading", percent: 40, appVersion: "1.0.52" };
    expect(updateStateFromMessage({ type: "openmausbot:update-state", state })).toEqual(state);
    expect(updateStateFromMessage({ type: "openmausbot:managed-composio", state })).toBeNull();
    expect(updateStateFromMessage({ type: "openmausbot:update-state", state: [] })).toBeNull();
    expect(updateStateFromMessage("openmausbot:shutdown")).toBeNull();
  });
});
