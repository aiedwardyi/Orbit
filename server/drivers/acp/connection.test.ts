import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { acpConnection } from "./connection.ts";

function fakeChild() {
  const stdin = new EventEmitter() as EventEmitter & {
    write: (chunk: string) => boolean;
  };
  const written: string[] = [];
  stdin.write = (chunk: string) => {
    written.push(chunk);
    return true;
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
  stdout.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & {
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: EventEmitter;
    killed: boolean;
    exitCode: number | null;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  return { child, written, stdin };
}

describe("acpConnection", () => {
  it("rejects pending RPCs when stdin errors asynchronously", async () => {
    const { child, stdin } = fakeChild();
    const connection = acpConnection(child as any, () => {});
    const pending = connection.request("initialize", {});
    stdin.emit("error", new Error("EPIPE"));
    await expect(pending).rejects.toThrow(/EPIPE|process closed/);
    expect(connection.healthy).toBe(false);
  });

  it("rejects a new request after the transport has failed", async () => {
    const { child } = fakeChild();
    const connection = acpConnection(child as any, () => {});
    child.emit("error", new Error("spawn failed"));
    await expect(connection.request("initialize", {})).rejects.toThrow(/process closed|spawn failed/);
  });

  it("does not re-fire onError after close then stdin error", async () => {
    const { child, stdin } = fakeChild();
    const connection = acpConnection(child as any, () => {});
    let errors = 0;
    connection.onError = () => {
      errors += 1;
    };
    child.emit("close", 0);
    expect(connection.healthy).toBe(false);
    stdin.emit("error", new Error("EPIPE"));
    expect(errors).toBe(0);
    await expect(connection.request("initialize", {})).rejects.toThrow(/process closed/);
  });

  it("routes synchronous and asynchronous handler failures through onError", async () => {
    const sync = fakeChild();
    const syncConnection = acpConnection(sync.child as any, () => {});
    const syncError = vi.fn();
    syncConnection.onError = syncError;
    syncConnection.onRequest = () => { throw new Error("request handler failed"); };
    sync.child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/request" })}\n`);
    expect(syncError).toHaveBeenCalledWith(expect.objectContaining({ message: "request handler failed" }));
    expect(syncConnection.healthy).toBe(false);

    const async = fakeChild();
    const asyncConnection = acpConnection(async.child as any, () => {});
    const asyncError = vi.fn();
    asyncConnection.onError = asyncError;
    asyncConnection.onNotification = async () => { throw new Error("notification handler failed"); };
    async.child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", method: "session/update" })}\n`);
    await Promise.resolve();
    expect(asyncError).toHaveBeenCalledWith(expect.objectContaining({ message: "notification handler failed" }));
    expect(asyncConnection.healthy).toBe(false);
  });
});
