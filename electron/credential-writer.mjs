const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  geminiApiKey: (value) => ({ gemini: { apiKey: value } }),
  openaiCompatKey: (value) => ({ openaiCompat: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  anthropicApiKey: (value) => ({ anthropic: { key: value } }),
  vertexApiKey: (value) => ({ vertex: { key: value } }),
};

export function createCredentialWriter({ packaged, isEncryptionAvailable, updateCredentials, serverAccess, fetchImpl = fetch }) {
  return async (name, value, { encrypted = packaged } = {}) => {
    const customHost = /^custom:([a-z0-9.-]{1,253})$/.exec(String(name))?.[1];
    const patchFor = customHost
      ? (secret) => ({ customKeys: { [customHost]: secret ? JSON.parse(secret) : null } })
      : Object.hasOwn(CREDENTIAL_PATCH, name) ? CREDENTIAL_PATCH[name] : null;
    if (!patchFor || typeof value !== "string") throw new Error("Unsupported credential");
    if (encrypted && !(await isEncryptionAvailable())) {
      throw new Error("The operating-system credential store is unavailable");
    }
    const secret = value.trim();
    const patch = patchFor(secret);
    const applyToHarness = async () => {
      const { port, token } = serverAccess();
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/config${encrypted ? "?secretStorage=external" : ""}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "error",
        body: JSON.stringify(patch),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
      return body;
    };
    if (!encrypted) return applyToHarness();
    // Roll back the encrypted document if the owning server rejects the change.
    return updateCredentials((credentials) => {
      if (secret) credentials[name] = secret;
      else delete credentials[name];
      return credentials;
    }, applyToHarness);
  };
}
