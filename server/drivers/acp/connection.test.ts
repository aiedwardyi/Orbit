import { describe, expect, it } from "vitest";
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
});
