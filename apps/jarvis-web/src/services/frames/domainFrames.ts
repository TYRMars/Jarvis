// Cross-domain mirroring frames. Persistent project TODOs and
// per-project Requirement / Doc kanban frames travel down the same
// WS but mutate state owned by the matching service module rather
// than the chat surface; this file is just the routing layer.

import { appStore } from "../../store/appStore";
import {
  applyRequirementDeleted,
  applyRequirementUpserted,
} from "../requirements";
import {
  applyDocDraftUpserted,
  applyDocProjectDeleted,
  applyDocProjectUpserted,
} from "../docs";

export const domainFrameHandlers: Record<string, (ev: any) => void> = {
  // ---- Persistent TODO board frames ----
  todo_upserted: (ev) => {
    if (ev.todo) appStore.getState().upsertTodo(ev.todo);
  },
  todo_deleted: (ev) => {
    if (typeof ev.id === "string") appStore.getState().removeTodo(ev.id);
  },
  // ---- Per-project Requirement kanban frames ----
  requirement_upserted: (ev) => {
    if (ev.requirement) applyRequirementUpserted(ev.requirement);
  },
  requirement_deleted: (ev) => {
    if (typeof ev.id === "string" && typeof ev.project_id === "string") {
      applyRequirementDeleted(ev.id, ev.project_id);
    }
  },
  // ---- Doc workspace frames ----
  doc_project_upserted: (ev) => {
    if (ev.project) applyDocProjectUpserted(ev.project);
  },
  doc_project_deleted: (ev) => {
    if (typeof ev.id === "string") applyDocProjectDeleted(ev.id);
  },
  doc_draft_upserted: (ev) => {
    if (ev.draft) applyDocDraftUpserted(ev.draft);
  },
};
