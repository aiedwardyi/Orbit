// A lazy view that still fails after lazyView's reload shows a Reload button
// in its own spot; without this boundary React unmounts the whole app.
import { Component, Suspense, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

function ViewFailed({ overlay }: { overlay: boolean }) {
  const { t } = useI18n();
  const reload = (
    <button
      type="button"
      onClick={() => location.reload()}
      className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink"
    >
      {t("chrome.reload")}
    </button>
  );
  if (overlay) {
    return (
      <div
        role="alert"
        className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-full border border-hairline/50 bg-card py-1.5 pl-4 pr-1.5 text-[13px] text-ink shadow-xl"
      >
        {t("chrome.viewFailed")}
        {reload}
      </div>
    );
  }
  return (
    <main role="alert" className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
      <div className="text-[14px]">{t("chrome.viewFailed")}</div>
      {reload}
    </main>
  );
}

class ViewBoundary extends Component<{ children: ReactNode; overlay: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <ViewFailed overlay={this.props.overlay} /> : this.props.children;
  }
}

/** Suspense for a lazyView. `overlay` views (modals, panels) fail as a small floating card. */
export function LazyView({ fallback = null, overlay = false, children }: { fallback?: ReactNode; overlay?: boolean; children: ReactNode }) {
  return (
    <ViewBoundary overlay={overlay}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ViewBoundary>
  );
}
