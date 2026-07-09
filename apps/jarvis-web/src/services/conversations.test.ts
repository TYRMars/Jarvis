import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../store/appStore";
import { forceReloadActiveConversation } from "./conversations";

// conversations.ts pulls in the socket/ui/status layers at import time; stub the
// ones with browser side effects so we can exercise the fetch path in isolation.
vi.mock("./socket", () => ({ sendFrame: vi.fn() }));
vi.mock("./status", () => ({ showError: vi.fn() }));
vi.mock("../components/ui", () => ({ confirm: vi.fn() }));
vi.mock("./api", () => ({ apiUrl: (p: string) => p }));

describe("forceReloadActiveConversation stale-request guard (#407)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    appStore.getState().setPersistEnabled(true);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("does not clobber the view when the user switches conversations mid-fetch", async () => {
    appStore.getState().setActiveId("A");

    let resolveFetch!: (v: unknown) => void;
    const inFlight = new Promise((res) => {
      resolveFetch = res;
    });
    globalThis.fetch = vi.fn(() => inFlight) as unknown as typeof fetch;

    const loadHistory = vi.spyOn(appStore.getState(), "loadHistory");

    const pending = forceReloadActiveConversation();

    // User navigates to conversation B while A's rehydrate is still in flight.
    appStore.getState().setActiveId("B");

    resolveFetch({ ok: true, json: async () => ({ messages: [{ role: "user", content: "A" }] }) });

    await expect(pending).resolves.toBe(false);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("loads history when the active conversation is unchanged", async () => {
    appStore.getState().setActiveId("A");
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [{ role: "user", content: "A" }] }),
    })) as unknown as typeof fetch;

    const loadHistory = vi.spyOn(appStore.getState(), "loadHistory");

    await expect(forceReloadActiveConversation()).resolves.toBe(true);
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});
