import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyInvite } from "../../shared/relay-protocol.ts";
import { mintInviteFromFile } from "../scripts/mint-invite.ts";
import { loadConfig, operatorKeyPath, readOperatorKey } from "../src/config.ts";

async function keyFile(mode: number, key = generateKeyPairSync("ed25519").privateKey) {
  const dir = await mkdtemp(join(tmpdir(), "wink-key-"));
  const path = join(dir, "operator.key");
  await writeFile(path, key.export({ format: "pem", type: "pkcs8" }), { mode });
  await chmod(path, mode);
  return { path, key };
}

describe("mint-invite", () => {
  it("mints an invite the operator public key verifies, valid for the requested days", async () => {
    const { path, key } = await keyFile(0o600);
    const now = Date.now();
    const invite = await mintInviteFromFile(path, 2, now);
    const opened = verifyInvite(invite, createPublicKey(key), { now });
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.value.exp).toBe(Math.floor(now / 1000) + 2 * 86400);
    expect(invite).not.toContain("PRIVATE KEY");
  });

  it.skipIf(process.platform === "win32")("refuses a key file other users can read", async () => {
    const { path } = await keyFile(0o644);
    await expect(mintInviteFromFile(path)).rejects.toThrow(/chmod 600/);
  });

  it("refuses non-Ed25519 keys without echoing them", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
    const { path } = await keyFile(0o600, rsa);
    await expect(readOperatorKey(path)).rejects.toThrow(/^operator key must be Ed25519$/);
    await expect(mintInviteFromFile(path, 99)).rejects.toThrow(/ttl-days/);
  });
});

describe("config", () => {
  it("loads a config, takes the base as data and prefers the systemd credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wink-cfg-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        base: "Wink.Example.COM",
        operatorKeyFile: "/etc/wink-relay/operator.key",
        acme: { directoryUrl: "https://ca.invalid/directory", termsOfServiceAgreed: true },
      }),
    );
    const config = await loadConfig(path);
    expect(config.base).toBe("wink.example.com");
    expect(config.listen).toEqual({ host: "::", port: 443 });
    expect(operatorKeyPath(config, {})).toBe("/etc/wink-relay/operator.key");
    expect(operatorKeyPath(config, { CREDENTIALS_DIRECTORY: "/run/credentials/wink-relay.service" })).toBe(
      "/run/credentials/wink-relay.service/operator.key",
    );
  });

  it("rejects bad bases, unknown keys and ACME without accepted terms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wink-cfg-"));
    const path = join(dir, "config.json");
    const acme = { directoryUrl: "https://ca.invalid/d", termsOfServiceAgreed: true };
    for (const bad of [
      { base: "localhost", acme },
      { base: "x.example", acme, extra: 1 },
      { base: "x.example", acme: { ...acme, termsOfServiceAgreed: false } },
      { base: "x.example", acme: { ...acme, directoryUrl: "http://ca.invalid/d" } },
    ]) {
      await writeFile(path, JSON.stringify(bad));
      await expect(loadConfig(path)).rejects.toThrow(/config is invalid/);
    }
  });
});
