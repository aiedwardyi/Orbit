export const UTILITY_SHUTDOWN_TYPE = "openmausbot:shutdown";

export function isUtilityShutdownMessage(message: unknown): boolean {
  return Boolean(
    message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { type?: unknown }).type === UTILITY_SHUTDOWN_TYPE,
  );
}
