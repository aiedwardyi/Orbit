import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const markup = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "OrbitMark.tsx"), "utf8");
const lower = markup.toLowerCase();

describe("OrbitMark", () => {
  it("renders the new slate/cream/green artwork", () => {
    expect(lower).toContain("#303446");
    expect(lower).toContain("#a6d189");
  });

  it("keeps the two-dot face with no mouth", () => {
    expect(markup.match(/<circle[^>]*fill="#2b2e36"/g)?.length).toBe(2);
    expect(lower).not.toContain("smile");
  });

  it("drops the old spectrum-ring artwork", () => {
    expect(markup).not.toContain("orbit-spectrum");
    expect(markup).not.toContain("orbit-core");
    expect(lower).not.toContain("#1688ff");
    expect(lower).not.toContain("#f45aa8");
  });
});
