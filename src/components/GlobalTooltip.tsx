import { useEffect } from "react";
import { mountGlobalTooltips } from "@/lib/tooltips";

/** Mounts the one tip layer for every `title` in the app. */
export function GlobalTooltip() {
  useEffect(() => mountGlobalTooltips(), []);
  return null;
}
