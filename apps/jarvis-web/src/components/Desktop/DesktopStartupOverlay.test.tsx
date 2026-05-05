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

  it("shows the recovery card when the sidecar is down and retries on click", async () => {
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
    await screen.findByRole("alertdialog");
    expect(screen.getByText(/sidecar did not become healthy/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });
});
