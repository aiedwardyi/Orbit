// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { installRendererErrorReports } from "./error-reports";

it("skips renderer notices without an Error object", () => {
  const captureErrorReport = vi.fn();
  const target = new EventTarget() as Window;
  Object.assign(target, { ogb: { captureErrorReport } });
  installRendererErrorReports(target);
  target.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  expect(captureErrorReport).not.toHaveBeenCalled();
});

it("forwards only compiled numeric sites for error and rejection events", () => {
  const captureErrorReport = vi.fn();
  const target = new EventTarget() as Window;
  Object.assign(target, { ogb: { captureErrorReport } });
  installRendererErrorReports(target);
  target.dispatchEvent(new ErrorEvent("error", { message: "secret-token C:\\사용자\\민수\\비밀.txt", filename: "/home/minsu/secret", error: new Error("비밀 대화") }));
  target.dispatchEvent(new Event("unhandledrejection"));
  expect(captureErrorReport.mock.calls).toEqual([[1], [2]]);
});
