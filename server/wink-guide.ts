import { existsSync } from "node:fs";

import { PACKAGED_FILES } from "./proxy-paths.ts";

const ASK_FOR_KEY = "Before asking for an API key, try a signed-in engine as a worker pane or teammate bot; if the one the job needs is signed out, say so. Use request_credential only when a job needs a provider's own API. Never ask the user to paste credentials into chat.";

// Resolved once at startup: the system text must stay static per install.
export function loadCredentialPrompt(file: string = PACKAGED_FILES.winkGuide): string {
  if (!existsSync(file)) {
    console.warn(`wink guide: could not find ${file}; the prompt ships without its pointer`);
    return ASK_FOR_KEY;
  }
  return `${ASK_FOR_KEY} How Wink itself works (engines, keys, workers, sync, phone): ${file}. Read it only when a task is about Wink.`;
}

export const CREDENTIAL_PROMPT = loadCredentialPrompt();
