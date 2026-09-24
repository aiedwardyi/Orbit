export type BackLayer = { key: string; close: () => void };

export function backDepth(state: unknown): number {
  const depth = (state as { depth?: unknown } | null)?.depth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
}

export class BackNavigation {
  private layers: BackLayer[] = [];
  private pending: BackLayer[] | null = null;
  private retreat = 0;

  constructor(private history: Pick<History, "go" | "pushState"> & { state?: unknown }) {
    // a reload keeps our entries but not the layers they stood for
    const depth = backDepth(history.state);
    if (depth > 0) {
      this.pending = [];
      history.go(-depth);
    }
  }

  sync(next: BackLayer[]) {
    if (this.pending) {
      this.pending = next;
      return;
    }
    let common = 0;
    while (common < this.layers.length && common < next.length && this.layers[common].key === next[common].key) common++;
    this.layers.splice(0, common, ...next.slice(0, common));
    if (common < this.layers.length) {
      this.retreat = this.layers.length - common;
      this.pending = next;
      this.history.go(-this.retreat);
      return;
    }
    for (const layer of next.slice(common)) {
      this.layers.push(layer);
      this.history.pushState({ orbitBack: layer.key, depth: this.layers.length }, "");
    }
  }

  pop(depth = Math.max(this.layers.length - 1, 0)) {
    if (this.pending) {
      this.layers.splice(this.layers.length - this.retreat);
      const next = this.pending;
      this.pending = null;
      this.retreat = 0;
      this.sync(next);
      return;
    }
    if (depth > this.layers.length) {
      // Forward into an entry whose layer already closed
      this.pending = this.layers.slice();
      this.history.go(this.layers.length - depth);
      return;
    }
    while (this.layers.length > depth) this.layers.pop()?.close();
  }
}

/** Moves the chat trail to `selectedId`, forgetting ids deleted since. */
export function followSelection(trail: string[], root: string, selectedId: string, exists: (id: string) => boolean) {
  const kept = trail.filter(exists);
  trail.splice(0, trail.length, ...(kept.length ? kept : [root]));
  if (!selectedId || trail.at(-1) === selectedId) return;
  const previous = trail.indexOf(selectedId);
  if (previous >= 0) trail.splice(previous + 1);
  else trail.push(selectedId);
}

/** Nearest id at or before `index` that still exists. */
export function trailTarget(trail: string[], index: number, exists: (id: string) => boolean): string | undefined {
  for (let at = index; at >= 0; at--) if (exists(trail[at])) return trail[at];
  return undefined;
}
