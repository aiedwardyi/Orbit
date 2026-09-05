import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  composerBusyChrome,
  composerBusySendAction,
  composerSendSourceText,
  peelNextBusyRoomSend,
  pendingSteerEntries,
} from "./composer-busy";
import { applyLocale, translate } from "./i18n";
import { en, ko } from "./i18n-catalog";

const enT = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
  translate("en", key, vars);

afterEach(() => {
  applyLocale("en");
});

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(join(here, "../components/Composer.tsx"), "utf8");
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");

const idle = "Message Scout";

describe("composerBusyChrome", () => {
  it("keeps the 1:1 box a chat field while a turn is in flight", () => {
    const chrome = composerBusyChrome({
      busy: true,
      isRoom: false,
      canSteer: false,
      name: "Scout",
      idlePlaceholder: idle,
    }, enT);
    expect(chrome.placeholder).toBe(idle);
    expect(chrome.sendLooksQueued).toBe(false);
    expect(chrome.sendAriaKey).toBe("composer.sendMessage");
    expect(chrome.sendTitleKey).toBe("composer.send");
    expect(chrome.placeholder).not.toMatch(/working|turn finishes/i);
  });

  it("lets steer stay a send, not a queue lecture", () => {
    const chrome = composerBusyChrome({
      busy: true,
      isRoom: false,
      canSteer: true,
      name: "Scout",
      idlePlaceholder: idle,
    }, enT);
    expect(chrome.placeholder).toBe(idle);
    expect(chrome.sendLooksQueued).toBe(false);
    expect(chrome.sendAriaKey).toBe("composer.sendIntoTurn");
  });

  it("uses the supplied English translator even when Korean is active", () => {
    applyLocale("ko");
    const chrome = composerBusyChrome({
      busy: true,
      isRoom: true,
      canSteer: false,
      name: "Scout",
      idlePlaceholder: "Message Launch",
    }, enT);
    expect(chrome.placeholder).toBe("Scout is working — Enter queues your message");
  });

  it("keeps room busy-queue chrome so Enter is visibly a queue, not a stop", () => {
    const chrome = composerBusyChrome({
      busy: true,
      isRoom: true,
      canSteer: false,
      name: "Scout",
      idlePlaceholder: "Message Launch",
    }, enT);
    expect(chrome.placeholder).toBe("Scout is working — Enter queues your message");
    expect(chrome.sendLooksQueued).toBe(true);
    expect(chrome.sendAriaKey).toBe("composer.queueMessage");
    expect(chrome.sendTitleKey).toBe("composer.sendsWhenFinished");
  });

  it("keeps room queue chrome even if a member could steer a 1:1 turn", () => {
    const chrome = composerBusyChrome({
      busy: true,
      isRoom: true,
      canSteer: true,
      name: "Scout",
      idlePlaceholder: "Message Launch",
    }, enT);
    expect(chrome.sendLooksQueued).toBe(true);
    expect(chrome.placeholder).toBe("Scout is working — Enter queues your message");
  });

  it("is idle chrome when nobody is working", () => {
    const chrome = composerBusyChrome({
      busy: false,
      isRoom: false,
      canSteer: false,
      name: "Scout",
      idlePlaceholder: idle,
    }, enT);
    expect(chrome).toEqual({
      placeholder: idle,
      sendLooksQueued: false,
      sendAriaKey: "composer.sendMessage",
      sendTitleKey: "composer.send",
    });
  });
});

describe("Composer wiring", () => {
  it("uses composerBusyChrome and does not hard-code the 1:1 wait lecture", () => {
    expect(composer).toContain("composerBusyChrome");
    expect(composer).not.toContain('t("composer.waitHint"');
    expect(composer).not.toContain("composer.waitHint");
    expect(composer).toContain("disabled={Boolean(approval) || locked}");
    expect(composer).not.toMatch(/disabled=\{[^}]*busy/);
    expect(composer).toContain("pendingSteerEntries");
    expect(composer).toContain("composerBusySendAction");
    expect(composer).toContain("composerSendSourceText");
    expect(composer).toContain("peelNextBusyRoomSend");
    expect(composer).toContain("takeRestoredSendId");
    expect(composer).not.toMatch(/group && queued\) return/);
    expect(composer).not.toContain("disabled={Boolean(group && queued)}");
    expect(composer).not.toMatch(/entry\.text\)\.join\(/);
    expect(composer).toContain('t("composer.queuedUntil", { text: entry.text })');
    expect(composer).not.toMatch(/composer\.queuedUntil", \{ name:/);
  });
});

