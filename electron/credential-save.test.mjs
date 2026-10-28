import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CREDENTIAL_TARGETS, credentialIsConfigured } from "../shared/credential-request.ts";
import { createBotChatRoutes } from "../server/bot-chat-routes.ts";
import { parseConfigPatch } from "../server/config.ts";
import { credentialSaveResponse } from "../server/credential-save.ts";
import { json, readBody } from "../server/http-helpers.ts";
import { phoneCookieToken, relayVerdict, requestCredentials } from "../server/phone-auth.ts";
import { apiRequestAuthorized } from "../server/remote-access.ts";
import { createCredentialWriter } from "./credential-writer.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { createTerminalBridge } from "./terminal-bridge.mjs";

const KEY = "test-only-remote-key";
const HOST = "owner.wink.example";
const BOOT_TOKEN = "test-owner-boot-token";
const REMOTE_KEY = "a".repeat(64);
const custom = { target: "custom:api.acme.dev", value: JSON.stringify({ name: "Acme", header: "authorization", prefix: "Bearer ", key: KEY }) };
const cleanup = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(mode, input, { encryptionAvailable = true, packaged = true, rejectApply = false } = {}) {
  const persisted = [];
  const ownerStore = createSecureCredentialState({ existing: "kept" }, async (document) => { persisted.push(structuredClone(document)); });
  const viewerStore = createSecureCredentialState({ existing: "viewer-kept" }, vi.fn());
  const cfg = {};
  const message = { id: "card", kind: "secret", secret: { target: input.target, label: "Test key" } };
  const resume = vi.fn(() => { message.secret.provided = true; });
  const routes = createBotChatRoutes({ cfg, secretMessage: () => message, resumeSecretCard: resume });
  let access;
  let port;
  const applications = [];
  const harness = createServer(async (req, res) => {
    if (req.url === "/api/config?secretStorage=external" && req.headers.authorization === `Bearer ${BOOT_TOKEN}`) {
      const patch = parseConfigPatch(await readBody(req));
      expect(persisted.at(-1)?.[input.target]).toBe(input.value);
      applications.push(patch);
      if (rejectApply) return json(res, 400, { error: KEY });
      Object.assign(cfg, patch);
      return json(res, 200, { configured: true });
    }
    const relay = mode === "relay PC" || mode === "phone";
    if (relay && relayVerdict(req, HOST).kind !== "app") return json(res, 403, { error: "forbidden" });
    const credentials = requestCredentials(relay, phoneCookieToken(req.headers.cookie) === "test-phone-session", req.headers.authorization === `Bearer ${BOOT_TOKEN}`, REMOTE_KEY);
    if (!credentials.phoneSession && !apiRequestAuthorized(credentials.bearerOk, req.headers.cookie, credentials.remoteKey, req.url)) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (req.url === "/api/credentials") {
      const reply = await credentialSaveResponse(access, await readBody(req));
      return json(res, reply.status, reply.body);
    }
    return routes.secretCard(req, res, ["", "owner-bot", "card", "provided"]);
  });
  await new Promise((resolve) => harness.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => harness.close(resolve)));
  port = harness.address().port;
  const writeCredential = createCredentialWriter({
    packaged,
    isEncryptionAvailable: async () => encryptionAvailable,
    updateCredentials: ownerStore.update,
    serverAccess: () => ({ port, token: BOOT_TOKEN }),
  });
  const bridge = createTerminalBridge({
    host: { readBot() {}, sendBot() {} },
    saveCredential: (target, value) => writeCredential(target, value, { encrypted: true }),
  });
  access = await bridge.start();
  cleanup.push(() => bridge.close());
  const headers = mode === "local PC" ? { authorization: `Bearer ${BOOT_TOKEN}` }
    : mode === "Tailscale PC" ? { cookie: `orbit_remote=${REMOTE_KEY}` }
    : { host: HOST, origin: `https://${HOST}`, cookie: "__Host-wink_phone=test-phone-session" };
  const post = (path, body, auth = headers) => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...auth },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
  return { post, ownerStore, viewerStore, persisted, cfg, resume, applications, bridge };
}

