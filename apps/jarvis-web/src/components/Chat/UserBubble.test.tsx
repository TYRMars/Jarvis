import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/appStore";
import { UserBubble } from "./UserBubble";

const sendFrameMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../services/socket", () => ({
  isOpen: () => true,
  sendFrame: (frame: unknown) => {
    sendFrameMock(frame);
    return true;
  },
}));

beforeEach(() => {
  sendFrameMock.mockClear();
  useAppStore.getState().setLang("en");
});

describe("UserBubble", () => {
  it("edits and reruns with the submitted content instead of the visible summary", () => {
    const submittedContent = [
      "summarize",
      "Attached files:",
      "",
      '<attached-file name="notes.txt" type="text/plain" size="10">',
      "alpha",
      "beta",
      "</attached-file>",
    ].join("\n");

    render(
      <UserBubble
        uid="u1"
        content={"summarize\n\nAttached files:\n- notes.txt (10 B)"}
        submittedContent={submittedContent}
        userOrdinal={2}
      />,
    );

    fireEvent.click(screen.getByLabelText("Edit and rerun"));

    const editor = screen.getByRole("textbox");
    expect(editor).toHaveValue(submittedContent);
    expect((editor as HTMLTextAreaElement).value).toContain("<attached-file");

    fireEvent.click(screen.getByRole("button", { name: "Rerun" }));

    expect(sendFrameMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "fork",
      user_ordinal: 2,
      content: submittedContent,
    }));
  });
});
