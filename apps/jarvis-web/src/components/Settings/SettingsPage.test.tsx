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
  it("renders the active settings section as a single page", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    // h1 page title
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    // Default landing section is the first nav item — "Appearance & Layout".
    // The leaf section ("Appearance") renders embedded (no h2 of its own);
    // the super-section h2 is what the user sees.
    expect(
      screen.getByRole("heading", { name: "Appearance & Layout", level: 2 }),
    ).toBeInTheDocument();
    // No other top-level section's h2 should be rendered.
    expect(screen.queryByRole("heading", { name: "Models", level: 2 })).not.toBeInTheDocument();
    // The active nav link should be marked.
    expect(
      screen.getByRole("link", { name: "Appearance & Layout" }),
    ).toHaveAttribute("aria-current", "page");
    // The Persona nav link points at the persona section.
    expect(screen.getByRole("link", { name: "Persona" })).toHaveAttribute("href", "#persona");
  });

  it("switches settings sections without rendering every section", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Persona" }));

    // Persona is a standalone (non-embedded) leaf — its own h2 is shown.
    expect(screen.getByRole("heading", { name: "Jarvis Soul", level: 2 })).toBeInTheDocument();
    // The previous super-section's h2 is gone.
    expect(
      screen.queryByRole("heading", { name: "Appearance & Layout", level: 2 }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Persona" })).toHaveAttribute("aria-current", "page");
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
    // Persona section uses the standalone Soul section.
    window.history.replaceState(null, "", "/settings#persona");
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

  it("legacy hashes are remapped to the new IA", () => {
    // Old #soul should land on persona. Drive the page through the
    // hashchange event so we exercise the same code path bookmarks hit.
    window.history.replaceState(null, "", "/settings#soul");
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Jarvis Soul", level: 2 })).toBeInTheDocument();
    expect(window.location.hash).toBe("#persona");
  });
});
