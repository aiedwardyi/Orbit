// The bus is the seam every client depends on: events must arrive
// stamped with their instanceId, cross-driver leaks must be dropped, and
// neither logging nor a broken listener may take down the stream.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { autoVerdict } from "../auto-approve.ts";
import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { redactSecrets } from "../redact.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { EventBus } from "./bus.ts";

const testEvent = (over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({
    eventId: "ev-1",
    provider: "fake",
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    type: "turn.started",
    ...over,
  }) as RuntimeEvent;

async function liveInstance() {
  const fake = makeFakeDriver();
  await fake.driver.create({
    instanceId: "inst-1",
    displayName: undefined,
    environment: {},
    enabled: true,
    config: {},
  });
  return fake.created.get("inst-1")!;
}

describe("EventBus", () => {
  beforeEach(() => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    ensureDirs();
  });

  it("stamps events from an attached adapter with the instanceId", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-1");
  });

  it("drops events claiming a different driver kind (cross-driver invariant)", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ provider: "impostor" }));
    expect(seen).toHaveLength(0);
  });

  it("tees every published event to the per-thread NDJSON log", () => {
    const bus = new EventBus();
    bus.publish(testEvent({ threadId: "log-me" }));

    const logged = readFileSync(join(EVENTS_DIR, "log-me.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("turn.started");
  });

  it("redacts credential-shaped content before writing the NDJSON log", () => {
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const bus = new EventBus();
    bus.publish(testEvent({
      threadId: "redacted-log",
      type: "runtime.error",
      message: `provider returned ${key}`,
    }));

    const logged = readFileSync(join(EVENTS_DIR, "redacted-log.ndjson"), "utf8");
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
  });

  it("lets policy see the raw sensitive path that persist and client copies mask", () => {
    // token=… is credential-shaped, so redactSecrets hides ~/.aws/credentials
    // before sensitive-guard can match it. The provider still runs the original
    // command — policy must decide on that original, not the masked copy.
    const summary = `token=~/.aws/credentials; cat "$token"`;
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.publish(testEvent({
      threadId: "policy-raw",
      type: "request.opened",
      requestType: "permission",
      requestId: "ask-1",
      tool: "Bash",
      summary,
    }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "request.opened", tool: "Bash", summary });
    const opened = seen[0] as RuntimeEvent & { type: "request.opened" };
    const verdict = autoVerdict({ autoApprove: true }, opened.tool, opened.summary);
    expect(verdict.source).toBe("sensitive-guard");
    expect(verdict.approve).toBeNull();

    const logged = readFileSync(join(EVENTS_DIR, "policy-raw.ndjson"), "utf8");
    expect(logged).not.toContain("~/.aws/credentials");
    expect(logged).toContain("«redacted");

    // Same transform broadcast() applies to SSE frames (PR72). Do not undo that.
    const client = redactSecrets({ kind: "runtime", event: seen[0] });
    expect(JSON.stringify(client)).not.toContain("~/.aws/credentials");
    expect(JSON.stringify(client)).toContain("«redacted");
    const clientEvent = (client as { event: { tool: string; summary: string } }).event;
    expect(autoVerdict({ autoApprove: true }, clientEvent.tool, clientEvent.summary).approve).toBe(
      "auto-approved Bash",
    );
  });

  it("keeps PR72 client redaction: persist and SSE-shaped copies hide secrets", () => {
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.publish(testEvent({
      threadId: "redacted-live",
      type: "runtime.error",
      message: `provider returned ${key}`,
    }));

    expect(seen).toHaveLength(1);
    // Policy/subscribers see the original; only persist + client copies mask.
    expect(JSON.stringify(seen[0])).toContain(key);
    const logged = readFileSync(join(EVENTS_DIR, "redacted-live.ndjson"), "utf8");
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
    const client = redactSecrets({ kind: "runtime", event: seen[0] });
    expect(JSON.stringify(client)).not.toContain(key);
    expect(JSON.stringify(client)).toContain("«redacted");
  });

  it("reports an incomplete log once while continuing live delivery", () => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(seen.slice(1).map((event) => event.eventId)).toEqual(["ev-1", "ev-2"]);
    expect(existsSync(EVENTS_DIR)).toBe(false);
  });

  it("writes the incomplete marker before the first event after logging recovers", () => {
    let failing = true;
    const writes: string[] = [];
    const append: typeof appendFileSync = vi.fn((...args: Parameters<typeof appendFileSync>) => {
      if (failing) throw new Error("disk full");
      writes.push(String(args[1]));
    });
    const bus = new EventBus(append);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(testEvent());
    failing = false;
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));
    bus.publish(testEvent({ eventId: "ev-3" }));

    const recovered = writes[0].trim().split("\n").map((line) => JSON.parse(line));
    expect(recovered.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(recovered[0].message).toContain("event history is incomplete");
    expect(writes[1].trim()).toContain('"eventId":"ev-3"');
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("a throwing listener does not starve the others", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
  });

  it("unsubscribe and detachAll stop delivery", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    unsub();
    emit(testEvent());
    expect(seen).toHaveLength(1);

    const seenAfterDetach: RuntimeEvent[] = [];
    bus.subscribe((e) => seenAfterDetach.push(e));
    bus.detachAll();
    emit(testEvent());
    expect(seenAfterDetach).toHaveLength(0);
  });
});
