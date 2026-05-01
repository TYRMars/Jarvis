// Monotonic uid generator shared across slices. `<MessageList>`
// keys React entries off these strings; tests in
// `appStore.test.ts` rely on the `<prefix>_<base36>_<seq>` format
// being stable across slice boundaries.

let uidSeq = 0;

export function nextUid(prefix: string): string {
  uidSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidSeq}`;
}

export function isAskToolName(name: string | undefined): boolean {
  return typeof name === "string" && name.startsWith("ask.");
}
