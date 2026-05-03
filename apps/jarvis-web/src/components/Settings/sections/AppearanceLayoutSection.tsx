// "Appearance & Layout" super-section. Wraps the legacy
// AppearanceSection (theme + language) and PreferencesSection
// (layout toggles, default model, clear data) under one routed
// section with two tabs. Lets users find every "how the UI looks /
// behaves" knob in one place instead of bouncing between two
// nav items.
//
// Pure container — does not own any state itself; the legacy
// section components keep all their behaviour. Tab state is
// pushed up via `tab` / `onTabChange` so SettingsPage can sync
// it to the URL hash (`/settings#appearance/layout`).

import { Section } from "./Section";
import { Tabs, type TabItem } from "../../ui/Tabs";
import { AppearanceSection } from "./AppearanceSection";
import { PreferencesSection } from "./PreferencesSection";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export const APPEARANCE_LAYOUT_TABS = ["appearance", "layout"] as const;
export type AppearanceLayoutTab = (typeof APPEARANCE_LAYOUT_TABS)[number];
export const DEFAULT_APPEARANCE_LAYOUT_TAB: AppearanceLayoutTab = "appearance";

interface Props {
  tab?: AppearanceLayoutTab;
  onTabChange?: (tab: AppearanceLayoutTab) => void;
}

export function AppearanceLayoutSection({ tab, onTabChange }: Props = {}) {
  const items: TabItem[] = [
    {
      id: "appearance",
      label: tx("settingsTabAppearance", "Appearance"),
      content: <AppearanceSection embedded />,
    },
    {
      id: "layout",
      label: tx("settingsTabLayout", "Layout"),
      content: <PreferencesSection embedded />,
    },
  ];

  return (
    <Section
      id="appearance-layout"
      titleKey="settingsAppearanceLayoutTitle"
      titleFallback="Appearance & Layout"
      descKey="settingsAppearanceLayoutDesc"
      descFallback="Theme, language, and which panels show up in the chat surface."
    >
      <Tabs
        items={items}
        value={tab ?? DEFAULT_APPEARANCE_LAYOUT_TAB}
        onChange={(id) => onTabChange?.(id as AppearanceLayoutTab)}
        ariaLabel={tx("settingsAppearanceLayoutTitle", "Appearance & Layout")}
      />
    </Section>
  );
}
