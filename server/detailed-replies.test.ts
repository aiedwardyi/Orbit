import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import * as config from "./config.ts";
import * as flags from "../src/lib/feature-flags.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const original = " Never end a turn without a user-visible reply. If the user writes to you while you're working, reply to that message right away in a short visible message (for a correction or instruction, a one-line acknowledgment), then keep working unless they asked you to stop or pause; never answer it only in your thinking. This covers messages the user types, not pane notes or other automated messages. Some engines replace longer text written between tool calls with a short summary, so keep each mid-turn message to one short line, and put answers, links, lists and anything the user must read exactly in your final message. Say each thing once: do not restate what you already told the user, in this turn or earlier ones, unless it changed, and do not repeat a status the user already has; if a turn brings nothing new, reply in one short line. Default voice (your role description and the user's requests always win, including any length or teaching style they set): lead with the answer, default to 2-5 short lines, give the few points that matter most rather than every option unless the user asks for all of them, use plain words, prefer a few bullets over paragraphs, and be warm. If a question needs working out, work it out before answering. Skip preamble, recaps and generic closing offers; a question you need answered, or asking before you act, is not padding. Code, plans, drafts, commands and anything the user will paste or follow step by step are deliverables: give them in full. After tool work, close with a short standalone summary of what you did and found. Otherwise go longer only when the user asks or the task truly needs it, and even then lead with the verdict.";
const start = source.indexOf("const ALWAYS_REPLY_FUNCTIONAL_INSTRUCTIONS =");
const constants = source.slice(start, source.indexOf("const CORPUS_SEARCH_INSTRUCTIONS =", start));
const callSites = [...source.matchAll(/\(detailedRepliesEnabled\(cfg\) \? DETAILED_REPLY_INSTRUCTIONS : ALWAYS_REPLY_INSTRUCTIONS\) \+/g)];

describe("detailed replies", () => {
  it("persists the setting and defaults to off on both sides", () => {
    expect(config.parseConfigPatch({ features: { detailedReplies: true } })).toEqual({ features: { detailedReplies: true } });
    expect(config.parseStoredConfig({ features: { detailedReplies: false } })).toEqual({ features: { detailedReplies: false } });
    expect(() => config.parseConfigPatch({ features: { detailedReplies: "yes" } })).toThrow();
    for (const enabled of [config.detailedRepliesEnabled, flags.detailedRepliesEnabled]) {
      expect(enabled({})).toBe(false);
      expect(enabled({ features: {} })).toBe(false);
      expect(enabled({ features: { detailedReplies: false } })).toBe(false);
      expect(enabled({ features: { detailedReplies: true } })).toBe(true);
    }
    expect(source).toContain("detailedReplies: detailedRepliesEnabled(cfg)");
  });

  it("keeps OFF byte-identical at both call sites and changes on the next selection", () => {
    expect(callSites).toHaveLength(2);
    for (const [expression] of callSites) {
      for (const on of [false, true, false]) {
        const prompt = runInNewContext(constants + expression.slice(0, -2), {
          cfg: { features: { detailedReplies: on } }, detailedRepliesEnabled: config.detailedRepliesEnabled,
        });
        expect(prompt).toBe(on ? original.slice(0, original.indexOf(" Default voice (")) : original);
        expect(prompt).toContain("Never end a turn without a user-visible reply.");
        expect(prompt).toContain("keep each mid-turn message to one short line");
        expect(prompt).toContain("Say each thing once:");
        if (on) expect(prompt).not.toContain("Default voice");
      }
    }
  });

  it("saves the flag without dropping sibling feature settings", () => {
    config.saveConfig({ features: { showToolCalls: true, skillRecorder: true } });
    config.saveConfig({ features: { detailedReplies: true } });
    expect(config.loadConfig().features).toEqual({ showToolCalls: true, skillRecorder: true, detailedReplies: true });
    config.saveConfig({ features: { detailedReplies: false } });
    expect(config.detailedRepliesEnabled(config.loadConfig())).toBe(false);
    expect(config.showToolCallsEnabled(config.loadConfig())).toBe(true);
  });

  it("drops brevity from the room reply line only when on", () => {
    const line = source.match(/`Reply as yourself, \$\{[^`]*`/)?.[0];
    expect(line).toBeDefined();
    for (const on of [false, true]) {
      const text = runInNewContext(line!, {
        cfg: { features: { detailedReplies: on } }, detailedRepliesEnabled: config.detailedRepliesEnabled,
      });
      expect(text).toMatch(on ? /^Reply as yourself, conversationally\. To bring/ : /^Reply as yourself, briefly and conversationally\. To bring/);
    }
  });
});
