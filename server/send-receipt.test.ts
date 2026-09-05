import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sendPostReceipt, startedTurn } from "./send-receipt.ts";
import type { Message } from "./store.ts";

const message: Message = {
  id: "m1",
  at: 1,
  role: "user",
  kind: "text",
  text: "hello",
  sendId: "send_dispatchfail0001",
};

describe("send POST receipt", () => {
  it("marks a prepare failure so the client can reject optimistic Thinking", () => {
    const failed = startedTurn(message, { dispatchFailed: true, error: "context too large" });
    expect(sendPostReceipt(failed, "thread-1")).toEqual({
      ok: true,
      threadId: "thread-1",
      message,
      dispatchFailed: true,
      error: "context too large",
    });
  });

  it("omits dispatchFailed when the turn actually started", () => {
    expect(sendPostReceipt(startedTurn(message), "thread-1")).toEqual({
      ok: true,
      threadId: "thread-1",
      message,
    });
  });

  it("wires prepare failure onto the 1:1 POST receipt", () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    expect(index).toContain("sendPostReceipt(started, threadId)");
    expect(index).toContain("dispatchFailed: true");
  });

  it("marks a cancelled send so the client does not keep Thinking", () => {
    expect(sendPostReceipt(startedTurn(message, { cancelled: true }), "thread-1")).toEqual({
      ok: true,
      threadId: "thread-1",
      message,
      cancelled: true,
    });
  });

  it("cancels before append without a user line or a 409", () => {
    expect(sendPostReceipt(startedTurn(undefined, { cancelled: true }), "thread-1")).toEqual({
      ok: true,
      threadId: "thread-1",
      cancelled: true,
    });
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    expect(index).not.toContain('new Error("this send was cancelled")');
    expect(index).toContain("return startedTurn(opts.userMessage, { cancelled: true })");
  });
});
