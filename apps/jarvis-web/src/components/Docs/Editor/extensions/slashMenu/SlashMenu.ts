// Tiptap extension: slash-menu via @tiptap/suggestion + a React
// popover (SlashMenuList). The popover is mounted into a portal
// node attached to <body> so it isn't clipped by the editor host's
// overflow.

import { Extension } from "@tiptap/core";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { createRoot, type Root } from "react-dom/client";
import { createElement, createRef } from "react";
import {
  filterCandidates,
  STANDARD_CANDIDATES,
  type SlashCandidate,
} from "./candidates";
import { SlashMenuList, type SlashMenuListHandle } from "./SlashMenuList";

type RendererProps = SuggestionProps<SlashCandidate>;

export interface SlashMenuOptions {
  /** Trigger character. Default `/`. */
  char: string;
  /** Override the candidate registry. Defaults to STANDARD_CANDIDATES. */
  candidates: readonly SlashCandidate[];
}

export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: "slashMenu",

  addOptions() {
    return {
      char: "/",
      candidates: STANDARD_CANDIDATES,
    };
  },

  addProseMirrorPlugins() {
    const candidates = this.options.candidates;
    return [
      Suggestion({
        editor: this.editor,
        char: this.options.char,
        startOfLine: false,
        // Hand back the picked candidate's command — see render()
        // below for where `props` is filled in.
        command: ({ editor, range, props }) => {
          (props as SlashCandidate).command({ editor, range });
        },
        items: ({ query }) => filterCandidates(candidates, query),
        render: () => makeRenderer(),
      } satisfies SuggestionOptions<SlashCandidate>),
    ];
  },
});

function makeRenderer(): {
  onStart: (props: RendererProps) => void;
  onUpdate: (props: RendererProps) => void;
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
  onExit: () => void;
} {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  const ref = createRef<SlashMenuListHandle>();
  let lastClientRect: SuggestionProps<SlashCandidate>["clientRect"] = null;

  const render = (props: RendererProps) => {
    if (!root) return;
    root.render(
      createElement(SlashMenuList, {
        ref,
        items: props.items,
        onPick: (index) => {
          const picked = props.items[index];
          if (picked) props.command(picked);
        },
        getReferenceRect: () => (lastClientRect ? (lastClientRect() ?? null) : null),
      }),
    );
  };

  return {
    onStart(props) {
      lastClientRect = props.clientRect ?? null;
      host = document.createElement("div");
      host.className = "slash-menu-portal";
      document.body.appendChild(host);
      root = createRoot(host);
      render(props);
    },
    onUpdate(props) {
      lastClientRect = props.clientRect ?? null;
      render(props);
    },
    onKeyDown({ event }) {
      if (event.key === "Escape") {
        return true;
      }
      return ref.current?.onKeyDown(event) ?? false;
    },
    onExit() {
      root?.unmount();
      root = null;
      host?.remove();
      host = null;
      lastClientRect = null;
    },
  };
}
