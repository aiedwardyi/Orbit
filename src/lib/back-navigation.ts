export type BackLayer = { key: string; close: () => void };

export class BackNavigation {
  private layers: BackLayer[] = [];
  private pending: BackLayer[] | null = null;
  private retreat = 0;

  constructor(private history: Pick<History, "go" | "pushState">) {}

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
      this.history.pushState({ orbitBack: layer.key }, "");
      this.layers.push(layer);
    }
  }

  pop() {
    if (this.pending) {
      this.layers.splice(-this.retreat);
      const next = this.pending;
      this.pending = null;
      this.retreat = 0;
      this.sync(next);
      return;
    }
    this.layers.pop()?.close();
  }
}