describe("owning desktop key saves", () => {
  it.each(["local PC", "relay PC", "phone", "Tailscale PC"].flatMap((mode) => [
    [mode, custom], ...Object.keys(CREDENTIAL_TARGETS).map((target) => [mode, { target, value: KEY }]),
  ]))("saves %s credentials to its owning desktop and resumes only afterward: %j", async (mode, input) => {
    const f = await fixture(mode, input);
    const before = await f.post("/api/bots/owner-bot/secret-cards/card/provided", { threadId: "thread" });
    expect(before.status).toBe(409);
    expect(f.resume).not.toHaveBeenCalled();
    const response = await f.post("/api/credentials", input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
    expect(f.ownerStore.read()).toEqual({ existing: "kept", [input.target]: input.value });
    expect(f.viewerStore.read()).toEqual({ existing: "viewer-kept" });
    expect(credentialIsConfigured(f.cfg, input.target)).toBe(true);
    const provided = await f.post("/api/bots/owner-bot/secret-cards/card/provided", { threadId: "thread" });
    expect(provided.status).toBe(200);
    expect(f.resume).toHaveBeenCalledOnce();
  });

  it.each(["relay PC", "phone", "Tailscale PC", "local PC"])("rejects an unauthenticated %s save without storing anything", async (mode) => {
    const f = await fixture(mode, custom);
    const response = await f.post("/api/credentials", custom, { host: HOST, origin: `https://${HOST}` });
    expect(response.status).toBe(401);
    expect(f.persisted).toEqual([]);
    expect(f.applications).toEqual([]);
    expect(await response.text()).not.toContain(KEY);
  });

  it("forces encryption even when the owning desktop is a development build", async () => {
    const f = await fixture("phone", custom, { packaged: false });
    expect((await f.post("/api/credentials", custom)).status).toBe(200);
    expect(f.ownerStore.read()[custom.target]).toBe(custom.value);
  });

  it.each([{ encryptionAvailable: false }, { rejectApply: true }])("fails closed and rolls back on a desktop failure: %j", async (options) => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const f = await fixture("phone", custom, options);
    const response = await f.post("/api/credentials", custom);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(KEY);
    expect(f.ownerStore.read()).toEqual({ existing: "kept" });
    expect(f.viewerStore.read()).toEqual({ existing: "viewer-kept" });
    expect(f.resume).not.toHaveBeenCalled();
    expect(logs.flatMap((log) => log.mock.calls).flat().join(" ")).not.toContain(KEY);
  });

  it("fails closed after the owning desktop exits", async () => {
    const f = await fixture("phone", custom);
    await f.bridge.close();
    const response = await f.post("/api/credentials", custom);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "desktop-unavailable" });
    expect(f.persisted).toEqual([]);
    expect(f.applications).toEqual([]);
  });

  it("fails closed on a headless server without calling a config writer", async () => {
    const fetchImpl = vi.fn();
    expect(await credentialSaveResponse(null, custom, fetchImpl)).toEqual({ status: 503, body: { error: "desktop-unavailable" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {}, { target: "__proto__", value: KEY }, { target: "ttsKey", value: "bad\nkey" },
    { ...custom, value: "not json" }, { ...custom, value: "null" },
    { ...custom, value: JSON.stringify({ name: "Acme", header: "cookie", prefix: "", key: KEY }) },
  ])("rejects invalid input without echoing or forwarding it: %j", async (input) => {
    const fetchImpl = vi.fn();
    const reply = await credentialSaveResponse({ url: "http://127.0.0.1:1", token: BOOT_TOKEN }, input, fetchImpl);
    expect(reply).toEqual({ status: 400, body: { error: "invalid-credential" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a positive confirmation and never forwards bridge response fields", async () => {
    for (const [body, status] of [[{ saved: true, key: KEY }, 200], [{ error: KEY }, 503], [{}, 503]]) {
      const reply = await credentialSaveResponse({ url: "http://127.0.0.1:1", token: BOOT_TOKEN }, custom,
        async () => new Response(JSON.stringify(body)));
      expect(reply.status).toBe(status);
      expect(JSON.stringify(reply)).not.toContain(KEY);
    }
  });

  it("wires credential saves after the existing session gate and keeps encrypted persistence", () => {
    const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    expect(server.indexOf('path === "/api/credentials"')).toBeGreaterThan(server.indexOf("!credentials.phoneSession &&"));
    expect(server).toContain("credentialSaveResponse(terminalBridgeAccess, await readBody(req))");
    expect(server).toContain('externalSecretStorage && !credentials.bearerOk');
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    expect(main).toContain("updateCredentials: updateSecureCredentialDocument");
    expect(main).toContain("writeCredential(name, value, { encrypted: true })");
    expect(main).toContain("safeStorage.encryptStringAsync(JSON.stringify(credentials))");
  });
});
