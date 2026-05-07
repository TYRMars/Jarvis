// Toggle extension entry point — registers its markdown handler
// at module load just like Callout.

import { registerHandler } from "../../markdown";
import type { SlashCandidate } from "../slashMenu/candidates";
import { toggleHandler } from "./markdown";

registerHandler(toggleHandler);

export { Toggle, ToggleSummary, ToggleContent } from "./Toggle";
export { toggleHandler } from "./markdown";

/** Slash-menu entry for inserting an empty Toggle. */
export function toggleCandidate(): SlashCandidate {
  return {
    id: "toggle",
    title: "Toggle",
    description: "可折叠区块",
    keywords: ["toggle", "details", "fold", "collapse", "折叠", "详情"],
    icon: "▶",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setToggle({ open: true }).run();
    },
  };
}
