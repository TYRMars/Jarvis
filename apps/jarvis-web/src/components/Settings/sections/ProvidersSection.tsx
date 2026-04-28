// Read-only listing of providers + their advertised models. The
// data already lives in the store (loaded by `boot()` from
// `GET /v1/providers`). Editing isn't possible from the UI today —
// providers are wired in `apps/jarvis::serve.rs` at startup based
// on env / config — so this section is informational, with a hint
// pointing the user at the right place to make changes.

import { useAppStore } from "../../../store/appStore";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function ProvidersSection() {
  const providers = useAppStore((s) => s.providers);

  return (
    <Section
      id="providers"
      titleKey="settingsProvidersTitle"
      titleFallback="Providers"
      descKey="settingsProvidersDesc"
      descFallback="Read-only. Configured at server startup via JARVIS_PROVIDER + provider auth files. Edit ~/.config/jarvis/config.toml or run `jarvis login --provider X` to change."
    >
      {providers.length === 0 ? (
        <p className="settings-empty">{tx("settingsProvidersEmpty", "No providers loaded yet — boot incomplete or the catalog endpoint failed.")}</p>
      ) : (
        <ul className="settings-providers">
          {providers.map((p) => (
            <li key={p.name} className="settings-provider">
              <div className="settings-provider-head">
                <strong>{p.name}</strong>
                {p.is_default && <span className="settings-tag">{tx("settingsProvidersDefault", "default")}</span>}
              </div>
              <div className="settings-provider-default-model">
                <span className="settings-row-hint">{tx("settingsProvidersDefaultModel", "default model")}: </span>
                <span className="mono">{p.default_model}</span>
              </div>
              {p.models.length > 1 && (
                <ul className="settings-provider-models">
                  {p.models
                    .filter((m) => m !== p.default_model)
                    .map((m) => (
                      <li key={m} className="mono">{m}</li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
