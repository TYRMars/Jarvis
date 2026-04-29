// Smoke tests for the chat-header mode badge. We mock the WS layer
// because there's no real socket in jsdom; the only thing the badge
// does on click is `sendFrame({type:"set_mode", mode})`, so the
// mock just records what was sent.
//
// "Bypass" is selectable but pops a `confirm()` first — we stub
// `window.confirm` to assert both branches (accept / decline).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../store/appStore";
import { ModeBadge } from "./ModeBadge";

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/socket", () => ({
  isOpen: () => true,
  sendFrame: (frame: any) => {
    sendMock(frame);
    return true;
  },
}));

const originalConfirm = window.confirm;
beforeEach(() => {
  sendMock.mockClear();
});
afterEach(() => {
  window.confirm = originalConfirm;
});

describe("ModeBadge", () => {
  it("shows the current mode label", () => {
    useAppStore.getState().setPermissionMode("ask");
    render(<ModeBadge />);
    // The trigger contains the active mode label.
    expect(screen.getByRole("button", { name: /Ask/ })).toBeInTheDocument();
  });

  it("opens the picker and switches mode via set_mode frame", () => {
    useAppStore.getState().setPermissionMode("ask");
    render(<ModeBadge />);
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    // Picker exposes all five modes as menuitemradio options.
    const planOption = screen.getByRole("menuitemradio", { name: /Plan/ });
    fireEvent.click(planOption);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({ type: "set_mode", mode: "plan" });
  });

  it("bypass click confirms before sending; accept ships set_mode", () => {
    useAppStore.getState().setPermissionMode("ask");
    window.confirm = vi.fn(() => true);
    render(<ModeBadge />);
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    const bypass = screen.getByRole("menuitemradio", { name: /Bypass/ });
    expect(bypass.disabled).toBe(false);
    fireEvent.click(bypass);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({ type: "set_mode", mode: "bypass" });
  });

  it("bypass click confirms before sending; decline does not ship", () => {
    useAppStore.getState().setPermissionMode("ask");
    window.confirm = vi.fn(() => false);
    render(<ModeBadge />);
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Bypass/ }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("clicking the active mode just closes the picker without sending", () => {
    useAppStore.getState().setPermissionMode("auto");
    render(<ModeBadge />);
    // The trigger and the active picker option both contain
    // "Auto" — disambiguate by role + checked state.
    fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    const selectedAuto = screen.getByRole("menuitemradio", { checked: true });
    fireEvent.click(selectedAuto);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
