const ROADMAP_SOURCE_RE = /^\s*<!--\s*roadmap-source:\s*([^>]+?)\s*-->\s*\n?/i;

export interface RoadmapDescription {
  text: string;
  source: string | null;
}

export function parseRoadmapDescription(raw: string | null | undefined): RoadmapDescription {
  const text = raw?.trim() ?? "";
  if (!text) return { text: "", source: null };
  const match = ROADMAP_SOURCE_RE.exec(text);
  if (!match) return { text: stripRoadmapMetadata(text), source: null };
  const body = text.slice(match[0].length).trim();
  return {
    text: stripRoadmapMetadata(body),
    source: match[1].trim() || null,
  };
}

function stripRoadmapMetadata(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  let firstBody = 0;
  while (
    firstBody < paragraphs.length &&
    /^(Status|Owner|Related):/i.test(paragraphs[firstBody].trim())
  ) {
    firstBody += 1;
  }
  return paragraphs.slice(firstBody).join("\n\n").trim();
}
