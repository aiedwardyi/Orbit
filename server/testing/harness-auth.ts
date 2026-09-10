import { spawn, type SpawnOptions } from "node:child_process";
import { z } from "zod";

const tokens = new Map<string, Promise<string>>();

export async function harnessToken(origin: string): Promise<string> {
  return await tokens.get(origin) ?? "";
}

export function spawnHarness(command: string, args: string[], options: SpawnOptions) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const origin = `http://127.0.0.1:${options.env?.OMB_PORT ?? options.env?.OGB_PORT ?? 8799}`;
  const token = new Promise<string>((resolve) => {
    child.on("message", (message) => {
      const value = z.object({ type: z.literal("orbit:api-token"), token: z.string() }).safeParse(message);
      if (value.success) resolve(value.data.token);
    });
    child.once("exit", () => resolve(""));
  });
  tokens.set(origin, token);
  child.once("exit", () => {
    if (tokens.get(origin) === token) tokens.delete(origin);
  });
  return child;
}

export const harnessFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const token = tokens.get(url.origin);
  // comms.test.ts intentionally checks unauthenticated internal requests.
  if (!token || !url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/internal/") || url.pathname === "/api/health") {
    return fetch(input, init);
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${await token}`);
  return fetch(input, { ...init, headers, redirect: "error" });
};
