import type { Requirement, RequirementStatus } from "../types/frames";

const REQUIREMENTS_KEY = "jarvis.productRequirements.v1";

export interface CreateRequirementInput {
  projectId: string;
  title: string;
  description?: string;
}

export function listRequirements(projectId: string): Requirement[] {
  return readRequirements()
    .filter((r) => r.project_id === projectId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function createRequirement(input: CreateRequirementInput): Requirement {
  const now = new Date().toISOString();
  const req: Requirement = {
    id: `req-${randomId()}`,
    project_id: input.projectId,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    status: "backlog",
    conversation_ids: [],
    created_at: now,
    updated_at: now,
  };
  writeRequirements([req, ...readRequirements()]);
  return req;
}

export function updateRequirement(
  id: string,
  patch: Partial<Pick<Requirement, "title" | "description" | "conversation_ids">> & {
    status?: RequirementStatus;
  },
): Requirement | null {
  let found: Requirement | null = null;
  const rows = readRequirements().map((r) => {
    if (r.id !== id) return r;
    found = {
      ...r,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    return found;
  });
  if (found) writeRequirements(rows);
  return found;
}

export function linkRequirementConversation(id: string, conversationId: string): Requirement | null {
  const row = readRequirements().find((r) => r.id === id);
  if (!row) return null;
  if (row.conversation_ids.includes(conversationId)) return row;
  return updateRequirement(id, {
    conversation_ids: [conversationId, ...row.conversation_ids],
  });
}

function readRequirements(): Requirement[] {
  try {
    const raw = localStorage.getItem(REQUIREMENTS_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeRequirements(rows: Requirement[]): void {
  localStorage.setItem(REQUIREMENTS_KEY, JSON.stringify(rows));
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
