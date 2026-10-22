/** Sets `data-orbit-idle` on blur or while the document is hidden. */
export function startIdleMotion(root: HTMLElement = document.documentElement): () => void {
  // blur can fire before hasFocus() flips, so the flag follows the event.
  let blurred = document.hasFocus() === false;

  const apply = () => {
    if (document.visibilityState !== "visible") root.setAttribute("data-orbit-idle", "hidden");
    else if (blurred) root.setAttribute("data-orbit-idle", "blur");
    else root.removeAttribute("data-orbit-idle");
  };

  const onBlur = () => {
    blurred = true;
    apply();
  };
  const onFocus = () => {
    blurred = false;
    apply();
  };
  const onVisibility = () => {
    blurred = document.hasFocus() === false;
    apply();
  };

  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  apply();

  return () => {
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    root.removeAttribute("data-orbit-idle");
  };
}
