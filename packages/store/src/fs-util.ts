// Shared filesystem helpers for the JSON-file store backends. The
// conversation store keeps its `readJsonFile` / `isNotFound` private; the
// project-store family needs the same primitives, so they live here (next to
// the re-exported `atomicWrite` / `ensureDir` / `encodeId` in json-file.ts).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** True for an ENOENT (missing path) error. */
export function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Read + parse a JSON file; undefined if missing, a directory, or unparseable. */
export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(filePath, "utf8");
  } catch (e) {
    if (isNotFound(e) || (e as { code?: string }).code === "EISDIR") return undefined;
    throw e;
  }
  try {
    return JSON.parse(bytes) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read every `<id>.json` (skipping `.json.tmp`, directories, and unparseable
 * files) directly under `dir`, returning the parsed rows. A missing directory
 * yields an empty list (graceful ENOENT). Order is filesystem-dependent;
 * callers sort.
 */
export async function readJsonDir<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
    const row = await readJsonFile<T>(path.join(dir, name));
    if (row !== undefined) out.push(row);
  }
  return out;
}

/**
 * List the immediate subdirectory names under `root`. Missing root yields an
 * empty list (graceful ENOENT). Used by the id-walk lookups (`get` / `delete`)
 * that must scan every partition subdir for a globally-unique id.
 */
export async function listSubdirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

/** Newest-first comparator over an RFC-3339 string field (lexicographic). */
export function byDescString(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}
