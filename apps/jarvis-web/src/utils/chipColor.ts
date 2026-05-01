// Deterministic colour from a project slug, so a chip looks the same
// every session without the server tracking colour. Hash → HSL.
export function chipColor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}deg 55% 55%)`;
}
