// Composer focused on the paste-folding loop and submit gating.
// Smaller pastes flow through to the textarea; pastes ≥
// PASTE_THRESHOLD_BYTES (2048) become a `[Pasted N KB] #token`
// placeholder, with the original content stashed in the store and
// substituted back at submit time.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useAppStore } from "../../store/appStore";
import { Composer } from "./Composer";

const sendMock = vi.hoisted(() => vi.fn(() => true));
const startTurnMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../services/socket", () => ({
  isOpen: () => true,
  sendFrame: (frame: any) => {
    sendMock(frame);
    return true;
  },
}));
vi.mock("../../services/conversationSockets", () => ({
  startConversationTurn: (opts: any) => {
    startTurnMock(opts);
    return true;
  },
}));

beforeEach(() => {
  sendMock.mockClear();
  startTurnMock.mockClear();
});

function mount() {
  const slashCommands = () => [];
  const pickedRouting = () => ({ provider: null, model: null });
  return render(<Composer slashCommands={slashCommands} pickedRouting={pickedRouting} />);
}

describe("Composer paste folding", () => {
  it("small pastes flow through to the textarea unchanged", () => {
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    fireEvent.paste(ta, {
      clipboardData: { getData: (k: string) => (k === "text" ? "small" : "") },
    });
    // No placeholder substitution — the paste fell through to the
    // browser default, leaving the controlled value untouched.
    expect(useAppStore.getState().composerValue).toBe("");
    expect(useAppStore.getState().pastedBlobs).toEqual({});
  });

  it("large pastes are folded into a placeholder + sidecar blob", () => {
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const big = "x".repeat(3000);
    fireEvent.paste(ta, {
      clipboardData: { getData: (k: string) => (k === "text" ? big : "") },
    });
    const value = useAppStore.getState().composerValue;
    expect(value).toMatch(/^\[Pasted [\d.]+ KB\] #[a-f0-9]+$/);
    const token = value.match(/#([a-f0-9]+)/)![1];
    expect(useAppStore.getState().pastedBlobs[token]).toBe(big);
  });

  it("submit expands placeholder back to full content in the WS frame", () => {
    // An activeId is set so the submit path skips the
    // auto-`new` frame the Composer fires for fresh persisted
    // sessions — that path is exercised by its own test below.
    act(() => useAppStore.getState().setActiveId("test-active"));
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const big = "y".repeat(3000);
    fireEvent.paste(ta, {
      clipboardData: { getData: (k: string) => (k === "text" ? big : "") },
    });
    // Append a trailing question after the placeholder so we can see
    // the substitution preserves surrounding text.
    const placeholder = useAppStore.getState().composerValue;
    act(() => useAppStore.getState().setComposerValue(`${placeholder}\nexplain pls`));
    fireEvent.submit(ta.closest("form")!);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    expect(startTurnMock.mock.calls[0][0]).toMatchObject({
      conversationId: "test-active",
      content: `${big}\nexplain pls`,
    });
    // Submit clears both the textarea and the blob sidecar.
    expect(useAppStore.getState().composerValue).toBe("");
    expect(useAppStore.getState().pastedBlobs).toEqual({});
  });

  it("submit while inFlight is suppressed", () => {
    mount();
    act(() => {
      useAppStore.getState().setInFlight(true);
      useAppStore.getState().setComposerValue("hello");
    });
    fireEvent.submit(screen.getByPlaceholderText(/Type/i).closest("form")!);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("submit with an empty composer is suppressed", () => {
    mount();
    fireEvent.submit(screen.getByPlaceholderText(/Type/i).closest("form")!);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("two synchronous submits in the same tick only push one user bubble", () => {
    // Regression for the stale-closure bug: `inFlight` from a
    // selector capture stays `false` until React re-renders, so a
    // double-fire (Enter autorepeat / fast double-click) used to
    // push two user messages and two `user` frames. Active id is
    // set so the auto-`new` frame doesn't run; this test is about
    // the inFlight gate, not new-conversation creation.
    act(() => useAppStore.getState().setActiveId("test-active"));
    mount();
    act(() => useAppStore.getState().setComposerValue("hello"));
    const form = screen.getByPlaceholderText(/Type/i).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().messages.filter((m) => m.kind === "user")).toHaveLength(1);
    expect(useAppStore.getState().inFlight).toBe(true);
  });

  it("first submit on a fresh persisted session starts a new conversation turn", () => {
    // Production behaviour: when `persistEnabled && !activeId`,
    // the Composer fires a `new` frame to spin up the persisted
    // row before the user message lands. Verifies the auto-create
    // path the failing CI surfaced when this case wasn't covered.
    act(() => useAppStore.getState().setActiveId(null));
    mount();
    act(() => useAppStore.getState().setComposerValue("hello"));
    fireEvent.submit(
      screen.getByPlaceholderText(/Type/i).closest("form")!,
    );
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    expect(startTurnMock.mock.calls[0][0]).toMatchObject({
      isNew: true,
      content: "hello",
    });
    expect(typeof startTurnMock.mock.calls[0][0].conversationId).toBe("string");
  });
});
