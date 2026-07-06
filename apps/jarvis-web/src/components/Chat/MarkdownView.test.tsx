// #364: MarkdownView renders markdown through an inner React root
// (`createRoot`, cached per-container in a WeakMap by md_render). Without an
// effect cleanup that root was never `unmount()`ed, leaking a root — plus its
// effects/timers — per message card on every conversation switch. This asserts
// the view reuses the cached root across content changes and tears it down
// exactly once, on unmount.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import * as mdRender from "../../md_render";
import { MarkdownView } from "./MarkdownView";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MarkdownView (#364)", () => {
  it("reuses the cached root across re-renders and tears it down only on unmount", () => {
    const unmountSpy = vi.spyOn(mdRender, "unmountMarkdownFrom");
    const { rerender, unmount, container } = render(<MarkdownView content="first" />);
    const el = container.querySelector(".markdown-body");
    expect(el).not.toBeNull();

    // A `content` change must reuse the cached root, not tear it down — the
    // teardown lives in a mount-only effect (deps `[]`).
    rerender(<MarkdownView content="second" />);
    expect(unmountSpy).not.toHaveBeenCalled();

    // On unmount the inner root is torn down exactly once, for this view's node.
    unmount();
    expect(unmountSpy).toHaveBeenCalledTimes(1);
    expect(unmountSpy).toHaveBeenCalledWith(el);
  });
});
