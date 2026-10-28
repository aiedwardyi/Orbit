import type { CredentialId } from "../../shared/credential-request";
import type { Translate } from "@/lib/i18n";
import { api, type ConfigStatus } from "@/state/store";

export const CREDENTIAL_ERROR_KEY = {
  "desktop-unavailable": "secret.desktopUnavailable",
  "credential-rejected": "secret.credentialRejected",
  "credential-save-timeout": "secret.saveTimeout",
  "invalid-credential": "secret.invalidCredential",
  "credential-save-failed": "secret.saveFailed",
} as const;

export function credentialErrorMessage(error: unknown, t: Translate): string {
  const reason = error instanceof Error ? error.message : String(error);
  const key = Object.hasOwn(CREDENTIAL_ERROR_KEY, reason) ? CREDENTIAL_ERROR_KEY[reason as keyof typeof CREDENTIAL_ERROR_KEY] : undefined;
  return key ? t(key) : reason;
}

export async function saveCredential(target: CredentialId | "composioApiKey" | "openaiCompatKey", value: string): Promise<ConfigStatus> {
  if (window.ogb?.setCredential) return window.ogb.setCredential(target, value);
  const result: { saved: boolean; config: ConfigStatus } = await api("/api/credentials", {
    method: "POST",
    body: JSON.stringify({ target, value }),
  });
  if (result.saved !== true) throw new Error("credential-save-failed");
  return result.config;
}
