// "Models" super-section. Bundles the LLM provider registry and
// named subagent presets into one routed section. Subagents
// reference providers + models, so configuring a new role
// historically required bouncing between two top-level nav items;
// this collapses that flow.

import { Section } from "./Section";
import { Tabs, type TabItem } from "../../ui/Tabs";
import { ProvidersSection } from "./ProvidersSection";
import { AgentProfilesSection } from "./AgentProfilesSection";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export const MODELS_TABS = ["providers", "subagents"] as const;
export type ModelsTab = (typeof MODELS_TABS)[number];
export const DEFAULT_MODELS_TAB: ModelsTab = "providers";

interface Props {
  tab?: ModelsTab;
  onTabChange?: (tab: ModelsTab) => void;
}

export function ModelsSection({ tab, onTabChange }: Props = {}) {
  const items: TabItem[] = [
    {
      id: "providers",
      label: tx("settingsTabProviders", "Providers"),
      content: <ProvidersSection embedded />,
    },
    {
      id: "subagents",
      label: tx("settingsTabSubagents", "Subagents"),
      content: <AgentProfilesSection embedded />,
    },
  ];

  return (
    <Section
      id="models"
      titleKey="settingsModelsTitle"
      titleFallback="Models"
      descKey="settingsModelsDesc"
      descFallback="Configure LLM providers and named subagent presets."
    >
      <Tabs
        items={items}
        value={tab ?? DEFAULT_MODELS_TAB}
        onChange={(id) => onTabChange?.(id as ModelsTab)}
        ariaLabel={tx("settingsModelsTitle", "Models")}
      />
    </Section>
  );
}
