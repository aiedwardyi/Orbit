// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHONE_SEEN_FIRST_MS, PHONE_SEEN_MS, PHONE_SEEN_PATH, startPhoneSeen } from "./phone-seen";

const fetchMock = vi.fn();
const ids = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).id);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { hostname: "home.tail1234.ts.net" });
});

afterEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startPhoneSeen", () => {
  it("checks in with one kept id after open, every minute and when visible", async () => {
    startPhoneSeen();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PHONE_SEEN_FIRST_MS);
    expect(fetchMock).toHaveBeenCalledWith(PHONE_SEEN_PATH, expect.objectContaining({ method: "POST" }));
    await vi.advanceTimersByTimeAsync(PHONE_SEEN_MS);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(PHONE_SEEN_MS);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ids()).toHaveLength(3);
    expect(new Set(ids())).toEqual(new Set([localStorage.getItem("omb-phone-id")]));
    expect(localStorage.getItem("omb-phone-id")).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each(["localhost", "127.0.0.1"])("stays quiet on %s", (hostname) => {
    vi.stubGlobal("location", { hostname });
    startPhoneSeen();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays quiet in the desktop app", () => {
    vi.stubGlobal("ogb", {});
    startPhoneSeen();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
