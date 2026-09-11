import "../components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MASCOT_MOTION_MS, useMascotMotionExpiry, type Action } from "./store";

function Probe({ nonce, dispatch }: { nonce: number | undefined; dispatch: (action: Action) => void }) {
  useMascotMotionExpiry(nonce, dispatch);
  return null;
}

describe("mascot motion expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("ends only the latest motion after its beat", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(Probe, { nonce: 1, dispatch })));
    await act(async () => vi.advanceTimersByTime(MASCOT_MOTION_MS - 1));
    await act(async () => root.render(createElement(Probe, { nonce: 2, dispatch })));
    await act(async () => vi.advanceTimersByTime(MASCOT_MOTION_MS - 1));
    expect(dispatch).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "mascotMotionDone", nonce: 2 });

    await act(async () => root.render(createElement(Probe, { nonce: undefined, dispatch })));
    await act(async () => vi.advanceTimersByTime(MASCOT_MOTION_MS));
    expect(dispatch).toHaveBeenCalledOnce();
    root.unmount();
  });
});
