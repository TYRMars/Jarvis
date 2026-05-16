// Composer chip surfaces server-predicted next-turn skill
// auto-activations. Renders nothing when the list is empty so a
// quiet session doesn't pay for chrome.

import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useAppStore } from "../../store/appStore";
import { AutoActivatedSkillsChip } from "./AutoActivatedSkillsChip";

beforeEach(() => {
  useAppStore.getState().setAutoActivatedNextTurnSkills([]);
});

describe("AutoActivatedSkillsChip", () => {
  it("renders nothing on an empty list", () => {
    const { container } = render(<AutoActivatedSkillsChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one pill per skill name", () => {
    act(() => {
      useAppStore.getState().setAutoActivatedNextTurnSkills([
        "rs-helper",
        "tsx-helper",
      ]);
    });
    render(<AutoActivatedSkillsChip />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /Auto-activated for next turn/i,
    );
    expect(screen.getByText("rs-helper")).toBeInTheDocument();
    expect(screen.getByText("tsx-helper")).toBeInTheDocument();
  });

  it("dedupes and skips blanks via store action", () => {
    act(() => {
      useAppStore.getState().setAutoActivatedNextTurnSkills([
        "rs-helper",
        "rs-helper",
        "",
        "  ",
        "tsx-helper",
      ]);
    });
    render(<AutoActivatedSkillsChip />);
    // Each pill text appears once.
    expect(screen.getAllByText("rs-helper")).toHaveLength(1);
    expect(screen.getAllByText("tsx-helper")).toHaveLength(1);
  });
});
