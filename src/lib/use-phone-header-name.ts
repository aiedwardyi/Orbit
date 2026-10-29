import { useLayoutEffect } from "react";
import { isPhone } from "./phone-swipe";
import { useSkin } from "./skins";
import { boxShadowReach, phoneHeaderChipClearsMenu, phoneHeaderSlots, transformShift, PHONE_HEADER_MENU_RESERVE_PX, PHONE_MENU_GLOW_PX, type PhoneHeaderBox, type PhoneHeaderSlot } from "./phone-header";

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function naturalWidth(el: HTMLElement): number {
  const copy = el.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return 0;
  copy.style.position = "fixed";
  copy.style.left = "-9999px";
  copy.style.width = "max-content";
  copy.style.minWidth = "0px";
  copy.style.maxWidth = "none";
  copy.style.flex = "none";
  copy.style.display = "";
  copy.style.overflow = "visible";
  copy.style.textOverflow = "clip";
  document.body.appendChild(copy);
  const width = copy.getBoundingClientRect().width;
  copy.remove();
  return width;
}

function phoneMenuButton(root: ParentNode): HTMLElement | null {
  const found = root.querySelector("[data-phone-menu]");
  return found instanceof HTMLElement ? found : null;
}

function phoneMenuBounds(menu: HTMLElement): PhoneHeaderBox {
  const rect = menu.getBoundingClientRect();
  let outset = 0;
  if (menu.classList.contains("needs-you-glow")) {
    const reach = boxShadowReach(getComputedStyle(menu, "::after").boxShadow);
    outset = reach > 0 ? reach : PHONE_MENU_GLOW_PX;
  }
  return {
    left: rect.left - outset,
    right: rect.right + outset,
    top: rect.top - outset,
    bottom: rect.bottom + outset,
  };
}

// Compare the chip and menu before their switch animations.
function stageShift(header: HTMLElement, menu: HTMLElement) {
  let x = 0;
  let y = 0;
  for (let el: HTMLElement | null = header; el && !el.contains(menu); el = el.parentElement) {
    const shift = transformShift(getComputedStyle(el).transform);
    x += shift.x;
    y += shift.y;
  }
  for (let el: HTMLElement | null = menu; el && !el.contains(header); el = el.parentElement) {
    const shift = transformShift(getComputedStyle(el).transform);
    x -= shift.x;
    y -= shift.y;
  }
  return { x, y };
}

