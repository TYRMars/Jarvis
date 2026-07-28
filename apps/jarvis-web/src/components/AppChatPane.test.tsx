import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ComposerUtilityButtons } from "./AppChatPane";
import { useAppStore } from "../store/appStore";

beforeEach(() => {
  useAppStore.getState().setLang("en");
});

describe("ComposerUtilityButtons", () => {
  it("opens the add menu and dispatches the file picker event", () => {
    const events: Event[] = [];
    const onPick = (event: Event) => events.push(event);
    window.addEventListener("jarvis:composer-pick-files", onPick);

    render(<ComposerUtilityButtons />);

    fireEvent.click(screen.getByLabelText("Add context"));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /Attach files/i }));
    expect(events).toHaveLength(1);
    expect(screen.queryByRole("menu")).toBeNull();

    window.removeEventListener("jarvis:composer-pick-files", onPick);
  });

  it("opens slash commands from the add menu", () => {
    const events: Event[] = [];
    const onSlash = (event: Event) => events.push(event);
    window.addEventListener("jarvis:composer-open-slash", onSlash);

    render(<ComposerUtilityButtons />);

    fireEvent.keyDown(screen.getByLabelText("Add context"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: /Commands/i }));

    expect(events).toHaveLength(1);
    expect(screen.queryByRole("menu")).toBeNull();

    window.removeEventListener("jarvis:composer-open-slash", onSlash);
  });

  it("moves focus between add-menu items with arrow keys", async () => {
    render(<ComposerUtilityButtons />);

    fireEvent.keyDown(screen.getByLabelText("Add context"), { key: "ArrowDown" });
    const attach = screen.getByRole("menuitem", { name: /Attach files/i });
    const commands = screen.getByRole("menuitem", { name: /Commands/i });

    await waitFor(() => expect(document.activeElement).toBe(attach));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(commands);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(attach);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(commands);
  });
});
