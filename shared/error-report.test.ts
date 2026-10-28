import { expect, it } from "vitest";
import { ERROR_CODES, ERROR_SITES, makeErrorReport, validErrorReport } from "./error-report.mjs";

const context = { build: "1.0.212", platform: "win32", arch: "x64", uptime: 100, now: Date.UTC(2026, 9, 28), reportId: "a".repeat(32) };

it("reconstructs a payload without accepting producer metadata", () => {
  const report = makeErrorReport({ process: "server", code: "secret error", site: ERROR_SITES.serverRuntime }, context)!;
  expect(Object.keys(report)).toEqual(["schema", "build", "platform", "arch", "process", "code", "site", "exitCode", "count", "uptimeBucket", "utcHour", "reportId"]);
  expect(report.code).toBe("UNKNOWN_ERROR");
  expect(validErrorReport({ ...report, message: "비밀" })).toBe(false);
  for (const code of ERROR_CODES) expect(validErrorReport({ ...report, code })).toBe(true);
});

it.each([
  { build: "C:\\사용자\\민수\\비밀.txt" }, { platform: "secret" }, { arch: "secret" }, { reportId: "secret" },
])("rejects untrusted context %j", (patch) => {
  expect(makeErrorReport({ process: "main", code: "UNKNOWN_ERROR", site: 1 }, { ...context, ...patch })).toBeNull();
});

it("rejects invalid sites, processes and numeric bounds", () => {
  expect(makeErrorReport({ process: "main", code: "UNKNOWN_ERROR", site: 999 }, context)).toBeNull();
  expect(makeErrorReport({ process: "/home/minsu", code: "UNKNOWN_ERROR", site: 1 }, context)).toBeNull();
  const report = makeErrorReport({ process: "main", code: "UNKNOWN_ERROR", site: 1 }, context)!;
  for (const patch of [{ count: 0 }, { count: 10001 }, { exitCode: 2 ** 32 }, { uptimeBucket: 4 }, { utcHour: 1.5 }, { code: "secret" }]) expect(validErrorReport({ ...report, ...patch })).toBe(false);
});
