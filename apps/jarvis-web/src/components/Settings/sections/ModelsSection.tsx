// "Models" section. Bundles the LLM provider registry — defaults
// (active model, effort level) live alongside the per-provider
// credentials. Subagents used to share this super-section as a tab,
// but were promoted to their own top-level entry under Capabilities
// so the nav reflects what each thing is: providers configure the
// LLM transport, subagents configure the named agent personas.

import { Section } from "./Section";
import { ProvidersSection } from "./ProvidersSection";

export function ModelsSection() {
  return (
    <Section
      id="models"
      titleKey="settingsModelsTitle"
      titleFallback="Models"
      descKey="settingsModelsDesc"
      descFallback="Configure LLM providers and per-browser defaults like the active model and effort level."
    >
      <ProvidersSection embedded />
    </Section>
  );
}
