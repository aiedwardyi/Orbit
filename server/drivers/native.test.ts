// The native tee is the file people paste into bug reports, so the wiring
// that keeps credentials out of it is tested at the writer — redact.test.ts
// covers the masking function, this covers that appendNative actually calls it.
// (server/testing/setup.ts points HOME at a throwaway dir, so NATIVE_DIR is
// already isolated from the real fleet.)
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { redactSecrets, StreamSecretMasker } from "../redact.ts";
import { appendNative, finishNative } from "./native.ts";

beforeAll(() => ensureDirs());

describe("appendNative", () => {
  it("keeps a PEM split across native messages off disk", () => {
    const chunks = ["-----BEGIN PRIVATE KEY-----\n", "SYNTHETICNATIVEBODY".repeat(20), "\n-----END PRIVATE KEY-----"];
    for (const text of chunks) {
      appendNative("t-split-pem", { dir: "in", source: "test", msg: { delta: { text } } });
      const log = readFileSync(join(NATIVE_DIR, "t-split-pem.ndjson"), "utf8");
      expect(log).not.toContain("SYNTHETICNATIVEBODY");
    }
    finishNative({ threadId: "t-split-pem", type: "turn.completed" });
    expect(readFileSync(join(NATIVE_DIR, "t-split-pem.ndjson"), "utf8")).not.toContain("SYNTHETICNATIVEBODY");
  });

  it("masks a complete secret with the existing placeholder", () => {
    const text = "-----BEGIN PRIVATE KEY-----\nSYNTHETICCOMPLETEBODY\n-----END PRIVATE KEY-----";
    appendNative("t-complete-pem", { dir: "in", source: "test", msg: { text } });
    finishNative({ threadId: "t-complete-pem", type: "turn.completed" });
    const rows = readFileSync(join(NATIVE_DIR, "t-complete-pem.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.msg.nativeTextTail?.text ?? row.msg.text).join("")).toBe(redactSecrets(text));
  });

  it("preserves complete outbound requests in their original record", () => {
    const msg = { method: "session/prompt", params: { prompt: [{ type: "text", text: "ordinary prompt with password=syntheticpassword" }] } };
    appendNative("t-outbound-request", { dir: "out", source: "acp", msg });
    const row = JSON.parse(readFileSync(join(NATIVE_DIR, "t-outbound-request.ndjson"), "utf8"));
    expect(row.msg).toEqual(redactSecrets(msg));
  });

  it("separates thought and message chunks at the same ACP path", () => {
    const append = (sessionUpdate: string, text: string) => appendNative("t-acp-streams", {
      dir: "in", source: "acp", msg: { params: { update: { sessionUpdate, content: { type: "text", text } } } },
    });
    append("agent_thought_chunk", "-----BEGIN PRIVATE KEY-----\n");
    append("agent_message_chunk", "visible answer");
    append("agent_thought_chunk", "SYNTHETICTHOUGHTBODY".repeat(20));
    finishNative({ threadId: "t-acp-streams", type: "turn.completed" });
    const log = readFileSync(join(NATIVE_DIR, "t-acp-streams.ndjson"), "utf8");
    expect(log).not.toContain("SYNTHETICTHOUGHTBODY");
    expect(log).toContain("visible answer");
  });

  it("keeps credential-name masking inside text payloads", () => {
    appendNative("t-nested-credentials", {
      dir: "out", source: "test", msg: { input: { password: "synthetic-password", env: [{ name: "API_KEY", value: "synthetic-env-value" }] } },
    });
    finishNative({ threadId: "t-nested-credentials", type: "turn.completed" });
    const log = readFileSync(join(NATIVE_DIR, "t-nested-credentials.ndjson"), "utf8");
    expect(log).not.toContain("synthetic-password");
    expect(log).not.toContain("synthetic-env-value");
  });

  it("separates JSON-RPC methods sharing a delta path", () => {
    const append = (method: string, delta: string) => appendNative("t-rpc-streams", {
      dir: "in", source: "test.rpc", msg: { method, params: { delta } },
    });
    append("item/reasoning/textDelta", "-----BE");
    append("item/agentMessage/delta", "visible response");
    append("item/reasoning/textDelta", "GIN PRIVATE KEY-----\n");
    append("item/reasoning/textDelta", "SYNTHETICRPCBODY".repeat(20));
    finishNative({ threadId: "t-rpc-streams", type: "turn.completed" });
    const log = readFileSync(join(NATIVE_DIR, "t-rpc-streams.ndjson"), "utf8");
    expect(log).not.toContain("SYNTHETICRPCBODY");
    expect(log).toContain("visible response");
  });

  it("isolates interleaved threads and keeps state through item updates", () => {
    appendNative("t-pem-a", { dir: "in", source: "test", msg: { text: "-----BEGIN PRIVATE KEY-----\n" } });
    appendNative("t-pem-b", { dir: "in", source: "test", msg: { text: "ordinary reply" } });
    finishNative({ threadId: "t-pem-a", type: "item.updated" });
    appendNative("t-pem-a", { dir: "in", source: "test", msg: { text: "SYNTHETICINTERLEAVEDBODY".repeat(20) } });
    finishNative({ threadId: "t-pem-b", type: "turn.completed" });
    finishNative({ threadId: "t-pem-a", type: "session.exited" });
    const a = readFileSync(join(NATIVE_DIR, "t-pem-a.ndjson"), "utf8");
    const b = readFileSync(join(NATIVE_DIR, "t-pem-b.ndjson"), "utf8");
    expect(a).not.toContain("SYNTHETICINTERLEAVEDBODY");
    expect(a).not.toContain("ordinary reply");
    expect(b).toContain("ordinary reply");
    expect(b).not.toContain("PRIVATE KEY");
  });

  it("isolates parallel provider streams on one thread", () => {
    const append = (parent_tool_use_id: string, text: string) => appendNative("t-parallel-streams", {
      dir: "in", source: "test.stream", msg: {
        type: "stream_event", parent_tool_use_id,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      },
    });
    const body = "SYNTHETICPARALLELBODY".repeat(20);
    const reply = "second stream ordinary reply ".repeat(10);
    append("task-a", "first stream -----BE");
    append("task-b", reply);
    append("task-a", `GIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`);
    finishNative({ threadId: "t-parallel-streams", type: "turn.completed" });
    const log = readFileSync(join(NATIVE_DIR, "t-parallel-streams.ndjson"), "utf8");
    expect(log).not.toContain("SYNTHETICPARALLELBODY");
    const rows = log.trim().split("\n").map((line) => JSON.parse(line));
    const textFor = (id: string) => rows.map((row) => {
      if (row.msg.parent_tool_use_id === id) return row.msg.event.delta.text;
      const tail = row.msg.nativeTextTail;
      return tail?.path.at(-1)?.endsWith(":text") && tail.path.some((part: string) => part.includes(id)) ? tail.text : "";
    }).join("");
    expect(textFor("task-a")).toBe(redactSecrets(`first stream -----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`));
    expect(textFor("task-b")).toBe(reply);
  });

  it.each(["turn.completed", "turn.retrying", "session.exited"])("releases held state on %s", (type) => {
    const threadId = `t-release-${type}`;
    appendNative(threadId, { dir: "in", source: "test", msg: { text: "-----BEGIN PRIVATE KEY-----\n" } });
    finishNative({ threadId, type });
    appendNative(threadId, { dir: "in", source: "test", msg: { text: "next turn reply" } });
    finishNative({ threadId, type });
    const log = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
    expect(log).toContain("next turn reply");
    const size = log.length;
    finishNative({ threadId, type });
    expect(readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")).toHaveLength(size);
  });

  it("contains flush failures and releases the thread state", () => {
    appendNative("t-flush-error", { dir: "in", source: "test", msg: { text: "held reply" } });
    const flush = vi.spyOn(StreamSecretMasker.prototype, "flush").mockImplementation(() => { throw new Error("synthetic flush failure"); });
    try {
      expect(() => finishNative({ threadId: "t-flush-error", type: "turn.completed" })).not.toThrow();
      finishNative({ threadId: "t-flush-error", type: "session.exited" });
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      flush.mockRestore();
    }
  });

  it("masks a streamed secret under value", () => {
    for (const value of ["-----BEGIN PRIVATE KEY-----\n", "SYNTHETICVALUEBODY".repeat(20), "\n-----END PRIVATE KEY-----"]) {
      appendNative("t-value-pem", { dir: "in", source: "test", msg: { value } });
      expect(readFileSync(join(NATIVE_DIR, "t-value-pem.ndjson"), "utf8")).not.toContain("SYNTHETICVALUEBODY");
    }
    finishNative({ threadId: "t-value-pem", type: "turn.completed" });
    expect(readFileSync(join(NATIVE_DIR, "t-value-pem.ndjson"), "utf8")).not.toContain("SYNTHETICVALUEBODY");
  });

  it("masks the tokens an ACP session/new hands the agent", () => {
    appendNative("t-native", {
      dir: "out",
      source: "acp",
      msg: {
        method: "session/new",
        params: {
          mcpServers: [
            {
              name: "computer",
              env: [
                { name: "OGB_BOX_ID", value: "box-7" },
                { name: "OGB_BOX_TOKEN", value: "box_live_dontlogme" },
              ],
            },
          ],
        },
      },
    });

    const log = readFileSync(join(NATIVE_DIR, "t-native.ndjson"), "utf8");
    expect(log).not.toContain("box_live_dontlogme");
    // the shape a debugger needs is still there: which server, which var
    expect(log).toContain("session/new");
    expect(log).toContain("OGB_BOX_TOKEN");
    expect(log).toContain("box-7");
  });

  it("writes the log private to the user", () => {
    appendNative("t-mode", { dir: "in", source: "acp", msg: { hello: "world" } });
    const mode = statSync(join(NATIVE_DIR, "t-mode.ndjson")).mode & 0o777;
    // Windows does not implement POSIX modes; everywhere else, owner-only
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => appendNative("t-bad", { dir: "in", source: "acp", msg: undefined })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendNative("t-cyclic", { dir: "in", source: "acp", msg: cyclic })).not.toThrow();
  });
});
