import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PACKAGED_FILES } from "./proxy-paths.ts";
import { CREDENTIAL_PROMPT, loadCredentialPrompt } from "./wink-guide.ts";

describe("wink guide", () => {
  it("tries signed-in engines before asking for a key", () => {
    expect(CREDENTIAL_PROMPT).toContain("Before asking for an API key, try an engine the user is signed into, as a worker pane or a teammate bot: it needs no key. If none can do the job, use request_credential to show the secure in-app card. Never ask the user to paste credentials into chat.");
  });

  it("points to the packaged guide", () => {
    expect(CREDENTIAL_PROMPT).toContain(`How Wink itself works (engines, keys, workers, sync, phone): ${PACKAGED_FILES.winkGuide}. Read it only when a task is about Wink.`);
  });

  it("warns on and skips the pointer when the guide is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = join("missing", "wink-guide.md");
    const prompt = loadCredentialPrompt(file);
    expect(prompt).toContain("use request_credential");
    expect(prompt).not.toContain("How Wink itself works");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(file));
    warn.mockRestore();
  });
});
