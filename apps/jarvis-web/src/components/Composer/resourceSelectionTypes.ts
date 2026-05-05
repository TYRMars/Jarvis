// Discriminated union returned by the resource-manager dialog on
// confirm. The composer integration converts each variant into the
// store's `draftProjectId` / `draftWorkspacePath` pair (and possibly
// a `POST /v1/projects` for the `new_project_from_folder` flavour).
//
// Mirrors `docs/proposals/new-session-resource-manager.zh-CN.md`
// § "Resource Selection". The wire shape never travels — this is
// purely a frontend handoff between the dialog and the composer.

export interface ProjectDraft {
  name: string;
  slug?: string;
  instructions?: string;
}

export type NewSessionResourceSelection =
  | {
      mode: "free_chat";
      workspacePath: string | null;
      projectId: null;
    }
  | {
      mode: "existing_project";
      projectId: string;
      workspacePath: string | null;
    }
  | {
      mode: "new_project_from_folder";
      projectDraft: ProjectDraft;
      /// One or more folder paths. The first entry is also the
      /// session's pinned workspace; the rest become additional
      /// project-level workspace folders. Single-folder callers wrap
      /// in a 1-element array — there's only one variant on the
      /// wire so the dialog and consumers don't fork on cardinality.
      workspacePaths: string[];
    };

export type ResourceDialogTab = "recent" | "projects" | "folders";
