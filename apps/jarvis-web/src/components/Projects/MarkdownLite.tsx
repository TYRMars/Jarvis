import type { ReactNode } from "react";

// Tiny markdown renderer: handles fenced code blocks, headings (## /
// ### → small bold caption), bullet lists, **bold**, and `inline code`.
// Not a spec-compliant parser — just enough to make our PR-style
// requirement cards readable instead of showing raw `##` markers.
//
// Distinct from `Chat/MarkdownView.tsx` (full markdown via
// `@ant-design/x-markdown`) — this one stays in-process / no-deps so
// it can render hundreds of cards on the kanban without overhead.
export function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key++} className="md-pre">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{2,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(
        <div key={key++} className="md-h">
          {heading[2].trim()}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(line)}
      </p>,
    );
    i++;
  }
  return <>{blocks}</>;
}

function renderInline(s: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code key={key++} className="md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
