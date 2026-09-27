/**
 * Credentials an agent may ask the person to provide through an inline
 * card. The id is the entire authority surface: agents never choose a
 * config path, label, URL, or arbitrary field name.
 */
export const CREDENTIAL_TARGETS = {
  xaiApiKey: {
    label: "xAI API key",
    description: "Used by the built-in Grok provider.",
    placeholder: "xai-…",
    helpUrl: "https://console.x.ai/",
  },
  geminiApiKey: {
    label: "Gemini API key",
    description: "Runs the native Gemini CLI directly.",
    placeholder: "Paste your Gemini API key",
    helpUrl: "https://aistudio.google.com/apikey",
  },
  boxToken: {
    label: "Box API key",
    description: "Gives bots an isolated cloud computer when Box is selected.",
    placeholder: "Paste your Box API key",
    helpUrl: "https://docs.ascii.dev/box/api-keys",
  },
  ttsKey: {
    label: "ElevenLabs API key",
    description: "Enables text-to-speech voices in calls.",
    placeholder: "Paste your ElevenLabs API key",
    helpUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  openaiImageApiKey: {
    label: "OpenAI API key",
    description: "Used to generate bot avatars and images bots create with generate_image.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  anthropicApiKey: {
    label: "Claude API key",
    description: "Lets bots call the Claude API with call_api.",
    placeholder: "sk-ant-…",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  vertexApiKey: {
    label: "Vertex AI API key",
    description: "Lets bots call Vertex AI with call_api.",
    placeholder: "Paste your Vertex AI API key",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
  },
} as const;

/** Hosts call_api may send each key to, and the header it goes in. Box is not brokered. */
export const CREDENTIAL_BROKER = {
  openaiImageApiKey: { hosts: ["api.openai.com"], header: "authorization", prefix: "Bearer " },
  xaiApiKey: { hosts: ["api.x.ai"], header: "authorization", prefix: "Bearer " },
  geminiApiKey: { hosts: ["generativelanguage.googleapis.com"], header: "x-goog-api-key", prefix: "" },
  ttsKey: { hosts: ["api.elevenlabs.io"], header: "xi-api-key", prefix: "" },
  anthropicApiKey: { hosts: ["api.anthropic.com"], header: "x-api-key", prefix: "" },
  vertexApiKey: { hosts: ["aiplatform.googleapis.com"], header: "x-goog-api-key", prefix: "" },
} as const;

export type CredentialTargetId = keyof typeof CREDENTIAL_TARGETS;
export type BrokeredCredentialId = keyof typeof CREDENTIAL_BROKER;

export function isBrokeredCredentialId(value: unknown): value is BrokeredCredentialId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CREDENTIAL_BROKER, value);
}
export type CredentialConfig = {
  xai?: { key?: string };
  gemini?: { apiKey?: string };
  box?: { token?: string };
  tts?: { key?: string };
  imageGen?: { key?: string };
  anthropic?: { key?: string };
  vertex?: { key?: string };
};

export function isCredentialTargetId(value: unknown): value is CredentialTargetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CREDENTIAL_TARGETS, value);
}

export function credentialConfigPatch(id: CredentialTargetId, value: string): CredentialConfig {
  switch (id) {
    case "xaiApiKey":
      return { xai: { key: value } };
    case "geminiApiKey":
      return { gemini: { apiKey: value } };
    case "boxToken":
      return { box: { token: value } };
    case "ttsKey":
      return { tts: { key: value } };
    case "openaiImageApiKey":
      return { imageGen: { key: value } };
    case "anthropicApiKey":
      return { anthropic: { key: value } };
    case "vertexApiKey":
      return { vertex: { key: value } };
  }
}

export function credentialValue(config: CredentialConfig, id: CredentialTargetId): string {
  switch (id) {
    case "xaiApiKey":
      return config.xai?.key ?? "";
    case "geminiApiKey":
      return config.gemini?.apiKey ?? "";
    case "boxToken":
      return config.box?.token ?? "";
    case "ttsKey":
      return config.tts?.key ?? "";
    case "openaiImageApiKey":
      return config.imageGen?.key ?? "";
    case "anthropicApiKey":
      return config.anthropic?.key ?? "";
    case "vertexApiKey":
      return config.vertex?.key ?? "";
  }
}

export function credentialIsConfigured(config: CredentialConfig, id: CredentialTargetId): boolean {
  return Boolean(credentialValue(config, id));
}

export function isReusableCredentialRequest(
  message: {
    kind?: unknown;
    secret?: { target?: unknown; provided?: unknown; dismissed?: unknown };
    from?: { botId?: unknown };
  },
  target: CredentialTargetId,
  requestingBotId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "secret" &&
    message.secret?.target === target &&
    message.secret.provided !== true &&
    message.secret.dismissed !== true &&
    (!roomThread || message.from?.botId === requestingBotId)
  );
}

export function credentialResumeOutcome(state: {
  provided?: unknown;
  dismissed?: unknown;
}): "provided" | "dismissed" | null {
  const provided = state.provided === true;
  const dismissed = state.dismissed === true;
  if (provided === dismissed) return null;
  return provided ? "provided" : "dismissed";
}
