import { ERROR_SITES } from "../../shared/error-report.mjs";

export function installRendererErrorReports(target: Window = window) {
  target.addEventListener("error", (event) => { if (event.error) target.ogb?.captureErrorReport?.(ERROR_SITES.rendererError); });
  target.addEventListener("unhandledrejection", () => target.ogb?.captureErrorReport?.(ERROR_SITES.rendererRejection));
}
