import { fireEvent, render, screen, within } from "@testing-library/react";
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
  useAppStore.getState().setActiveId(null);
  useAppStore.getState().setPersistEnabled(true);
  useAppStore.getState().setConvoRows([]);
  useAppStore.getState().setQuickOpen(false);
  useAppStore.getState().setProjects([]);
  useAppStore.getState().setActiveProjectFilter(null);
  useAppStore.getState().setDraftProjectId(null);
  useAppStore.getState().setDraftWorkspace(null);
  useAppStore.setState({
    messages: [],
    conversationRuns: {},
    conversationSurfaces: {},
  });
});

describe("AppSidebar search", () => {
  it("renders both conversations in the recents list (no inline filter)", () => {
    // The inline title-prefix filter has moved into the QuickSwitcher
    // modal — the sidebar list itself is now a plain "show every
    // conversation we know about" surface. This test pins that
    // contract: both rows show, no input box exists, and rows stay
    // compact without project chips or message counts.
    useAppStore.getState().setConvoGroupBy("date");
    useAppStore.getState().setProjects([
      {
        id: "proj-1",
        slug: "svelte-learn",
        name: "Svelte Learn",
        instructions: "",
        tags: [],
        archived: false,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
    ]);
    useAppStore.getState().setConvoRows([
      {
        id: "alpha-12345678",
        title: "Alpha planning",
        message_count: 2,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
        project_id: "proj-1",
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
    expect(screen.queryByText("Svelte Learn")).not.toBeInTheDocument();
    expect(screen.queryByText("2 msg")).not.toBeInTheDocument();
  });

  it("opens the QuickSwitcher modal from the topbar search button", () => {
    renderWithRouter(<AppSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // QuickSwitcher renders only when `quickOpen` is true, so the
    // store flip is what we observe — the modal itself isn't a child
    // of `<AppSidebar>` (it's mounted at the App root).
    expect(useAppStore.getState().quickOpen).toBe(true);
  });

  it("surfaces active background turns in the running section", () => {
    useAppStore.getState().setConvoRows([
      {
        id: "run-12345678",
        title: "Background build",
        message_count: 3,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
      {
        id: "idle-12345678",
        title: "Idle notes",
        message_count: 1,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
    ]);
    useAppStore.getState().setConversationRunStatus("run-12345678", "running");

    renderWithRouter(<AppSidebar />);

    const runningSection = document.querySelector("#running-section")!;
    const recentsSection = document.querySelector(".recents-section")!;
    expect(within(runningSection as HTMLElement).getByText("Background build")).toBeInTheDocument();
    expect(within(runningSection as HTMLElement).queryByText("Idle notes")).not.toBeInTheDocument();
    expect(within(recentsSection as HTMLElement).queryByText("Background build")).not.toBeInTheDocument();
  });

  it("starts a draft conversation from the sidebar and preserves the current context", () => {
    useAppStore.getState().setActiveId("active-12345678");
    useAppStore.getState().pushUserMessage("old visible message");
    useAppStore.getState().setDraftProjectId("proj-current");
    useAppStore.getState().setDraftWorkspace("/Users/x/code/current", null);
    useAppStore.getState().setActiveProjectFilter("proj-filtered");

    renderWithRouter(<AppSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    const s = useAppStore.getState();
    expect(s.activeId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.draftProjectId).toBe("proj-filtered");
    expect(s.draftWorkspacePath).toBe("/Users/x/code/current");
  });

  it("renders Projects as a primary active tab", () => {
    renderWithRouter(<AppSidebar />, ["/projects"]);

    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("link", { name: "Doc" })).toHaveAttribute("href", "/docs");
    expect(screen.queryByText("Code")).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Projects" })).toHaveClass("active");
    const link = screen.getByRole("link", { name: "List" });
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
