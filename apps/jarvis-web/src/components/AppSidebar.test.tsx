import { fireEvent, render, screen } from "@testing-library/react";
import { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppSidebar } from "./AppSidebar";
import { useAppStore } from "../store/appStore";

// AppSidebar embeds AccountMenu which uses `<Link to="/settings">`,
// and react-router-dom's Link blows up without a router ancestor.
// Wrap in `MemoryRouter` (not `BrowserRouter`) so navigation in tests
// stays in-memory and doesn't trigger jsdom's URL machinery.
const renderWithRouter = (ui: ReactElement, initialEntries = ["/"]) =>
  render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);

afterEach(() => {
  // Reset toggle state so cross-test ordering doesn't leak.
  useAppStore.getState().setSidebarOpen(true);
});

describe("AppSidebar search", () => {
  it("renders both conversations in the recents list (no inline filter)", () => {
    // The inline title-prefix filter has moved into the QuickSwitcher
    // modal — the sidebar list itself is now a plain "show every
    // conversation we know about" surface. This test pins that
    // contract: both rows show, no input box exists.
    useAppStore.getState().setConvoRows([
      {
        id: "alpha-12345678",
        title: "Alpha planning",
        message_count: 2,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
      {
        id: "beta-12345678",
        title: "Beta bugfix",
        message_count: 4,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
    ]);

    renderWithRouter(<AppSidebar />);

    expect(screen.getByText("Alpha planning")).toBeInTheDocument();
    expect(screen.getByText("Beta bugfix")).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: /search conversations/i }),
    ).not.toBeInTheDocument();
  });

  it("opens the QuickSwitcher modal from the topbar search button", () => {
    renderWithRouter(<AppSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // QuickSwitcher renders only when `quickOpen` is true, so the
    // store flip is what we observe — the modal itself isn't a child
    // of `<AppSidebar>` (it's mounted at the App root).
    expect(useAppStore.getState().quickOpen).toBe(true);
  });

  it("renders Projects as a primary active tab", () => {
    renderWithRouter(<AppSidebar />, ["/projects"]);

    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Work" })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("link", { name: "Doc" })).toHaveAttribute("href", "/docs");
    expect(screen.queryByText("Code")).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Work" })).toHaveClass("active");
    const link = screen.getByRole("link", { name: "Projects" });
    expect(link).toHaveAttribute("href", "/projects");
    expect(link).toHaveClass("active");
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建会话" })).not.toBeInTheDocument();
    expect(screen.queryByText("Alpha planning")).not.toBeInTheDocument();
    expect(screen.queryByText("All conversations")).not.toBeInTheDocument();
  });

  it("renders Doc-specific sidebar actions on the docs route", () => {
    renderWithRouter(<AppSidebar />, ["/docs"]);

    expect(screen.getByRole("link", { name: "Doc" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "New page" })).toBeInTheDocument();
    // Scope rail rows replace the old "LLM Wiki" placeholder link.
    // "All docs" is always present and active by default.
    expect(screen.getByRole("button", { name: /^All docs/ })).toHaveClass(
      "is-active",
    );
    expect(screen.getByRole("button", { name: /^Pinned/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Research/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Archive/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建会话" })).not.toBeInTheDocument();
    expect(screen.queryByText("Alpha planning")).not.toBeInTheDocument();
  });
});

describe("AppSidebar collapse", () => {
  it("toggles the sidebar-closed body class and persists the state", () => {
    renderWithRouter(<AppSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(useAppStore.getState().sidebarOpen).toBe(false);
    expect(document.body.classList.contains("sidebar-closed")).toBe(true);
    expect(localStorage.getItem("jarvis.sidebarOpen")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(document.body.classList.contains("sidebar-closed")).toBe(false);
    expect(localStorage.getItem("jarvis.sidebarOpen")).toBe("true");
  });
});
