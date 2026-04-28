// Fetches `GET /v1/providers` and seeds the model picker's catalog.
// Runs once on legacy boot; on success the store carries the provider
// list, and (when no routing has been chosen yet) the default
// provider's default model is preselected so the first send doesn't
// have to wait for the user to open the menu.

import { appStore, type ProviderInfo } from "../store/appStore";
import { initialDefaultRouting } from "../store/persistence";

interface ProvidersBody {
  providers?: ProviderInfo[];
}

/// Look at the catalog and pick the `<default-provider>|<default-model>`
/// pair, or `""` if no provider is marked default.
export function pickDefaultRouting(providers: ProviderInfo[]): string {
  const defaultProv = providers.find((p) => p.is_default);
  if (!defaultProv?.default_model) return "";
  return `${defaultProv.name}|${defaultProv.default_model}`;
}

export async function loadProviders(apiUrl: (path: string) => string): Promise<void> {
  try {
    const r = await fetch(apiUrl("/v1/providers"));
    if (!r.ok) return;
    const data = (await r.json()) as ProvidersBody;
    const providers = data.providers || [];
    appStore.getState().setProviders(providers);
    // Preselect routing only if the user hasn't already chosen one
    // (e.g. resumed a conversation with persisted routing during
    // boot). Priority order:
    //   1. user's `jarvis.defaultRouting` (set via Preferences page)
    //   2. server's `is_default` provider/model
    //
    // Step (1) is validated against the live catalog so a stale
    // default (provider since renamed, model retired) silently falls
    // through to step (2).
    if (!appStore.getState().routing) {
      const userDefault = initialDefaultRouting();
      const valid = userDefault
        ? providers.some((p) =>
            [p.default_model, ...p.models].some((m) => `${p.name}|${m}` === userDefault),
          )
        : false;
      if (valid) {
        appStore.getState().setRouting(userDefault);
      } else {
        const def = pickDefaultRouting(providers);
        if (def) appStore.getState().setRouting(def);
      }
    }
  } catch (e) {
    console.warn("provider list fetch failed", e);
  }
}