describe("pendingSteerEntries", () => {
  it("keeps each queued 1:1 send as its own chip instead of joining them", () => {
    expect(
      pendingSteerEntries(
        {
          t1: [
            { queueId: "a", text: "one" },
            { queueId: "b", text: "two" },
          ],
        },
        "t1",
      ),
    ).toEqual([
      { queueId: "a", text: "one" },
      { queueId: "b", text: "two" },
    ]);
  });

  it("returns no chips when the thread has nothing waiting", () => {
    expect(pendingSteerEntries(undefined, "t1")).toEqual([]);
    expect(pendingSteerEntries({ t2: [{ queueId: "x", text: "other" }] }, "t1")).toEqual([]);
  });
});

/** Desktop QA fill+Enter burst: each line is already in the live textarea,
 * while React's rendered draft may still be the previous send (or empty). */
function busyEnterBurst(
  lines: string[],
  input: { locked?: boolean; isRoom: boolean; busy: boolean },
  renderedDraft = "",
): string[] {
  const accepted: string[] = [];
  let rendered = renderedDraft;
  for (const live of lines) {
    const action = composerBusySendAction({
      locked: Boolean(input.locked),
      isRoom: input.isRoom,
      busy: input.busy,
      heldCount: accepted.length,
    });
    if (action === "block") continue;
    const text = composerSendSourceText(live, rendered);
    if (!text.trim()) continue;
    accepted.push(text);
    rendered = "";
  }
  return accepted;
}

const spamLines = Array.from({ length: 8 }, (_, index) => `ADV-QUEUE-${index}`);

describe("busy Enter-spam", () => {
  it("sends every 1:1 line from a live fill+Enter burst even when React still shows the first", () => {
    expect(busyEnterBurst(spamLines, { isRoom: false, busy: true }, "ADV-QUEUE-0")).toEqual(spamLines);
  });

  it("queues every room line while a member is speaking instead of dropping after the first", () => {
    expect(busyEnterBurst(spamLines, { isRoom: true, busy: true })).toEqual(spamLines);
  });

  it("does not treat an already-held room send as a hard stop", () => {
    expect(
      composerBusySendAction({ locked: false, isRoom: true, busy: true, heldCount: 1 }),
    ).toBe("enqueue");
    expect(
      composerBusySendAction({ locked: false, isRoom: true, busy: true, heldCount: 7 }),
    ).toBe("enqueue");
  });

  it("still POSTs 1:1 while busy and blocks only a locked composer", () => {
    expect(composerBusySendAction({ locked: false, isRoom: false, busy: true, heldCount: 3 })).toBe(
      "dispatch",
    );
    expect(composerBusySendAction({ locked: true, isRoom: false, busy: true })).toBe("block");
    expect(composerBusySendAction({ locked: false, isRoom: true, busy: false })).toBe("dispatch");
  });

  it("prefers the live textarea so a stale rendered draft cannot resend or drop later lines", () => {
    expect(composerSendSourceText("ADV-QUEUE-1", "ADV-QUEUE-0")).toBe("ADV-QUEUE-1");
    expect(composerSendSourceText("ADV-QUEUE-1", "")).toBe("ADV-QUEUE-1");
    expect(composerSendSourceText("", "ADV-QUEUE-0")).toBe("");
    expect(composerSendSourceText(undefined, "ADV-QUEUE-0")).toBe("ADV-QUEUE-0");
  });

  it("peels room holds FIFO so settle flushes ADV-QUEUE-0..n in order", () => {
    const texts: string[] = [];
    let queue = spamLines.map((text) => ({ text }));
    while (queue.length) {
      const peeled = peelNextBusyRoomSend(queue);
      if (!peeled.next) break;
      texts.push(peeled.next.text);
      queue = peeled.rest;
    }
    expect(texts).toEqual(spamLines);
  });
});

describe("queued follow-up copy", () => {
  it("softens the pending-chip lecture without dropping the queue", () => {
    expect(en["composer.queuedUntil"]).toBe("Sends next: “{text}”");
    expect(ko["composer.queuedUntil"]).toBe("다음에 보내집니다: “{text}”");
    expect(en["composer.queuedUntil"]).not.toMatch(/working|turn finishes/i);
    expect(en["chat.queuedSendsNext"]).toBe("Sends next");
    expect(ko["chat.queuedSendsNext"]).toBe("다음에 보내집니다");
    expect(chatView).toContain('t("chat.queuedSendsNext")');
    expect(chatView).not.toMatch(/Queued — sends when this turn finishes/);
  });
});
