import { describe, expect, it, vi } from "vitest";

import { BackNavigation } from "./back-navigation";

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
});
