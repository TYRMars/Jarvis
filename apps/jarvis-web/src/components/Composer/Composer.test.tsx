// Composer focused on the paste-folding loop and submit gating.
// Smaller pastes flow through to the textarea; pastes ≥
// PASTE_THRESHOLD_BYTES (2048) become a `[Pasted N KB] #token`
// placeholder, with the original content stashed in the store and
// substituted back at submit time.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { useAppStore } from "../../store/appStore";
import { Composer, resizeComposerTextarea } from "./Composer";

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
    return startTurnMock(opts) !== false;
  },
}));

beforeEach(() => {
  sendMock.mockClear();
  startTurnMock.mockClear();
  startTurnMock.mockImplementation((opts: any) => {
    const store = useAppStore.getState();
    if (store.isConversationRunning(opts.conversationId)) return false;
    store.setConversationRunStatus(opts.conversationId, "running", {
      startedAt: Date.now(),
      lastError: null,
    });
    return true;
  });
});

function mount(commands = [] as Array<{ cmd: string; descKey: string; run?: () => void; insertText?: string }>) {
  const slashCommands = () => commands;
  const pickedRouting = () => ({ provider: null, model: null });
  return render(<Composer slashCommands={slashCommands} pickedRouting={pickedRouting} />);
}

describe("Composer paste folding", () => {
  it("caps textarea autogrow at CSS max-height and scrolls internally", () => {
    const ta = document.createElement("textarea");
    ta.style.maxHeight = "170px";
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 320 });

    resizeComposerTextarea(ta);

    expect(ta.style.height).toBe("170px");
    expect(ta.style.overflowY).toBe("auto");
  });

  it("keeps short textarea content unscrolled", () => {
    const ta = document.createElement("textarea");
    ta.style.maxHeight = "170px";
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 88 });

    resizeComposerTextarea(ta);

    expect(ta.style.height).toBe("88px");
    expect(ta.style.overflowY).toBe("hidden");
  });

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

  it("pasted files render as attachment chips and are included in submit content", async () => {
    act(() => useAppStore.getState().setActiveId("test-active"));
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const file = new File(["alpha\nbeta"], "notes.txt", { type: "text/plain" });

    fireEvent.paste(ta, {
      clipboardData: { getData: () => "", files: [file] },
    });

    expect(await screen.findByText("notes.txt")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("10 B")).toBeTruthy());

    act(() => useAppStore.getState().setComposerValue("summarize this"));
    fireEvent.submit(ta.closest("form")!);

    expect(startTurnMock).toHaveBeenCalledTimes(1);
    const content = startTurnMock.mock.calls[0][0].content;
    expect(content).toContain("summarize this");
    expect(content).toContain('<attached-file name="notes.txt" type="text/plain" size="10">');
    expect(content).toContain("alpha\nbeta");
    expect(screen.queryByText("notes.txt")).toBeNull();
    const userMessage = useAppStore.getState().messages.find((message) => message.kind === "user");
    expect(userMessage?.content).toContain("summarize this");
    expect(userMessage?.content).toContain("notes.txt (10 B)");
    expect(userMessage?.content).not.toContain("<attached-file");
    expect(userMessage?.content).not.toContain("alpha\nbeta");
    if (userMessage?.kind === "user") {
      expect(userMessage.submittedContent).toContain('<attached-file name="notes.txt" type="text/plain" size="10">');
      expect(userMessage.submittedContent).toContain("alpha\nbeta");
    }
    expect(useAppStore.getState().composerHistory).toEqual(["summarize this"]);

    act(() => useAppStore.getState().setInFlight(false));
    act(() => useAppStore.getState().setConversationRunStatus("test-active", "completed"));
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(useAppStore.getState().composerValue).toBe("summarize this");
  });

  it("shows image attachment previews and sends the image data URL", async () => {
    act(() => useAppStore.getState().setActiveId("test-active"));
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const png = new File(["fake-png"], "screen.png", { type: "image/png" });

    fireEvent.paste(ta, {
      clipboardData: { getData: () => "", files: [png] },
    });

    await screen.findByAltText("Preview of screen.png");
    await waitFor(() => expect(screen.getByText("8 B")).toBeTruthy());

    fireEvent.submit(ta.closest("form")!);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    const content = startTurnMock.mock.calls[0][0].content;
    expect(content).toContain('<attached-image name="screen.png" type="image/png" size="8">');
    expect(content).toContain("data:image/png;base64,");
    const userMessage = useAppStore.getState().messages.find((message) => message.kind === "user");
    expect(userMessage?.content).toContain("screen.png (8 B)");
    expect(userMessage?.content).not.toContain("data:image/png;base64,");
    if (userMessage?.kind === "user") {
      expect(userMessage.submittedContent).toContain('<attached-image name="screen.png" type="image/png" size="8">');
      expect(userMessage.submittedContent).toContain("data:image/png;base64,");
    }
  });

  it("allows sending a ready attachment without typed text", async () => {
    act(() => useAppStore.getState().setActiveId("test-active"));
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const file = new File(["standalone"], "standalone.txt", { type: "text/plain" });

    fireEvent.paste(ta, {
      clipboardData: { getData: () => "", files: [file] },
    });

    await screen.findByText("standalone.txt");
    await waitFor(() => expect(screen.getByText("10 B")).toBeTruthy());
    const send = screen.getByTitle("Send");
    expect(send.hasAttribute("disabled")).toBe(false);

    fireEvent.click(send);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    expect(startTurnMock.mock.calls[0][0].content).toContain("standalone");
    const userMessage = useAppStore.getState().messages.find((message) => message.kind === "user");
    expect(userMessage?.content).toContain("standalone.txt (10 B)");
    expect(userMessage?.content).not.toContain("<attached-file");
    if (userMessage?.kind === "user") {
      expect(userMessage.submittedContent).toContain("<attached-file");
      expect(userMessage.submittedContent).toContain("standalone");
    }
    expect(useAppStore.getState().composerHistory).toEqual([]);
  });

  it("keeps send disabled while an attachment is still loading", async () => {
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const file = new File(["pending"], "loading.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: () => new Promise<string>(() => {}),
    });

    fireEvent.paste(ta, {
      clipboardData: { getData: () => "", files: [file] },
    });
    act(() => useAppStore.getState().setComposerValue("please read this"));

    expect(await screen.findByText("loading.txt")).toBeTruthy();
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.getByTitle("Send").hasAttribute("disabled")).toBe(true);
  });

  it("removes the last attachment with Backspace from an empty composer", async () => {
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const file = new File(["remove me"], "remove-me.txt", { type: "text/plain" });

    fireEvent.paste(ta, {
      clipboardData: { getData: () => "", files: [file] },
    });

    await screen.findByText("remove-me.txt");
    await waitFor(() => expect(screen.getByText("9 B")).toBeTruthy());
    expect(screen.getByTitle("Send").hasAttribute("disabled")).toBe(false);

    fireEvent.keyDown(ta, { key: "Backspace" });

    expect(screen.queryByText("remove-me.txt")).toBeNull();
    expect(screen.getByTitle("Send").hasAttribute("disabled")).toBe(true);
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

  it("Enter submits when idle, but IME composition Enter does not", () => {
    act(() => useAppStore.getState().setActiveId("test-active"));
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    act(() => useAppStore.getState().setComposerValue("你好"));

    fireEvent.compositionStart(ta);
    expect(fireEvent.keyDown(ta, { key: "Enter" })).toBe(true);
    expect(startTurnMock).not.toHaveBeenCalled();

    fireEvent.compositionEnd(ta);
    expect(fireEvent.keyDown(ta, { key: "Enter" })).toBe(false);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
  });

  it("Enter while a turn is running keeps textarea newline behavior", () => {
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    act(() => {
      useAppStore.getState().setInFlight(true);
      useAppStore.getState().setComposerValue("next thought");
    });

    expect(fireEvent.keyDown(ta, { key: "Enter" })).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
    expect(startTurnMock).not.toHaveBeenCalled();
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

  it("stores sent prompts and recalls them with ArrowUp / ArrowDown from an empty composer", () => {
    act(() => useAppStore.getState().setActiveId("test-active"));
    mount();
    const ta = screen.getByPlaceholderText(/Type/i);
    const form = ta.closest("form")!;

    act(() => useAppStore.getState().setComposerValue("first prompt"));
    fireEvent.submit(form);
    act(() => useAppStore.getState().setInFlight(false));
    act(() => useAppStore.getState().setConversationRunStatus("test-active", "completed"));
    act(() => useAppStore.getState().setComposerValue("second prompt"));
    fireEvent.submit(form);
    act(() => useAppStore.getState().setInFlight(false));

    expect(useAppStore.getState().composerHistory).toEqual(["first prompt", "second prompt"]);
    expect(useAppStore.getState().composerValue).toBe("");

    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(useAppStore.getState().composerValue).toBe("second prompt");
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(useAppStore.getState().composerValue).toBe("first prompt");
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(useAppStore.getState().composerValue).toBe("second prompt");
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(useAppStore.getState().composerValue).toBe("");
  });

  it("the composer slash event opens the command palette", () => {
    mount([{ cmd: "/plan", descKey: "chatCoreAddCommand", insertText: "/plan " }]);
    act(() => {
      window.dispatchEvent(new CustomEvent("jarvis:composer-open-slash"));
    });
    expect(screen.getByText("/plan")).toBeTruthy();
    expect(useAppStore.getState().composerValue).toBe("/");
  });

  it("Escape closes the slash palette, and the composer slash event reopens it", () => {
    mount([{ cmd: "/plan", descKey: "chatCoreAddCommand", insertText: "/plan " }]);
    act(() => {
      window.dispatchEvent(new CustomEvent("jarvis:composer-open-slash"));
    });
    const ta = screen.getByPlaceholderText(/Type/i);
    expect(screen.getByText("/plan")).toBeTruthy();

    fireEvent.keyDown(ta, { key: "Escape" });
    expect(document.getElementById("slash-palette")?.classList.contains("hidden")).toBe(true);
    expect(useAppStore.getState().composerValue).toBe("/");

    act(() => {
      window.dispatchEvent(new CustomEvent("jarvis:composer-open-slash"));
    });
    expect(document.getElementById("slash-palette")?.classList.contains("hidden")).toBe(false);
  });
});
