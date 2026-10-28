import type { CredentialId } from "../../shared/credential-request";
import { api, type ConfigStatus } from "@/state/store";

export async function saveCredential(target: CredentialId | "composioApiKey" | "openaiCompatKey", value: string): Promise<ConfigStatus> {
  if (window.ogb?.setCredential) return window.ogb.setCredential(target, value);
  const result: { saved: boolean; config: ConfigStatus } = await api("/api/credentials", {
    method: "POST",
    body: JSON.stringify({ target, value }),
  });
  if (result.saved !== true) throw new Error("credential-save-failed");
  return result.config;
}
