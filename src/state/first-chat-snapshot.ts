/** Peripherals that may ride the first chat snapshot. Engine describe
 * (`instances`) walks PATH and CLI `--version`; keep it off composer paint. */
export const FIRST_CHAT_PERIPHERAL_KEYS = ["config", "routines", "webhooks"] as const;
export const DEFERRED_INSTANCE_IDLE_MS = 800;

export function isFirstChatPeripheral(key: string): boolean {
  return (FIRST_CHAT_PERIPHERAL_KEYS as readonly string[]).includes(key);
}

export function firstChatPeripherals<T extends { key: string }>(parts: readonly T[]): T[] {
  return parts.filter((part) => isFirstChatPeripheral(part.key));
}

export type IdleScheduleHost = {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
};

export function scheduleDeferredInstancesLoad(
  wake: () => void,
  host: IdleScheduleHost = globalThis as unknown as IdleScheduleHost,
): () => void {
  const requestIdle = host.requestIdleCallback;
  if (requestIdle) {
    const id = requestIdle(wake, { timeout: DEFERRED_INSTANCE_IDLE_MS });
    return () => host.cancelIdleCallback?.(id);
  }
  const timer = (host.setTimeout ?? setTimeout)(wake, DEFERRED_INSTANCE_IDLE_MS);
  return () => (host.clearTimeout ?? clearTimeout)(timer as ReturnType<typeof setTimeout>);
}
