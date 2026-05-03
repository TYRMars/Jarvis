// "Extensions" super-section. Three different mechanisms for
// loading capabilities into Jarvis at runtime — MCP servers, Skill
// packs, and Plugins — share an "extension" concept from the
// user's POV, so they live behind one nav item with internal
// tabs. Each tab is the original section component embedded.

import { Section } from "./Section";
import { Tabs, type TabItem } from "../../ui/Tabs";
import { McpSection } from "./McpSection";
import { SkillsSection } from "./SkillsSection";
import { PluginsSection } from "./PluginsSection";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export const EXTENSIONS_TABS = ["mcp", "skills", "plugins"] as const;
export type ExtensionsTab = (typeof EXTENSIONS_TABS)[number];
export const DEFAULT_EXTENSIONS_TAB: ExtensionsTab = "mcp";

interface Props {
  tab?: ExtensionsTab;
  onTabChange?: (tab: ExtensionsTab) => void;
}

export function ExtensionsSection({ tab, onTabChange }: Props = {}) {
  const items: TabItem[] = [
    {
      id: "mcp",
      label: tx("settingsTabMcp", "MCP servers"),
      content: <McpSection embedded />,
    },
    {
      id: "skills",
      label: tx("settingsTabSkills", "Skills"),
      content: <SkillsSection embedded />,
    },
    {
      id: "plugins",
      label: tx("settingsTabPlugins", "Plugins"),
      content: <PluginsSection embedded />,
    },
  ];

  return (
    <Section
      id="extensions"
      titleKey="settingsExtensionsTitle"
      titleFallback="Extensions"
      descKey="settingsExtensionsDesc"
      descFallback="Capabilities Jarvis loads on top of the built-in tools — runtime MCP servers, skill packs, and bundled plugins."
    >
      <Tabs
        items={items}
        value={tab ?? DEFAULT_EXTENSIONS_TAB}
        onChange={(id) => onTabChange?.(id as ExtensionsTab)}
        ariaLabel={tx("settingsExtensionsTitle", "Extensions")}
      />
    </Section>
  );
}
