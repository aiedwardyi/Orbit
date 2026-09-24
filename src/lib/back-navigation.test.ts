import { describe, expect, it, vi } from "vitest";

import { BackNavigation, backDepth, followSelection, trailTarget } from "./back-navigation";

// session history: go() lands later, as a browser popstate does
function fakeHistory() {
  const entries: unknown[] = [null];
  const landed: unknown[] = [];
  const history = {
    index: 0,
    entries,
    get state() {
      return entries[history.index];
    },
    pushState: (state: unknown) => {
      entries.splice(history.index + 1);
      entries.push(state);
      history.index++;
    },
    go: (delta: number) => {
      history.index += delta;
      landed.push(entries[history.index]);
    },
    deliver: (navigation: BackNavigation) => {
      while (landed.length) navigation.pop(backDepth(landed.shift()));
    },
  };
  return history;
}

describe("BackNavigation", () => {
  it("pushes on open and consumes the marker when UI closes", () => {
    const history = { pushState: vi.fn(), go: vi.fn() };
    const navigation = new BackNavigation(history);
    const close = vi.fn();

    navigation.sync([{ key: "settings", close }]);
    expect(history.pushState).toHaveBeenCalledOnce();

    navigation.sync([]);
    expect(history.go).toHaveBeenCalledWith(-1);
    navigation.pop();
    expect(close).not.toHaveBeenCalled();

    navigation.pop();
    expect(close).not.toHaveBeenCalled();
  });

  it("closes only the top layer on browser Back", () => {
    const history = { pushState: vi.fn(), go: vi.fn() };
    const navigation = new BackNavigation(history);
    const closeChat = vi.fn();
    const closeModal = vi.fn();

    navigation.sync([{ key: "chat:second", close: closeChat }, { key: "settings", close: closeModal }]);
    expect(history.pushState).toHaveBeenCalledTimes(2);
    navigation.pop();
    expect(closeModal).toHaveBeenCalledOnce();
    expect(closeChat).not.toHaveBeenCalled();
    navigation.sync([{ key: "chat:second", close: closeChat }]);
    navigation.pop();
    expect(closeChat).toHaveBeenCalledOnce();
    navigation.sync([]);
    navigation.pop();
    expect(history.go).not.toHaveBeenCalled();
  });

  it("replaces a closed drawer with a newly selected chat", () => {
    const history = { pushState: vi.fn(), go: vi.fn() };
    const navigation = new BackNavigation(history);
    const close = vi.fn();

    navigation.sync([{ key: "drawer", close }]);
    navigation.sync([{ key: "chat:second", close }]);
    expect(history.go).toHaveBeenCalledWith(-1);
    navigation.pop();
    expect(history.pushState).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });

  it("unwinds entries a reload left behind", () => {
    const history = fakeHistory();
    new BackNavigation(history).sync([{ key: "settings", close: vi.fn() }]);
    expect(history.index).toBe(1);

    for (let reload = 0; reload < 2; reload++) {
      const navigation = new BackNavigation(history);
      navigation.sync([]);
      history.deliver(navigation);
      expect(history.index).toBe(0);
      const close = vi.fn();
      navigation.sync([{ key: "settings", close }]);
      expect(history.entries).toHaveLength(2);
      history.go(-1);
      history.deliver(navigation);
      expect(close).toHaveBeenCalledOnce();
      navigation.sync([]);
      navigation.sync([{ key: "settings", close }]);
      expect(history.index).toBe(1);
    }
  });

  it("undoes a forward step instead of treating it as Back", () => {
    const history = fakeHistory();
    const navigation = new BackNavigation(history);
    const closeChat = vi.fn();
    const closeSettings = vi.fn();
    navigation.sync([{ key: "chat:second", close: closeChat }, { key: "settings", close: closeSettings }]);
    history.go(-1);
    history.deliver(navigation);
    expect(closeSettings).toHaveBeenCalledOnce();
    navigation.sync([{ key: "chat:second", close: closeChat }]);

    history.go(1);
    history.deliver(navigation);
    expect(history.index).toBe(1);
    expect(closeChat).not.toHaveBeenCalled();
    history.go(-1);
    history.deliver(navigation);
    expect(closeChat).toHaveBeenCalledOnce();
  });

  it("drops deleted chats from the selection trail", () => {
    const live = new Set(["root", "a", "b", "c"]);
    const exists = (id: string) => live.has(id);
    const trail: string[] = [];
    for (const id of ["a", "b", "c"]) followSelection(trail, "root", id, exists);
    expect(trail).toEqual(["root", "a", "b", "c"]);

    live.delete("b");
    expect(trailTarget(trail, 2, exists)).toBe("a");
    followSelection(trail, "root", "c", exists);
    expect(trail).toEqual(["root", "a", "c"]);
    followSelection(trail, "root", "a", exists);
    expect(trail).toEqual(["root", "a"]);
  });
});
