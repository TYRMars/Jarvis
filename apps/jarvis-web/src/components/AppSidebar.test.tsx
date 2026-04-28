import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppSidebar } from "./AppSidebar";
import { useAppStore } from "../store/appStore";

afterEach(() => {
  // Reset toggle state so cross-test ordering doesn't leak.
  useAppStore.getState().setSidebarOpen(true);
});

describe("AppSidebar search", () => {
  it("filters conversations from the restored search box", () => {
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

    render(<AppSidebar />);

    const input = screen.getByRole("searchbox", {
      name: "Search conversations",
    });
    fireEvent.change(input, { target: { value: "beta" } });

    expect(screen.queryByText("Alpha planning")).not.toBeInTheDocument();
    expect(screen.getByText("Beta bugfix")).toBeInTheDocument();
  });

  it("focuses the sidebar search from the topbar search button", () => {
    render(<AppSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByRole("searchbox", { name: "Search conversations" })).toHaveFocus();
  });
});

describe("AppSidebar collapse", () => {
  it("toggles the sidebar-closed body class and persists the state", () => {
    render(<AppSidebar />);

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
