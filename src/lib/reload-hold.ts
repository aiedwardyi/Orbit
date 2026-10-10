let held = 0;
const settled = new Set<() => void>();

/** Keeps the update reload waiting until `work` settles, so a send or upload is not cut off. */
export function holdReload<T>(work: Promise<T>): Promise<T> {
  held += 1;
  const release = () => {
    held -= 1;
    if (held === 0) [...settled].forEach((listener) => listener());
  };
  work.then(release, release);
  return work;
}

export function reloadHeld(): boolean {
  return held > 0;
}

export function onHoldReleased(listener: () => void): () => void {
  settled.add(listener);
  return () => settled.delete(listener);
}
