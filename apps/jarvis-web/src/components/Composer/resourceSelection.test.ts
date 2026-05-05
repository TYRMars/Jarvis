import { describe, expect, it } from "vitest";
import {
  compactResourceLabel,
  dedupeByPath,
  deriveProjectDraftFromWorkspace,
  folderNameFromPath,
  matchProjectsForWorkspace,
  resolveDefaultWorkspaceForProject,
  samePath,
  slugify,
} from "./resourceSelection";
import type { Project } from "../../types/frames";

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p-1",
    slug: "jarvis",
    name: "Jarvis",
    description: null,
    instructions: "",
    tags: [],
    workspaces: [],
    archived: false,
    created_at: "2026-05-05T11:00:00Z",
    updated_at: "2026-05-05T11:00:00Z",
    ...over,
  };
}

describe("folderNameFromPath", () => {
  it("returns the basename of a unix path", () => {
    expect(folderNameFromPath("/Users/a/code/Jarvis")).toBe("Jarvis");
  });
  it("strips a trailing slash", () => {
    expect(folderNameFromPath("/Users/a/code/Jarvis/")).toBe("Jarvis");
  });
  it("handles a path with no separator", () => {
    expect(folderNameFromPath("Jarvis")).toBe("Jarvis");
  });
  it("handles CJK / mixed-script basenames", () => {
    expect(folderNameFromPath("/Users/a/项目/Jarvis-中")).toBe("Jarvis-中");
  });
  it("handles backslash separators (Windows)", () => {
    expect(folderNameFromPath("C:\\code\\Jarvis")).toBe("Jarvis");
  });
  it("returns empty for empty input", () => {
    expect(folderNameFromPath("")).toBe("");
  });
});

describe("samePath", () => {
  it("matches identical paths", () => {
    expect(samePath("/a/b", "/a/b")).toBe(true);
  });
  it("ignores trailing slash differences", () => {
    expect(samePath("/a/b/", "/a/b")).toBe(true);
  });
  it("treats different paths as different", () => {
    expect(samePath("/a/b", "/a/c")).toBe(false);
  });
});

describe("matchProjectsForWorkspace", () => {
  it("returns path_match when path already belongs to a project", () => {
    const a = project({
      id: "p-a",
      workspaces: [{ path: "/Users/a/Jarvis" }],
    });
    const b = project({ id: "p-b", workspaces: [{ path: "/Users/b/other" }] });
    const out = matchProjectsForWorkspace([a, b], "/Users/a/Jarvis", "Jarvis");
    expect(out.kind).toBe("path_match");
    if (out.kind === "path_match") {
      expect(out.project.id).toBe("p-a");
      expect(out.workspace.path).toBe("/Users/a/Jarvis");
    }
  });

  it("returns name_match_unique when basename matches one project", () => {
    const a = project({ id: "p-a", name: "Jarvis", slug: "jarvis" });
    const b = project({ id: "p-b", name: "Other", slug: "other" });
    const out = matchProjectsForWorkspace([a, b], "/new/Jarvis", "Jarvis");
    expect(out.kind).toBe("name_match_unique");
    if (out.kind === "name_match_unique") {
      expect(out.project.id).toBe("p-a");
    }
  });

  it("returns name_match_ambiguous when basename matches multiple projects", () => {
    const a = project({ id: "p-a", name: "Jarvis", slug: "jarvis" });
    const b = project({ id: "p-b", name: "Jarvis", slug: "jarvis-2" });
    const out = matchProjectsForWorkspace([a, b], "/new/Jarvis", "Jarvis");
    expect(out.kind).toBe("name_match_ambiguous");
    if (out.kind === "name_match_ambiguous") {
      expect(out.projects).toHaveLength(2);
    }
  });

  it("returns none when nothing matches", () => {
    const a = project({ id: "p-a", name: "Foo", slug: "foo" });
    const out = matchProjectsForWorkspace([a], "/new/Jarvis", "Jarvis");
    expect(out.kind).toBe("none");
  });

  it("does not auto-merge by basename across path-bound projects", () => {
    // Two projects with the same name but neither claims the new path
    // — must be ambiguous, not silently picked.
    const a = project({
      id: "p-a",
      name: "Jarvis",
      slug: "jarvis",
      workspaces: [{ path: "/Users/a/Jarvis" }],
    });
    const b = project({
      id: "p-b",
      name: "Jarvis",
      slug: "jarvis-2",
      workspaces: [{ path: "/Users/b/Jarvis" }],
    });
    const out = matchProjectsForWorkspace([a, b], "/Desktop/Jarvis", "Jarvis");
    expect(out.kind).toBe("name_match_ambiguous");
  });
});

describe("deriveProjectDraftFromWorkspace", () => {
  it("derives name + slug from the basename", () => {
    const out = deriveProjectDraftFromWorkspace({ root: "/Users/a/code/Jarvis" });
    expect(out.name).toBe("Jarvis");
    expect(out.slug).toBe("jarvis");
    expect(out.instructions).toContain("Workspace: /Users/a/code/Jarvis");
  });

  it("falls back to 'untitled' when basename is empty", () => {
    const out = deriveProjectDraftFromWorkspace({ root: "" });
    expect(out.name).toBe("untitled");
    expect(out.slug).toBe("untitled");
  });

  it("supports multi-folder via deriveProjectDraftFromWorkspaces", async () => {
    const { deriveProjectDraftFromWorkspaces } = await import(
      "./resourceSelection"
    );
    const out = deriveProjectDraftFromWorkspaces([
      "/Users/a/code/Jarvis",
      "/Users/a/notes",
      "/Users/a/scripts",
    ]);
    expect(out.name).toBe("Jarvis"); // first folder drives the name
    expect(out.slug).toBe("jarvis");
    // All paths enumerated under "Workspaces:"
    expect(out.instructions).toContain("Workspaces:");
    expect(out.instructions).toContain("- /Users/a/code/Jarvis");
    expect(out.instructions).toContain("- /Users/a/notes");
    expect(out.instructions).toContain("- /Users/a/scripts");
  });
});

describe("slugify", () => {
  it("lowercases and replaces non-alphanumerics", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });
  it("strips leading and trailing dashes", () => {
    expect(slugify("--A b--")).toBe("a-b");
  });
  it("returns 'untitled' for an empty result", () => {
    expect(slugify("---")).toBe("untitled");
  });
});

describe("resolveDefaultWorkspaceForProject", () => {
  it("returns the first workspace when present", () => {
    const p = project({
      workspaces: [{ path: "/a/b" }, { path: "/a/c" }],
    });
    expect(resolveDefaultWorkspaceForProject(p, "/baseline")).toBe("/a/b");
  });
  it("falls back to baseline when no workspaces", () => {
    expect(resolveDefaultWorkspaceForProject(project(), "/base")).toBe("/base");
  });
  it("returns null when nothing is available", () => {
    expect(resolveDefaultWorkspaceForProject(project(), null)).toBeNull();
  });
});

describe("compactResourceLabel", () => {
  it("returns input unchanged when short", () => {
    expect(compactResourceLabel("/short")).toBe("/short");
  });
  it("keeps the trailing two segments when long", () => {
    expect(
      compactResourceLabel("/very/long/nested/path/to/the/Jarvis", 20),
    ).toBe("…/the/Jarvis");
  });
});

describe("dedupeByPath", () => {
  it("removes entries with the same canonical path", () => {
    const out = dedupeByPath([
      { path: "/a/b" },
      { path: "/a/b/" },
      { path: "/a/c" },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.path)).toEqual(["/a/b", "/a/c"]);
  });
});
