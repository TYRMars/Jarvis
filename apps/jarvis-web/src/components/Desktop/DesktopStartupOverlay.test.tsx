import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopStartupOverlay } from "./DesktopStartupOverlay";

type DesktopStatus = {
  api_origin: string;
  server_running: boolean;
  workspace?: string | null;
  logs: string[];
  last_error?: string | null;
};

function installTauriMock(handler: (cmd: string, args?: any) => unknown) {
  // Real Tauri `invoke` returns a Promise; wrap the (sync) handler
  // result in `Promise.resolve` rather than `async (...) => handler(...)`,
  // which lint flags because the arrow has no `await` to justify the
  // `async` keyword.
  (window as any).__TAURI__ = {
    core: {
      invoke: vi.fn((cmd: string, args?: any) => Promise.resolve(handler(cmd, args))),
    },
  };
}

function uninstallTauriMock() {
  delete (window as any).__TAURI__;
}

afterEach(() => {
  uninstallTauriMock();
  sessionStorage.clear();
  cleanup();
});

describe("DesktopStartupOverlay", () => {
  it("renders nothing in a plain browser (no Tauri runtime)", async () => {
    const { container } = render(<DesktopStartupOverlay />);
    // Give effects a tick.
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("stays hidden when the sidecar is healthy", async () => {
    const status: DesktopStatus = {
      api_origin: "http://127.0.0.1:7001",
      server_running: true,
      workspace: "/tmp/work",
      logs: [],
      last_error: null,
    };
    installTauriMock(() => status);

    const { container } = render(<DesktopStartupOverlay />);
    await waitFor(() => {
      expect((window as any).__TAURI__.core.invoke).toHaveBeenCalled();
    });
    expect(container.querySelector(".desktop-startup-overlay")).toBeNull();
  });

  it("shows the non-modal recovery panel when the sidecar is down and retries on click", async () => {
    let status: DesktopStatus = {
      api_origin: "http://127.0.0.1:7001",
      server_running: false,
      workspace: "/tmp/work",
      logs: ["[server] boom"],
      last_error: "sidecar did not become healthy",
    };
    const recovered: DesktopStatus = {
      ...status,
      server_running: true,
      last_error: null,
    };
    installTauriMock((cmd, _args) => {
      if (cmd === "restart_server") {
        status = recovered;
        return recovered;
      }
      return status;
    });

    render(<DesktopStartupOverlay />);
    await screen.findByRole("region", { name: /Local Jarvis server unavailable/ });
    expect(screen.queryByText(/sidecar did not become healthy/)).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /Local Jarvis server unavailable/ })).toBeNull();
    });
  });

  it("can be dismissed without recovering the sidecar", async () => {
    installTauriMock(() => ({
      api_origin: "http://127.0.0.1:7001",
      server_running: false,
      workspace: "/tmp/work",
      logs: [],
      last_error: "OPENAI_API_KEY missing",
    }));

    render(<DesktopStartupOverlay />);
    await screen.findByRole("region", { name: /Local Jarvis server unavailable/ });

    fireEvent.click(screen.getByRole("button", { name: /Continue using Jarvis/ }));

    expect(screen.queryByRole("region", { name: /Local Jarvis server unavailable/ })).toBeNull();
  });

  it("opens provider settings through the desktop HashRouter route", async () => {
    installTauriMock(() => ({
      api_origin: "http://127.0.0.1:7001",
      server_running: false,
      workspace: "/tmp/work",
      logs: [],
      last_error: "OPENAI_API_KEY missing",
    }));
    window.history.replaceState(null, "", "/");

    render(<DesktopStartupOverlay />);
    await screen.findByRole("region", { name: /Local Jarvis server unavailable/ });

    fireEvent.click(screen.getByRole("button", { name: /Provider/i }));

    expect(window.location.hash).toBe("#/settings");
    expect(sessionStorage.getItem("jarvis.settings.target")).toBe(JSON.stringify({ id: "models" }));
  });

  it("expands the compact status into full diagnostics", async () => {
    installTauriMock(() => ({
      api_origin: "http://127.0.0.1:7001",
      server_running: false,
      workspace: "/tmp/work",
      logs: [],
      last_error: "OPENAI_API_KEY missing",
    }));

    render(<DesktopStartupOverlay />);
    await screen.findByRole("region", { name: /Local Jarvis server unavailable/ });
    expect(screen.queryByText(/OPENAI_API_KEY missing/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Details/ }));

    expect(await screen.findByText(/OPENAI_API_KEY missing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Configure provider/i })).toBeInTheDocument();
  });
});
