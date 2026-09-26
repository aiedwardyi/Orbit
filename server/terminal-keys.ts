export const TERMINAL_KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" } as const;
export type TerminalKey = keyof typeof TERMINAL_KEYS;
