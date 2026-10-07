// Relay configuration file and operator key loading.

import { createPrivateKey, type KeyObject } from "node:crypto";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import type { RelayLimits } from "./limits.ts";

export const BASE_RE = /^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const limitsSchema = z
  .record(z.string(), z.number().nonnegative())
  .optional()
  .transform((v) => v as Partial<RelayLimits> | undefined);

export const configSchema = z.strictObject({
  /** Base domain; PCs live at <label>.<base>, the relay at relay.<base>. */
  base: z.string().toLowerCase().regex(BASE_RE),
  listen: z
    .strictObject({ host: z.string().default("::"), port: z.int().min(1).max(65535).default(443) })
    .default({ host: "::", port: 443 }),
  dataDir: z.string().min(1).default("/var/lib/wink-relay"),
  /** Used only when systemd's CREDENTIALS_DIRECTORY is not set. */
  operatorKeyFile: z.string().optional(),
  revokedLabelsFile: z.string().optional(),
  acme: z.strictObject({
    directoryUrl: z.url({ protocol: /^https$/ }),
    email: z.email().optional(),
    termsOfServiceAgreed: z.literal(true),
  }),
  limits: limitsSchema,
});

export type RelayConfig = z.infer<typeof configSchema>;

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 4 * 1024;

async function readSmall(path: string, max: number, what: string, privateFile: boolean): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${what} is not a regular file`);
    if (info.size > max) throw new Error(`${what} is too large`);
    if (privateFile && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`${what} must not be readable by group or others (chmod 600)`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function loadConfig(path: string): Promise<RelayConfig> {
  const text = await readSmall(path, MAX_CONFIG_BYTES, "config", false);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("config is not valid JSON");
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`config is invalid: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`);
  }
  return parsed.data;
}

/** Reads an Ed25519 PKCS#8 PEM private key from a private file. Errors never echo key material. */
export async function readOperatorKey(path: string): Promise<KeyObject> {
  const pem = await readSmall(path, MAX_KEY_BYTES, "operator key file", true);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new Error("operator key file is not a PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("operator key must be Ed25519");
  return key;
}

/** systemd LoadCredential= wins over the config path. */
export function operatorKeyPath(config: RelayConfig, env: NodeJS.ProcessEnv = process.env): string {
  // A systemd credential path, so always POSIX separators.
  if (env.CREDENTIALS_DIRECTORY) return posix.join(env.CREDENTIALS_DIRECTORY, "operator.key");
  if (config.operatorKeyFile) return config.operatorKeyFile;
  throw new Error("no operator key: set CREDENTIALS_DIRECTORY or operatorKeyFile");
}
