import "./ProfileFields.test-dom.ts";
import { act, createElement, createRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { BotAvatar, MausAvatar, type MausAvatarHandle } from "./Avatar";
import { BotPickerList } from "./BotPickerList";

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

  it("parks idle eye CSS when animated is false or motion is none", async () => {
    const { host } = await renderInto(
      createElement(
        "div",
        null,
        createElement(MausAvatar, { color: "red", mascotStyle: "peach", size: 44, label: "Live" }),
        createElement(MausAvatar, {
          color: "red",
          mascotStyle: "peach",
          size: 44,
          label: "Still",
          animated: false,
        }),
        createElement(MausAvatar, {
          color: "teal",
          mascotStyle: "teal",
          size: 32,
          label: "None",
          motion: "none",
        }),
      ),
    );

    const avatars = [...host.querySelectorAll(".mascot-avatar")];
    expect(avatars).toHaveLength(3);
    expect(avatars[0]!.className).not.toContain("mascot-avatar--still");
    expect(avatars[1]!.classList.contains("mascot-avatar--still")).toBe(true);
    expect(avatars[2]!.classList.contains("mascot-avatar--still")).toBe(true);
    expect(host.querySelectorAll(".mascot-idle .mascot-blink").length).toBe(3);
  });

  it("moves the eyes out of the SVG onto HTML spans", async () => {
    const { host } = await renderInto(
      createElement(MausAvatar, { color: "red", mascotStyle: "peach", size: 44, label: "Peach" }),
    );

    const idle = host.querySelector(".mascot-idle");
    expect(idle?.tagName).toBe("SPAN");
    expect(idle?.closest("svg")).toBeNull();
    expect(idle?.querySelectorAll(".mascot-blink svg circle")).toHaveLength(6);
    expect(host.querySelector(".mascot-avatar > svg.mascot-top")).toBeTruthy();
    expect(host.querySelectorAll("[role=img], [aria-label]")).toHaveLength(1);
  });

  it("renders fixed pack artwork without mascot recoloring", async () => {
    const { host } = await renderInto(
      createElement(BotAvatar, {
        bot: { name: "Peach", color: "red", mascotStyle: "icon-11" },
        size: 48,
        label: "Peach",
      }),
    );

    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/avatars/icon-11-peach-warm.png");
    expect(image?.getAttribute("alt")).toBe("Peach");
    expect(host.querySelector(".mascot-avatar")).toBeNull();
  });

  it.each([
    ["icon-31", "icon-31-wink.png"],
    ["icon-32", "icon-32-wink-light.png"],
    ["icon-33", "icon-33-wink-mint.png"],
    ["icon-34", "icon-34-wink-peach.png"],
    ["icon-35", "icon-35-wink-lavender.png"],
    ["icon-36", "icon-36-wink-calm.png"],
  ])("renders %s as its chosen artwork in a picker list row", async (mascotStyle, asset) => {
    const { host, root } = await renderInto(createElement(BotPickerList, {
      bots: [{ id: "atlas", name: "Atlas", color: "white", mascotStyle } as Bot],
      picked: new Set<string>(),
      onToggle: () => {},
      emptyHint: "No bots",
    }));
    try {
      const image = host.querySelector('[role="checkbox"] img');
      expect(image?.getAttribute("src")).toBe(`/avatars/${asset}`);
      expect(image?.getAttribute("alt")).toBe("Atlas avatar");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("clears a forced blink class if animationend never fires", async () => {
    const handle = createRef<MausAvatarHandle>();
    const { host } = await renderInto(
      createElement(MausAvatar, { ref: handle, color: "red", mascotStyle: "peach", size: 44, label: "Peach" }),
    );

    await act(async () => {
      handle.current?.blink();
    });
    expect(host.querySelector(".mascot-avatar--nudge")).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 230));
    });
    expect(host.querySelector(".mascot-avatar--nudge")).toBeNull();
  });
});
