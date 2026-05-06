import { isDesktopRuntime, selectDesktopWorkspace } from "./desktop";
import { findWorkspaceByName } from "./workspace";

export interface WorkspaceFolderPick {
  path: string | null;
  candidates: string[];
  unresolvedName?: string;
}

export function supportsWorkspaceFolderPicker(): boolean {
  if (isDesktopRuntime()) return true;
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === "function"
  );
}

export async function pickWorkspaceFolder(): Promise<WorkspaceFolderPick> {
  if (isDesktopRuntime()) {
    const path = await selectDesktopWorkspace();
    return { path, candidates: path ? [path] : [] };
  }

  const picker = (window as unknown as {
    showDirectoryPicker?: () => Promise<{ name: string }>;
  }).showDirectoryPicker;
  if (typeof picker !== "function") {
    return { path: null, candidates: [] };
  }

  const handle = await picker();
  const found = await findWorkspaceByName(handle.name);
  if (found.length === 0) {
    return {
      path: `~/${handle.name}`,
      candidates: [],
      unresolvedName: handle.name,
    };
  }
  return {
    path: found[0],
    candidates: found,
  };
}
