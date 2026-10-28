export type ErrorCode = "UNKNOWN_ERROR" | "RENDERER_GONE" | "SERVER_GONE" | "STARTUP_TIMEOUT" | "UPDATE_FAILED" | "UPDATE_UNAVAILABLE" | "UNCLEAN_EXIT" | "SERVER_RUNTIME_FAILURE";
export type ErrorReport = {
  schema: 1; build: string; platform: "win32" | "darwin" | "linux"; arch: "x64" | "arm64" | "ia32" | "arm";
  process: "main" | "renderer" | "server"; code: ErrorCode; site: number; exitCode: number;
  count: number; uptimeBucket: number; utcHour: number; reportId: string;
};
export const ERROR_CODES: readonly ErrorCode[];
export const ERROR_SITES: Readonly<{ rendererError: 1; rendererRejection: 2; rendererGone: 3; serverGone: 4; startupTimeout: 5; updaterFailure: 6; updaterUnavailable: 7; uncleanExit: 8; serverRuntime: 9; updaterChannel: 10 }>;
export function validErrorReport(value: unknown): value is ErrorReport;
export function makeErrorReport(input: { process: string; code: unknown; site: number; exitCode?: number }, context: { build: string; platform: string; arch: string; uptime: number; now: number; reportId: string }): ErrorReport | null;
