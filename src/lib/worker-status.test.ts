import { expect, it } from "vitest";
import type { Message } from "@/state/store";
import { translate, type Translate } from "./i18n";
import { sidebarWorkerStatus } from "./worker-status";

const launch = (id: string, at: number, nick: string, pane?: string): Message => ({ id, at, role: "bot", kind: "launch", text: `Launched ${nick}${pane ? `\nSession: ${pane}-1` : ""}` });
const done = (id: string, at: number, pane: string, label = ""): Message => ({ id, at, role: "bot", kind: "note", text: `[pane ${pane}] ${label ? `[${label}] ` : ""}from Ada (ada): DONE branch=x sha=y dirty=no` });
const t: Translate = (key, vars) => translate("en", key, vars);

it.each([false, true])("uses the newest run across panes sharing a nickname with tied times=%s", (tied) => {
  const messages = [launch("old", 1, "REVIEW", "aaaaaaaa"), done("done", 2, "aaaaaaaa"), launch("current", tied ? 2 : 3, "REVIEW", "bbbbbbbb")];
  expect(sidebarWorkerStatus(messages, ["REVIEW"], t)).toBe("1 worker");
});

it("uses the newest note label across panes sharing a nickname", () => {
  const messages = [done("old", 1, "aaaaaaaa", "REVIEW"), { ...done("current", 2, "bbbbbbbb", "REVIEW"), text: "[pane bbbbbbbb] [REVIEW] from Ada (ada): BLOCKED branch=x sha=y dirty=no" }];
  expect(sidebarWorkerStatus(messages, ["REVIEW"], t)).toBe("1 worker");
});

it("keeps an unlabeled live pane independent of an unlabeled completed note", () => {
  expect(sidebarWorkerStatus([launch("old", 1, "REVIEW", "aaaaaaaa"), done("done", 2, "aaaaaaaa")], [""], t)).toBe("1 worker");
});

it("uses the latest job on the matched pane even after its nickname changes", () => {
  const messages = [launch("old", 1, "REVIEW", "aaaaaaaa"), launch("new", 2, "SHIP", "aaaaaaaa"), done("done", 3, "aaaaaaaa", "SHIP")];
  expect(sidebarWorkerStatus(messages, ["REVIEW"], t)).toBe("");
});

it("keeps an unmatched live pane working until its launch arrives or it closes", () => {
  expect(sidebarWorkerStatus([], ["REVIEW"], t)).toBe("1 worker");
  expect(sidebarWorkerStatus([], [], t)).toBe("");
});
