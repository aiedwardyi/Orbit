import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const branch = source.split('case "runtime.error":')[1].split('case "thread.token-usage.updated":')[0];

function errorRow(event: Extract<RuntimeEvent, { type: "runtime.error" }>) {
  const rows: Message[] = [];
  const run = new Function("event", "unreadTurns", "store", "pushMessage", "bot", branch.replace(/break;\s*$/, ""));
  run(event, { start() {} }, { messagesFor: () => [] }, (row: Message) => rows.push(row), null);
  return rows[0];
}

describe("folder error rows", () => {
  it("carries the full missing path beside setup and sign-in metadata", () => {
    const folder = `C:\\projects\\${"long-".repeat(60)}\\missing`;
    const event = { type: "runtime.error", message: `Project folder not found: \`${folder}\`.`, folder, setup: false, signIn: false } as Extract<RuntimeEvent, { type: "runtime.error" }>;
    expect(errorRow(event).tool).toMatchObject({ folder, ok: false, setup: false, signIn: false });
  });
});
