// Behaviour tests for the two-step deny dance + the post-click
// "sent" lock that prevents a double-approve from racing the WS
// echo. The actual `sendFrame` is mocked because the WS isn't open
// in jsdom and we just want to count outbound frames.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useAppStore } from "../../store/appStore";
import { ApprovalCard } from "./ApprovalCard";

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/socket", () => ({
  isOpen: () => true,
  sendFrame: (frame: any) => {
    sendMock(frame);
    return true;
  },
}));

beforeEach(() => {
  sendMock.mockClear();
});

function pending(id = "call_1", name = "shell.exec") {
  useAppStore.getState().pushApprovalRequest(id, name, { command: "ls" });
  const entry = useAppStore.getState().approvals.find((c) => c.id === id)!;
  return entry;
}

describe("ApprovalCard", () => {
  it("first Approve click sends a single approve frame", () => {
    render(<ApprovalCard entry={pending()} />);
    fireEvent.click(screen.getByText(/^Approve$/));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({ type: "approve", tool_call_id: "call_1" });
  });

  it("second Approve click is suppressed by the `sent` lock", () => {
    render(<ApprovalCard entry={pending()} />);
    const approve = screen.getByText(/^Approve$/);
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("Deny is two-step: first arms, second sends", () => {
    render(<ApprovalCard entry={pending()} />);
    const deny = screen.getByText(/^Deny$/);
    fireEvent.click(deny);
    // After arming, the buttons relabel to Cancel / Confirm deny.
    expect(screen.getByText(/Cancel/)).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Confirm deny/));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      type: "deny",
      tool_call_id: "call_1",
      reason: null,
    });
  });

  it("Cancel after arming Deny clears the intent without sending", () => {
    render(<ApprovalCard entry={pending()} />);
    fireEvent.click(screen.getByText(/^Deny$/));
    fireEvent.click(screen.getByText(/^Cancel$/));
    // Buttons are back to their original labels.
    expect(screen.getByText(/^Approve$/)).toBeInTheDocument();
    expect(screen.getByText(/^Deny$/)).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("entries already decided render their buttons disabled", () => {
    const entry = pending();
    useAppStore.getState().setApprovalDecision(entry.id, "approve");
    const updated = useAppStore.getState().approvals.find((c) => c.id === entry.id)!;
    render(<ApprovalCard entry={updated} />);
    const approve = screen.getByText(/^Approve$/);
    const deny = screen.getByText(/^Deny$/);
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
  });
});
