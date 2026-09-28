// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUCK_WARNING_MS, stuckWarningMinutes, useStuckWarning } from "./stuck-warning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("stuckWarningMinutes", () => {
  it("stays quiet just under five minutes", () => {
    expect(stuckWarningMinutes(STUCK_WARNING_MS - 1000)).toBeNull();
  });

  it("warns at five minutes and keeps counting up", () => {
    expect(stuckWarningMinutes(STUCK_WARNING_MS)).toBe(5);
    expect(stuckWarningMinutes(7 * 60_000)).toBe(7);
  });
});

describe("useStuckWarning", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let latest: number | null = null;

  function Harness({ running, eventKey }: { running: boolean; eventKey: string }) {
    latest = useStuckWarning(running, eventKey);
    return null;
  }

  function render(running: boolean, eventKey: string) {
    act(() => {
      root.render(createElement(Harness, { running, eventKey }));
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("shows nothing at 4:59 and the warning at 5:00, counting up from there", () => {
    render(true, "turn-1");
    act(() => vi.advanceTimersByTime(4 * 60_000 + 59_000));
    expect(latest).toBeNull();

    act(() => vi.advanceTimersByTime(1000));
    expect(latest).toBe(5);

    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(latest).toBe(7);
  });

  it("clears instantly when a new event arrives", () => {
    render(true, "turn-1");
    act(() => vi.advanceTimersByTime(6 * 60_000));
    expect(latest).toBe(6);

    render(true, "turn-1:new-token");
    expect(latest).toBeNull();
  });

  it("clears instantly when the turn ends", () => {
    render(true, "turn-1");
    act(() => vi.advanceTimersByTime(6 * 60_000));
    expect(latest).toBe(6);

    render(false, "turn-1");
    expect(latest).toBeNull();
  });

  it("starts a fresh clock for the next turn instead of reusing the old one", () => {
    render(true, "turn-1");
    act(() => vi.advanceTimersByTime(6 * 60_000));
    expect(latest).toBe(6);

    render(false, "turn-1");
    render(true, "turn-2");
    act(() => vi.advanceTimersByTime(4 * 60_000 + 59_000));
    expect(latest).toBeNull();
  });

  it("never re-renders while quiet, and renders about once a minute once due, not once a second", () => {
    let renders = 0;
    function CountingHarness({ running, eventKey }: { running: boolean; eventKey: string }) {
      renders += 1;
      latest = useStuckWarning(running, eventKey);
      return null;
    }
    act(() => {
      root.render(createElement(CountingHarness, { running: true, eventKey: "turn-1" }));
    });
    const mountRenders = renders;

    act(() => vi.advanceTimersByTime(4 * 60_000 + 59_000));
    expect(renders).toBe(mountRenders); // no per-second re-render while quiet
    expect(latest).toBeNull();

    act(() => vi.advanceTimersByTime(1000));
    expect(renders).toBe(mountRenders + 1); // exactly one render when the warning becomes due
    expect(latest).toBe(5);

    // Five more one-minute boundaries, each advanced separately - a per-second
    // tick would have rendered up to 300 times over this stretch instead of 5.
    for (let minute = 6; minute <= 10; minute++) {
      act(() => vi.advanceTimersByTime(60_000));
    }
    expect(renders).toBe(mountRenders + 6);
    expect(latest).toBe(10);
  });
});
