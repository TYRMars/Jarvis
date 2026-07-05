// Regression: route-aware shortcuts (Cmd+N, bare `/`) keyed off
// `window.location.pathname`, which is always "/" under the desktop
// `HashRouter` — so `currentRoutePath()` must derive the route from the
// hash there while still reading `pathname` on the web `BrowserRouter`.

import { afterEach, describe, expect, it } from "vitest";
import { currentRoutePath } from "./useShortcuts";

const realLocation = window.location;

function setLocation(loc: { pathname?: string; hash?: string }): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: loc.pathname ?? "/", hash: loc.hash ?? "" },
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("currentRoutePath", () => {
  it("uses pathname on web (BrowserRouter, empty hash)", () => {
    setLocation({ pathname: "/projects/42", hash: "" });
    expect(currentRoutePath()).toBe("/projects/42");
  });

  it("derives the route from the hash on desktop (HashRouter)", () => {
    // The bug: pathname is "/" under HashRouter, so the route lives in the hash.
    setLocation({ pathname: "/", hash: "#/projects" });
    expect(currentRoutePath()).toBe("/projects");
    expect(currentRoutePath().startsWith("/projects")).toBe(true);
  });

  it("keeps a query string in the hash route (startsWith still matches)", () => {
    setLocation({ pathname: "/", hash: "#/docs?q=readme" });
    expect(currentRoutePath()).toBe("/docs?q=readme");
    expect(currentRoutePath().startsWith("/docs")).toBe(true);
  });

  it("falls back to pathname for a bare `#` or plain anchor (not a route)", () => {
    setLocation({ pathname: "/", hash: "#" });
    expect(currentRoutePath()).toBe("/");
    setLocation({ pathname: "/settings", hash: "#section" });
    expect(currentRoutePath()).toBe("/settings");
  });

  it("returns root when at the HashRouter root", () => {
    setLocation({ pathname: "/", hash: "#/" });
    expect(currentRoutePath()).toBe("/");
  });
});
