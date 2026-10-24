import { existsSync } from "node:fs";

import { PACKAGED_FILES } from "./proxy-paths.ts";

const ASK_FOR_KEY = "Before asking for an API key, try an engine the user is signed into, as a worker pane or a teammate bot: it needs no key. If none can do the job, use request_credential to show the secure in-app card. Never ask the user to paste credentials into chat.";

// Resolved once at startup: the system text must stay static per install.
export function loadCredentialPrompt(file: string = PACKAGED_FILES.winkGuide): string {
  if (!existsSync(file)) {
    console.warn(`wink guide: could not find ${file}; the prompt ships without its pointer`);
    return ASK_FOR_KEY;
  }
  return `${ASK_FOR_KEY} How Wink itself works (engines, keys, workers, sync, phone): ${file}. Read it only when a task is about Wink.`;
}

export const CREDENTIAL_PROMPT = loadCredentialPrompt();
