import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function syncRoots(folder: string, name: "threads-v2" | "memory-v2"): string[] {
  if (!existsSync(folder)) return [];
  const pattern = new RegExp(`^${name}(?: \\([1-9]\\d*\\))?$`);
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name).sort((a, b) => copy(a) - copy(b)).map((entry) => join(folder, entry));
}

const copy = (name: string) => Number(/\((\d+)\)$/.exec(name)?.[1] ?? 0);

export function syncWriteRoot(folder: string, name: "threads-v2" | "memory-v2", ownerPath: string): string {
  const roots = syncRoots(folder, name);
  return roots.find((root) => existsSync(join(root, ownerPath))) ?? join(folder, name);
}
