import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useAppStore } from "../../store/appStore";

// SettingsPage uses `<Link to="/">`, reads from the store, and uses
// the browser hash for its tab state. MemoryRouter keeps app-level
// navigation in-memory; before/after reset hash + prefs so tests
// don't inherit a previous active tab.
beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
});

afterEach(() => {
  useAppStore.getState().setTheme("light");
  useAppStore.getState().setLang("en");
  localStorage.removeItem("jarvis.soul");
  window.history.replaceState(null, "", "/settings");
});

describe("SettingsPage", () => {
  it("renders the active settings tab as a single page", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance", level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Preferences", level: 2 })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Soul" })).toHaveAttribute("href", "#soul");
  });

  it("switches settings tabs without rendering every section", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Soul" }));

    expect(screen.getByRole("heading", { name: "Jarvis Soul", level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Appearance", level: 2 })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Soul" })).toHaveAttribute("aria-current", "page");
  });

  it("theme pill click flips appStore.theme", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const darkPill = screen.getByRole("radio", { name: "Dark" });
    fireEvent.click(darkPill);
    expect(useAppStore.getState().theme).toBe("dark");
  });

  it("language pill click flips appStore.lang", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const zhPill = screen.getByRole("radio", { name: "中文" });
    fireEvent.click(zhPill);
    expect(useAppStore.getState().lang).toBe("zh");
  });

  it("saves Jarvis soul settings to localStorage", () => {
    window.history.replaceState(null, "", "/settings#soul");
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const section = screen.getByRole("heading", { name: "Jarvis Soul" }).closest("section")!;
    fireEvent.change(within(section).getByDisplayValue("Jarvis"), {
      target: { value: "Javvis" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));

    expect(JSON.parse(localStorage.getItem("jarvis.soul") || "{}")).toMatchObject({
      name: "Javvis",
      enabled: true,
    });
  });
});