// Chromium drops min() around max-content, so the phone name floor is applied in px.
export function usePhoneHeaderNameFloor(
  clusterRef: { current: HTMLDivElement | null },
  nameRef: { current: HTMLButtonElement | null },
  name: string,
  menuOnRight: boolean,
) {
  const skin = useSkin();
  useLayoutEffect(() => {
    const cluster = clusterRef.current;
    const button = nameRef.current;
    const header = cluster?.parentElement;
    if (!cluster || !button || !header) return;
    const nameSlot = button.closest("[data-chat-name]") ?? button;
    let alive = true;
    let text = naturalWidth(button);
    let rem = px(getComputedStyle(document.documentElement).fontSize) || 16;
    const chipOf = () => {
      const label = header.querySelector("[data-model-label]");
      const effort = header.querySelector("[data-model-effort]");
      const chip = (label instanceof HTMLElement ? label.closest("button") : null)
        ?? (effort instanceof HTMLElement ? effort.closest("button") : null);
      return {
        label: label instanceof HTMLElement ? label : null,
        effort: effort instanceof HTMLElement ? effort : null,
        chip,
      };
    };
    const clearChip = () => {
      const { label, effort, chip } = chipOf();
      if (label) {
        label.style.display = "";
        label.style.flexShrink = "";
        label.style.minWidth = "";
        label.style.maxWidth = "";
        label.style.overflow = "";
        label.style.textOverflow = "";
        label.style.whiteSpace = "";
      }
      if (effort) effort.style.display = "";
      if (chip) {
        chip.style.flexShrink = "";
        chip.style.minWidth = "";
        chip.style.maxWidth = "";
      }
    };
    const apply = () => {
      if (!alive) return;
      if (!isPhone()) {
        button.style.minWidth = "";
        cluster.style.minWidth = "";
        cluster.style.flex = "";
        header.style.paddingRight = "";
        clearChip();
        return;
      }
      header.style.paddingRight = menuOnRight ? `${PHONE_HEADER_MENU_RESERVE_PX}px` : "";
      const statusWidth = cluster.querySelector<HTMLElement>("[data-worker-status]")?.scrollWidth ?? 0;
      const slots = phoneHeaderSlots(Math.max(text, statusWidth), Math.max(4 * rem, statusWidth));
      const place = (nameMin: number) => {
        const cs = getComputedStyle(cluster);
        const pad = px(cs.paddingLeft) + px(cs.paddingRight);
        const gap = px(cs.columnGap);
        let fixed = 0;
        let others = 0;
        for (const child of cluster.children) {
          if (!(child instanceof HTMLElement) || child === nameSlot || getComputedStyle(child).display === "none") continue;
          fixed += child.getBoundingClientRect().width;
          others += 1;
        }
        const min = `${Math.ceil(pad + fixed + gap * others + nameMin)}px`;
        const nameMinPx = `${nameMin}px`;
        if (button.style.minWidth !== nameMinPx) button.style.minWidth = nameMinPx;
        if (cluster.style.flex !== "0 1000 auto") cluster.style.flex = "0 1000 auto";
        if (cluster.style.minWidth !== min) cluster.style.minWidth = min;
      };
      const paint = (slot: PhoneHeaderSlot) => {
        const { label, effort, chip } = chipOf();
        if (effort) effort.style.display = slot.showEffort ? "" : "none";
        if (label) {
          if (slot.showLabel) {
            label.style.display = "";
            label.style.flexShrink = "0";
            label.style.minWidth = "max-content";
            label.style.maxWidth = "none";
            label.style.overflow = "hidden";
            label.style.textOverflow = "clip";
            label.style.whiteSpace = "nowrap";
          } else {
            label.style.display = "none";
          }
        }
        if (chip) {
          if (slot.showLabel) {
            chip.style.flexShrink = "0";
            chip.style.minWidth = "max-content";
            chip.style.maxWidth = "none";
          } else {
            chip.style.flexShrink = "";
            chip.style.minWidth = "";
            chip.style.maxWidth = "";
          }
        }
        place(slot.nameMin);
      };
      const fits = (slot: PhoneHeaderSlot) => {
        const { label, effort, chip } = chipOf();
        const limit = header.getBoundingClientRect().right - px(getComputedStyle(header).paddingRight);
        if (slot.showLabel && label) {
          const rect = label.getBoundingClientRect();
          if (rect.width < 1 || rect.right > limit + 0.5) return false;
          if (label.scrollWidth > label.clientWidth + 1) return false;
        }
        if (slot.showEffort && effort) {
          const rect = effort.getBoundingClientRect();
          if (rect.right > limit + 0.5) return false;
          if (effort.scrollWidth > effort.clientWidth + 1) return false;
        }
        if (button.getBoundingClientRect().width + 1 < slot.nameMin) return false;
        if (slot.nameMin >= text - 0.5 && button.scrollWidth > button.clientWidth + 1) return false;
        const device = cluster.querySelector("[data-device-tag]");
        const term = header.querySelector("[data-chat-terminal]");
        if (device instanceof HTMLElement && term instanceof HTMLElement) {
          const a = device.getBoundingClientRect();
          const b = term.getBoundingClientRect();
          if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) return false;
        }
        const controls = header.lastElementChild !== cluster ? header.lastElementChild : null;
        const edge = chip ?? controls;
        if (edge instanceof HTMLElement) {
          const rect = edge.getBoundingClientRect();
          if (rect.width >= 1 && rect.left < cluster.getBoundingClientRect().right - 1) return false;
        }
        const logo = chip?.querySelector("svg");
        if (logo) {
          const rect = logo.getBoundingClientRect();
          if (rect.width < 12 || rect.right > limit + 0.5) return false;
        }
        const dot = chip?.querySelector("span.rounded-full");
        if (dot) {
          const rect = dot.getBoundingClientRect();
          if (rect.width < 5 || rect.right > limit + 0.5) return false;
        }
        const menu = phoneMenuButton(header.ownerDocument);
        if (menu && chip) {
          const chipRect = chip.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          const shift = stageShift(header, menu);
          const chipBox = { left: chipRect.left - shift.x, right: chipRect.right - shift.x, top: chipRect.top - shift.y, bottom: chipRect.bottom - shift.y };
          if (chipRect.width >= 1 && menuRect.width >= 1 && !phoneHeaderChipClearsMenu(chipBox, phoneMenuBounds(menu))) return false;
        }
        return true;
      };
      const last = slots.at(-1);
      if (!last) return;
      let chosen = last;
      for (const slot of slots) {
        paint(slot);
        if (fits(slot)) {
          chosen = slot;
          break;
        }
      }
      paint(chosen);
    };
    const kick = () => {
      apply();
      requestAnimationFrame(() => {
        if (alive) apply();
      });
    };
    kick();
    const mutations = new MutationObserver(kick);
    mutations.observe(header, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", kick);
    void document.fonts?.ready.then(() => {
      if (!alive) return;
      text = naturalWidth(button);
      rem = px(getComputedStyle(document.documentElement).fontSize) || 16;
      kick();
    });
    return () => {
      alive = false;
      mutations.disconnect();
      window.removeEventListener("resize", kick);
      button.style.minWidth = "";
      button.style.width = "";
      cluster.style.minWidth = "";
      cluster.style.flex = "";
      header.style.paddingRight = "";
      clearChip();
    };
  }, [clusterRef, nameRef, name, skin, menuOnRight]);
}
