// Auto-scrolling pre for live streaming output. Pinned to the
// bottom while new chunks arrive so the user sees the latest
// bytes; user can still scroll up — the auto-scroll only kicks
// in when they're already near the bottom.

import { useEffect, useRef } from "react";

export function ToolStreamingOutput({ content }: { content: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [content]);
  return <pre ref={ref} className="tool-pre tool-pre-streaming">{content}</pre>;
}
