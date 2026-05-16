// Renders the M2.3 toast when the server reports a non-user
// mode change. Operator-initiated changes (via:"user" / absent)
// stay silent — verified separately so a future regression that
// pops a toast on every click is caught.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useAppStore } from "../../store/appStore";
import { ModeChangedToast } from "./ModeChangedToast";

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.getState().setRecentModeChange(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ModeChangedToast", () => {
  it("renders when the change came from the agent (via:tool)", () => {
    act(() => {
      useAppStore.getState().setRecentModeChange({
        mode: "plan",
        via: "tool",
        at: Date.now(),
      });
    });
    render(<ModeChangedToast />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /Agent.*switched permission mode to.*plan.*read-only/i,
    );
  });

  it("stays silent for operator-initiated changes (via:user)", () => {
    act(() => {
      useAppStore.getState().setRecentModeChange({
        mode: "auto",
        via: "user",
        at: Date.now(),
      });
    });
    const { container } = render(<ModeChangedToast />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no recent change is recorded", () => {
    const { container } = render(<ModeChangedToast />);
    expect(container).toBeEmptyDOMElement();
  });

  it("can be dismissed via the × button", () => {
    act(() => {
      useAppStore.getState().setRecentModeChange({
        mode: "plan",
        via: "tool",
        at: Date.now(),
      });
    });
    render(<ModeChangedToast />);
    const close = screen.getByLabelText("Dismiss");
    act(() => {
      close.click();
    });
    expect(useAppStore.getState().recentModeChange).toBeNull();
  });
});
