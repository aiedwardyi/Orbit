// Gemini CLI over its native ACP stdio transport.
import { createAcpDriver, type AcpSupport } from "./core.ts";

const AUTH_PREFERENCE = ["gemini-api-key", "oauth-personal", "vertex-ai"];

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

/** The credential check as a named function, so the support entry and the
 * exported test surface are the same implementation, not a self-call.
 * Config is unused — kept to match the AcpSupport signature. */
export function geminiIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return nonBlank(env.GEMINI_API_KEY) || nonBlank(env.GOOGLE_API_KEY);
}

const support: AcpSupport = {
  driverKind: "geminiAgent",
  displayName: "Gemini API",
  models: {
    default: "auto",
    options: [
      { id: "auto", label: "Auto (recommended)" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  defaultCli: "gemini",
  nativeSource: "gemini.acp",
  loginNote: "Add a Gemini API key or use Gemini through Antigravity",

  install: {
    command: {
      darwin: "npm install -g @google/gemini-cli",
      linux: "npm install -g @google/gemini-cli",
      win32: "npm install -g @google/gemini-cli",
    },
    docsUrl: "https://geminicli.com/docs/get-started/installation/",
    signInCommand: "gemini",
    needsNode: true,
  },

  spawnArgs: (_config, turn) => ["--acp", ...(turn.model ? ["-m", turn.model] : [])],
  credentialEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],

  pickAuthMethod: (methods) => {
    const ids = methods.map((m) => m.id).filter((id): id is string => typeof id === "string");
    for (const pref of AUTH_PREFERENCE) if (ids.includes(pref)) return pref;
    return ids[0] ?? null;
  },
  authFailure: "continue",

  isAuthenticated: geminiIsAuthenticated,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GeminiAgentDriver = createAcpDriver(support);
