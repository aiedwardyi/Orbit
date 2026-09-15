import { describe, expect, it } from "vitest";

import { uuidv7 } from "./protocol.ts";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("emits 36-char version-7 ids the host accepts", () => {
    for (let i = 0; i < 50; i++) expect(uuidv7()).toMatch(V7);
    expect(new Set(Array.from({ length: 50 }, () => uuidv7())).size).toBe(50);
  });

  it("orders by time", () => {
    expect(uuidv7(1000, () => 0) < uuidv7(2000, () => 0)).toBe(true);
  });
});
