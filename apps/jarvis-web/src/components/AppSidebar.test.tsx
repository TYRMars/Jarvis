import { fireEvent, render, screen, within } from "@testing-library/react";
import { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppSidebar } from "./AppSidebar";
import { useAppStore } from "../store/appStore";
import { handleFrameForConversation } from "../services/frames";

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
  useAppStore.getState().setConvoLayoutMode("project");
  useAppStore.getState().setConvoSortBy("updated");
  useAppStore.getState().setConvoVisibility("all");
  useAppStore.getState().setConvoSectionOrder("projectsFirst");
  useAppStore.setState({
    messages: [],
    pinned: new Set(),
    conversationRuns: {},
    conversationSurfaces: {},
    conversationUnread: {},
  });
  localStorage.removeItem("jarvis.convo.pinned");
});

describe("AppSidebar search", () => {
  it("renders both conversations in the recents list (no inline filter)", () => {
    // The inline title-prefix filter has moved into the QuickSwitcher
    // modal — the sidebar list itself is now a plain "show every
    // conversation we know about" surface. This test pins that
    // contract: both rows show, no input box exists, and project
    // context is visible without bringing message counts back.
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
        source: "requirement",
        requirement_title: "Ship roadmap import",
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

    expect(screen.getByText("Ship roadmap import")).toBeInTheDocument();
    expect(screen.getByText("Beta bugfix")).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: /search conversations/i }),
    ).not.toBeInTheDocument();
    const reqRow = screen.getByText("Ship roadmap import").closest("li");
    expect(reqRow).not.toBeNull();
    expect(reqRow).toHaveTextContent("Auto");
    expect(screen.getByText("Svelte Learn")).toBeInTheDocument();
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

  it("surfaces active background turns in their original list position", () => {
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

    expect(document.querySelector("#running-section")).toBeNull();
    expect(screen.getByText("Background build")).toBeInTheDocument();
    expect(
      document.querySelector('li[data-id="run-12345678"][data-run-status="running"] .convo-spinner'),
    ).not.toBeNull();
  });

  it("renders project and conversation sections as peers, keeps pinned rows separate, and limits groups to five", () => {
    useAppStore.getState().setConvoLayoutMode("project");
    useAppStore.getState().setProjects([
      {
        id: "proj-1",
        slug: "jarvis",
        name: "Jarvis",
        instructions: "",
        tags: [],
        archived: false,
        created_at: "2026-04-20T00:00:00Z",
        updated_at: "2026-04-20T00:00:00Z",
      },
      {
        id: "proj-empty",
        slug: "empty",
        name: "Empty project",
        instructions: "",
        tags: [],
        archived: false,
        created_at: "2026-04-19T00:00:00Z",
        updated_at: "2026-04-19T00:00:00Z",
      },
    ]);
    useAppStore.getState().setConvoRows([
      {
        id: "free-1",
        title: "Free chat row",
        message_count: 1,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
      {
        id: "pinned-project",
        title: "Pinned project row",
        message_count: 1,
        project_id: "proj-1",
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `project-${i + 1}`,
        title: `Project row ${i + 1}`,
        message_count: 1,
        project_id: "proj-1",
        created_at: `2026-04-2${i}T00:00:00Z`,
        updated_at: `2026-04-2${i}T00:00:00Z`,
      })),
    ]);
    useAppStore.getState().togglePin("pinned-project");

    renderWithRouter(<AppSidebar />);

    const pinnedSection = document.querySelector("#pinned-section") as HTMLElement;
    const projectSection = document.querySelector(".convo-section-projects") as HTMLElement;
    const conversationSection = document.querySelector(".convo-section-conversations") as HTMLElement;
    expect(within(pinnedSection).getByText("Pinned project row")).toBeInTheDocument();
    expect(within(projectSection).queryByText("Pinned project row")).not.toBeInTheDocument();
    expect(within(conversationSection).queryByText("Pinned project row")).not.toBeInTheDocument();
    expect(within(projectSection).getByRole("button", { name: /Projects/ })).toBeInTheDocument();
    expect(within(conversationSection).getByRole("button", { name: /Chats/ })).toBeInTheDocument();
    expect(
      Array.from(projectSection.querySelectorAll(".convo-group-label span")).some(
        (el) => el.textContent === "Jarvis",
      ),
    ).toBe(true);
    expect(within(conversationSection).getByText("Free chat row")).toBeInTheDocument();
    expect(within(projectSection).queryByText("Free chat row")).not.toBeInTheDocument();
    expect(within(projectSection).getByText("Project row 6")).toBeInTheDocument();
    expect(screen.queryByText("Project row 1")).not.toBeInTheDocument();
    expect(within(projectSection).getByText("No conversations")).toBeInTheDocument();

    fireEvent.click(within(projectSection).getByRole("button", { name: /Projects/ }));
    expect(within(projectSection).queryByText("Project row 6")).not.toBeInTheDocument();
    expect(within(projectSection).queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(within(projectSection).getByRole("button", { name: /Projects/ }));
    expect(within(projectSection).getByText("Project row 6")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByText("Project row 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("marks background conversation frames as unread locally", () => {
    useAppStore.setState({ activeId: "active-12345678" });
    useAppStore.getState().setConvoRows([
      {
        id: "active-12345678",
        title: "Active chat",
        message_count: 1,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
      {
        id: "background-12345678",
        title: "Background chat",
        message_count: 1,
        created_at: "2026-04-26T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
    ]);
    handleFrameForConversation("background-12345678", {
      type: "assistant_message",
      message: { role: "assistant", content: "done" },
    });

    renderWithRouter(<AppSidebar />);

    expect(
      screen.getByRole("button", { name: /Background chat.*1 unread/ }),
    ).toBeInTheDocument();
  });

  it("applies organize menu layout, sort, visibility, and section order controls", () => {
    useAppStore.getState().setConvoSectionOrder("projectsFirst");
    useAppStore.getState().setActiveProjectFilter("proj-a");
    useAppStore.getState().setDraftWorkspace("/repo/a", null);
    useAppStore.getState().setProjects([
      {
        id: "proj-a",
        slug: "alpha",
        name: "Alpha project",
        instructions: "",
        tags: [],
        archived: false,
        created_at: "2026-04-10T00:00:00Z",
        updated_at: "2026-04-20T00:00:00Z",
      },
      {
        id: "proj-b",
        slug: "beta",
        name: "Beta project",
        instructions: "",
        tags: [],
        archived: false,
        created_at: "2026-04-11T00:00:00Z",
        updated_at: "2026-04-21T00:00:00Z",
      },
      {
        id: "proj-empty",
        slug: "empty",
        name: "Empty project",
        instructions: "",
        tags: [],
        archived: false,
        created_at: "2026-04-12T00:00:00Z",
        updated_at: "2026-04-12T00:00:00Z",
      },
    ]);
    useAppStore.getState().setConvoRows([
      {
        id: "project-a-row",
        title: "Alpha updated first",
        message_count: 1,
        project_id: "proj-a",
        workspace_path: "/repo/a",
        created_at: "2026-04-20T00:00:00Z",
        updated_at: "2026-04-26T00:00:00Z",
      },
      {
        id: "project-b-row",
        title: "Beta created first",
        message_count: 1,
        project_id: "proj-b",
        workspace_path: "/repo/b",
        created_at: "2026-04-24T00:00:00Z",
        updated_at: "2026-04-25T00:00:00Z",
      },
      {
        id: "free-related",
        title: "Workspace related chat",
        message_count: 1,
        workspace_path: "/repo/a",
        created_at: "2026-04-23T00:00:00Z",
        updated_at: "2026-04-23T00:00:00Z",
      },
      {
        id: "free-other",
        title: "Unrelated chat",
        message_count: 1,
        workspace_path: "/repo/b",
        created_at: "2026-04-22T00:00:00Z",
        updated_at: "2026-04-22T00:00:00Z",
      },
    ]);

    renderWithRouter(<AppSidebar />);

    let projectSection = document.querySelector(".convo-section-projects") as HTMLElement;
    fireEvent.click(within(projectSection).getByRole("button", { name: "Organize" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Recent projects/ }));
    projectSection = document.querySelector(".convo-section-projects") as HTMLElement;
    expect(within(projectSection).queryByText("Empty project")).not.toBeInTheDocument();

    fireEvent.click(within(projectSection).getByRole("button", { name: "Organize" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Chronological/ }));
    projectSection = document.querySelector(".convo-section-projects") as HTMLElement;
    expect(projectSection.querySelector(".convo-project-group")).toBeNull();
    expect(within(projectSection).getByText("Alpha updated first")).toBeInTheDocument();
    expect(within(projectSection).getByText("Beta created first")).toBeInTheDocument();

    fireEvent.click(within(projectSection).getByRole("button", { name: "Organize" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Created time/ }));
    projectSection = document.querySelector(".convo-section-projects") as HTMLElement;
    expect(projectSection.textContent?.indexOf("Beta created first")).toBeLessThan(
      projectSection.textContent?.indexOf("Alpha updated first") ?? 0,
    );

    fireEvent.click(within(projectSection).getByRole("button", { name: "Organize" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Related/ }));
    projectSection = document.querySelector(".convo-section-projects") as HTMLElement;
    const conversationSection = document.querySelector(".convo-section-conversations") as HTMLElement;
    expect(within(projectSection).getByText("Alpha updated first")).toBeInTheDocument();
    expect(within(projectSection).queryByText("Beta created first")).not.toBeInTheDocument();
    expect(within(conversationSection).getByText("Workspace related chat")).toBeInTheDocument();
    expect(within(conversationSection).queryByText("Unrelated chat")).not.toBeInTheDocument();

    fireEvent.click(within(conversationSection).getByRole("button", { name: "Organize" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    const firstSection = document.querySelector(".convo-rail-sections .convo-section") as HTMLElement;
    expect(firstSection).toHaveClass("convo-section-conversations");
  });

  it("starts a draft conversation from the sidebar and preserves the current context", () => {
    useAppStore.getState().setActiveId("active-12345678");
    useAppStore.getState().pushUserMessage("old visible message");
    useAppStore.getState().setDraftProjectId("proj-current");
    useAppStore.getState().setDraftWorkspace("/Users/x/code/current", null);
    useAppStore.getState().setActiveProjectFilter("proj-filtered");

    renderWithRouter(<AppSidebar />);

    const primaryNav = screen.getByRole("navigation", { name: "Mode" });
    fireEvent.click(within(primaryNav).getByRole("button", { name: "New chat" }));

    const s = useAppStore.getState();
    expect(s.activeId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.draftProjectId).toBe("proj-filtered");
    expect(s.draftWorkspacePath).toBe("/Users/x/code/current");
  });

  it("renders Codex primary nav with the work sidebar body", () => {
    renderWithRouter(<AppSidebar />, ["/projects/overview"]);

    const primaryNav = screen.getByRole("navigation", { name: "Mode" });
    expect(within(primaryNav).getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plugins" })).toHaveAttribute("href", "/customize");
    expect(screen.getByRole("link", { name: "Automation" })).toHaveAttribute("href", "/projects/auto-mode");
    expect(screen.getByRole("link", { name: "Doc" })).toHaveAttribute("href", "/docs");
    expect(screen.queryByText("Code")).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Overview" })).toHaveClass("active");
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
