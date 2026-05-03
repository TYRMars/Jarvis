// "System" super-section. Combines the four read-only / low-density
// system-status sections (Workspace, Server runtime, backend
// Connection origin, About) into one routed section. Frees up
// four nav slots for things that actually need them.

import { Section } from "./Section";
import { Tabs, type TabItem } from "../../ui/Tabs";
import { WorkspaceSection } from "./WorkspaceSection";
import { ServerSection } from "./ServerSection";
import { ApiSection } from "./ApiSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { AboutSection } from "./AboutSection";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export const SYSTEM_TABS = ["workspace", "server", "api", "diagnostics", "about"] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];
export const DEFAULT_SYSTEM_TAB: SystemTab = "workspace";

interface Props {
  tab?: SystemTab;
  onTabChange?: (tab: SystemTab) => void;
}

export function SystemSection({ tab, onTabChange }: Props = {}) {
  const items: TabItem[] = [
    {
      id: "workspace",
      label: tx("settingsTabWorkspace", "Workspace"),
      content: <WorkspaceSection embedded />,
    },
    {
      id: "server",
      label: tx("settingsTabServer", "Server"),
      content: <ServerSection embedded />,
    },
    {
      id: "api",
      label: tx("settingsTabApi", "Connection"),
      content: <ApiSection embedded />,
    },
    {
      id: "diagnostics",
      label: tx("settingsTabDiagnostics", "Diagnostics"),
      content: <DiagnosticsSection embedded />,
    },
    {
      id: "about",
      label: tx("settingsTabAbout", "About"),
      content: <AboutSection embedded />,
    },
  ];

  return (
    <Section
      id="system"
      titleKey="settingsSystemTitle"
      titleFallback="System"
      descKey="settingsSystemDesc"
      descFallback="Workspace, server runtime, backend connection, and version info."
    >
      <Tabs
        items={items}
        value={tab ?? DEFAULT_SYSTEM_TAB}
        onChange={(id) => onTabChange?.(id as SystemTab)}
        ariaLabel={tx("settingsSystemTitle", "System")}
      />
    </Section>
  );
}
