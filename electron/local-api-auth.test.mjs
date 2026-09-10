import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { createAppAuthorization, waitForAppToken } from "./local-api-auth.mjs";

const origin = "http://127.0.0.1:18799";
const token = "a".repeat(48);
const app = { id: 12, isDestroyed: () => false, getURL: () => origin };
const request = { url: `${origin}/api/bots`, webContentsId: app.id, frame: { url: origin }, requestHeaders: {} };

describe("app authorization", () => {
  it.each(["bots", "events", "attachments/image.png"])("authenticates app requests to %s", (path) => {
    const auth = createAppAuthorization();
    auth.bind(origin, token);
    expect(auth.headers({ ...request, url: `${origin}/api/${path}` }, app).Authorization).toBe(`Bearer ${token}`);
  });

  it("rejects other views, origins, frames, ports, and static assets", () => {
    const auth = createAppAuthorization();
    auth.bind(origin, token);
    for (const patch of [
      { webContentsId: 13 }, { url: "http://127.0.0.1:8799/api/bots" },
      { url: "https://example.com/api/bots" }, { frame: { url: "https://example.com" } },
      { frame: null }, { url: `${origin}/assets/app.js` },
    ]) expect(auth.headers({ ...request, ...patch }, app).Authorization).toBeUndefined();
    expect(auth.headers(request, { ...app, getURL: () => "https://example.com" }).Authorization).toBeUndefined();
  });

  it("strips the token on redirects and replaces stale bindings", () => {
    const auth = createAppAuthorization();
    auth.bind(origin, token);
    const redirected = { ...request, requestHeaders: { Authorization: `Bearer ${token}` }, url: "https://example.com/api/bots" };
    expect(auth.headers(redirected, app).Authorization).toBeUndefined();
    const fresh = "b".repeat(48);
    auth.bind(origin, fresh);
    expect(auth.headers({ ...request, requestHeaders: redirected.requestHeaders }, app).Authorization).toBe(`Bearer ${fresh}`);
    auth.bind(origin, null);
    expect(auth.headers(request, app).Authorization).toBeUndefined();
    expect(auth.headers(redirected, app).Authorization).toBeUndefined();
  });

  it("accepts only a private token message and fails closed on child exit", async () => {
    const child = new EventEmitter();
    const pending = waitForAppToken(child, 1000);
    child.emit("message", { type: "unrelated", token });
    child.emit("message", { type: "orbit:api-token", token });
    expect(await pending).toBe(token);
    const exited = waitForAppToken(child, 1000);
    child.emit("exit", 1);
    expect(await exited).toBeNull();
  });
});
