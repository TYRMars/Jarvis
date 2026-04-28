// Smoke tests for the change-report aggregator. We seed
// `appStore.tasks` directly (since the report component subscribes
// to it) and assert that:
//
//   • files are deduped by path across multiple fs.* calls
//   • shell.exec entries get a coarse "kind" classification
//   • the empty state renders when no tasks exist
//
// We don't snapshot the markup — colour and chip layout are CSS
// concerns; the test cares about behaviour.

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "../../store/appStore";
import { ChangeReport } from "./ChangeReport";

function task(over: Partial<{
  id: string;
  name: string;
  args: any;
  status: "running" | "ok" | "error" | "denied";
}>) {
  return {
    id: over.id ?? "t1",
    name: over.name ?? "fs.edit",
    args: over.args ?? { path: "src/foo.rs" },
    status: (over.status ?? "ok") as any,
    startedAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  useAppStore.setState({ tasks: [] }, false);
});

describe("ChangeReport", () => {
  it("shows the empty state when no tasks exist", () => {
    render(<ChangeReport />);
    expect(
      screen.getByText(/No edits or checks yet|还没有编辑/),
    ).toBeInTheDocument();
  });

  it("dedupes files across repeated fs.edit calls", () => {
    useAppStore.setState({
      tasks: [
        task({ id: "1", name: "fs.edit", args: { path: "src/foo.rs" } }),
        task({ id: "2", name: "fs.edit", args: { path: "src/foo.rs" } }),
        task({ id: "3", name: "fs.write", args: { path: "src/bar.rs" } }),
      ],
    }, false);
    render(<ChangeReport />);
    // foo.rs appears once even though we touched it twice.
    expect(screen.getAllByText("src/foo.rs")).toHaveLength(1);
    expect(screen.getByText("src/bar.rs")).toBeInTheDocument();
  });

  it("classifies shell.exec commands as test / lint / build / shell", () => {
    useAppStore.setState({
      tasks: [
        task({ id: "1", name: "shell.exec", args: { command: "cargo test --workspace" } }),
        task({ id: "2", name: "shell.exec", args: { command: "cargo clippy --workspace" } }),
        task({ id: "3", name: "shell.exec", args: { command: "cargo build --release" } }),
        task({ id: "4", name: "shell.exec", args: { command: "echo hi" } }),
      ],
    }, false);
    render(<ChangeReport />);
    // Each kind chip appears as upper-case text.
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("shell")).toBeInTheDocument();
  });

  it("extracts file path from fs.patch unified-diff args", () => {
    useAppStore.setState({
      tasks: [
        task({
          id: "1",
          name: "fs.patch",
          args: {
            diff:
              "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@\n-old\n+new\n",
          },
        }),
      ],
    }, false);
    render(<ChangeReport />);
    expect(screen.getByText("src/lib.rs")).toBeInTheDocument();
  });

  it("denied tools are reflected in the summary line", () => {
    useAppStore.setState({
      tasks: [
        task({ id: "1", name: "fs.edit", args: { path: "a.rs" }, status: "ok" }),
        task({ id: "2", name: "shell.exec", args: { command: "rm x" }, status: "denied" }),
      ],
    }, false);
    render(<ChangeReport />);
    expect(screen.getByText(/1 allowed, 1 denied|1 项放行/)).toBeInTheDocument();
  });
});
