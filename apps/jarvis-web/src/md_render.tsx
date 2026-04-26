import { XMarkdown } from "@ant-design/x-markdown";
import { createRoot, type Root } from "react-dom/client";

const roots = new WeakMap<Element, Root>();

export function renderMarkdownInto(container: HTMLElement, content: string, streaming = false) {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }

  root.render(
    <XMarkdown
      className="jarvis-x-markdown"
      content={content || ""}
      escapeRawHtml
      openLinksInNewTab
      streaming={{ hasNextChunk: streaming, tail: false }}
    />,
  );
}
