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

/** A site the bot named for a custom key. Only the fields a card showed ever bind that key. */
export type CustomService = { name: string; host: string; header: string; prefix: string };
export type CustomKey = Omit<CustomService, "host"> & { key: string };
export type CustomCredentialId = `custom:${string}`;
export type CredentialId = CredentialTargetId | CustomCredentialId;

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  "host", "cookie", "set-cookie", "content-length", "content-type", "transfer-encoding", "connection",
  "keep-alive", "upgrade", "te", "trailer", "expect", "origin", "referer",
]);

export function isCustomHost(host: string): boolean {
  return HOSTNAME.test(host) && !/\.(local|internal|localhost)$/.test(host);
}

export function isCustomCredentialId(value: unknown): value is CustomCredentialId {
  return typeof value === "string" && value.startsWith("custom:") && isCustomHost(value.slice(7));
}

export const customCredentialId = (host: string): CustomCredentialId => `custom:${host}`;

export function parseCustomService(value: unknown): { service: CustomService } | { error: string } {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const host = typeof input.host === "string" ? input.host.trim() : "";
  const header = input.header == null ? "authorization" : typeof input.header === "string" ? input.header.trim().toLowerCase() : "";
  const prefix = input.prefix ?? (header === "authorization" ? "Bearer " : "");
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) return { error: "service.name must be 1-60 plain characters" };
  if (!isCustomHost(host)) return { error: "service.host must be a bare public hostname like api.example.com" };
  if (!HEADER_TOKEN.test(header) || RESERVED_HEADERS.has(header) || /^(proxy-|sec-)/.test(header)) {
    return { error: "service.header must be a plain auth header name" };
  }
  if (typeof prefix !== "string" || !/^[\x20-\x7e]{0,40}$/.test(prefix)) return { error: "service.prefix must be up to 40 printable characters" };
  return { service: { name, host, header, prefix } };
}

export function isCustomKey(host: string, value: CustomKey): boolean {
  const parsed = parseCustomService({ ...value, host });
  return "service" in parsed && parsed.service.name === value.name && parsed.service.header === value.header &&
    parsed.service.prefix === value.prefix && Boolean(value.key.trim());
}

export const customKeyRecord = ({ name, header, prefix }: CustomService, key: string): CustomKey => ({ name, header, prefix, key });

export function customCredentialTarget(service: CustomService) {
  return {
    label: service.name,
    description: `Lets bots call ${service.host} with call_api.`,
    placeholder: "Paste your API key",
    helpUrl: "",
  };
}

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
  /** By host. Never persisted to config.json. */
  customKeys?: Record<string, CustomKey | null>;
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

export function credentialValue(config: CredentialConfig, id: CredentialId): string {
  if (isCustomCredentialId(id)) return config.customKeys?.[id.slice(7)]?.key ?? "";
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

export function credentialIsConfigured(config: CredentialConfig, id: CredentialId): boolean {
  return Boolean(credentialValue(config, id));
}

export function isReusableCredentialRequest(
  message: {
    kind?: unknown;
    secret?: { target?: unknown; provided?: unknown; dismissed?: unknown };
    from?: { botId?: unknown };
  },
  target: CredentialId,
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
