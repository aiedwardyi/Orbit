import "./ProfileFields.test-dom.ts";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { BotAvatar, MausAvatar } from "./Avatar";

async function renderInto(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { host, root };
}

describe("mascot idle motion mount", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("inlines scoped SVG eyes so two peach mascots cannot share a gradient id", async () => {
    const { host } = await renderInto(
      createElement(
        "div",
        null,
        createElement(MausAvatar, { color: "red", mascotStyle: "peach", size: 44, label: "Peach" }),
        createElement(BotAvatar, {
          bot: { name: "Teal", color: "teal", mascotStyle: "teal" },
          size: 32,
        }),
      ),
    );

    const avatars = host.querySelectorAll(".mascot-avatar");
    expect(avatars.length).toBe(2);
    expect(host.querySelectorAll("img")).toHaveLength(0);

    const svgs = [...avatars].map((node) => node.querySelector("svg"));
    expect(svgs.every(Boolean)).toBe(true);
    expect(host.querySelectorAll(".mascot-idle .mascot-blink").length).toBe(2);

    const ids = svgs.flatMap((svg) => [...(svg?.querySelectorAll("[id]") ?? [])].map((el) => el.id));
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes("peach-body"))).toBe(true);
    expect(ids.some((id) => id.includes("teal-body"))).toBe(true);
  });
});
