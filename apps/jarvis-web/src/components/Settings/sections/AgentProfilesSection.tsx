// Settings → Subagents. A "subagent" is a named provider/model/
// system_prompt preset that Jarvis can summon as a specialist —
// assigned to a Requirement card, mentioned by name, or (later)
// dispatched to by the auto loop. Multica-style "agent as colleague"
// shape; see `docs/proposals/work-orchestration.zh-CN.md`.
//
// Backend type is still `AgentProfile` / `/v1/agent-profiles`; the
// **product surface** is "Subagent". The internal name stays for
// wire-shape continuity with the proposal.
//
// Two usability rules this section follows:
//   1. Provider dropdown only shows providers that are actually
//      configured on the server (live list from `/v1/providers`,
//      already in `appStore.providers`). No more typing magic
//      strings like `openai-responses`.
//   2. Model is a dropdown driven by the chosen provider's
//      advertised `models[]` array, default model preselected.
//      A "Custom…" option falls back to free-text for users who
//      know about a model the catalog hasn't surfaced yet.

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../../store/appStore";
import {
  createAgentProfile,
  deleteAgentProfile,
  listAgentProfiles,
  loadAgentProfiles,
  subscribeAgentProfiles,
  updateAgentProfile,
  type CreateProfileInput,
} from "../../../services/agentProfiles";
import type { AgentProfile } from "../../../types/frames";
import type { ProviderInfo } from "../../../store/types";
import { Section } from "./Section";

const CUSTOM_MODEL_SENTINEL = "__custom__";

export function AgentProfilesSection() {
  const providers = useAppStore((s) => s.providers);
  const [profiles, setProfiles] = useState<AgentProfile[]>(() => listAgentProfiles());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const unsub = subscribeAgentProfiles(() => setProfiles(listAgentProfiles()));
    setLoading(true);
    void loadAgentProfiles()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    return unsub;
  }, []);

  const noProviders = providers.length === 0;

  return (
    <Section
      id="agent-profiles"
      titleKey="settingsSubagentsTitle"
      titleFallback="Subagents"
      descKey="settingsSubagentsDesc"
      descFallback="Named specialists Jarvis can summon. Each subagent is a saved provider + model + system prompt preset — assign one as a Requirement's owner, mention it by name in chat, or hand off control during a long task. Server-global; deleting one leaves any Requirement assigned to it as 'unknown agent' until reassigned."
    >
      {noProviders ? (
        <div className="settings-inline-error" role="status">
          No providers loaded yet — check <a href="#providers">Settings → Providers</a> or restart the server with at least one provider configured before adding subagents.
        </div>
      ) : (
        <CreateProfileForm providers={providers} onError={setError} />
      )}

      {error ? <div className="settings-inline-error" role="alert">{error}</div> : null}

      {loading && profiles.length === 0 ? (
        <p className="settings-empty">Loading…</p>
      ) : profiles.length === 0 ? (
        <p className="settings-empty">
          No subagents yet. Add one above to give Jarvis a named specialist you can
          assign work to.
        </p>
      ) : (
        <ul className="agent-profiles-list">
          {profiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              providers={providers}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------- create form -----------------------------------------------

function CreateProfileForm({
  providers,
  onError,
}: {
  providers: ProviderInfo[];
  onError: (e: string | null) => void;
}) {
  const initialProvider = providers.find((p) => p.is_default) ?? providers[0];
  const [name, setName] = useState("");
  const [providerName, setProviderName] = useState(initialProvider?.name ?? "");
  const [model, setModel] = useState(initialProvider?.default_model ?? "");
  const [busy, setBusy] = useState(false);

  // Keep provider/model in sync when the live providers list changes
  // (e.g. server reloaded its config).
  useEffect(() => {
    if (!providers.find((p) => p.name === providerName)) {
      const next = providers.find((p) => p.is_default) ?? providers[0];
      if (next) {
        setProviderName(next.name);
        setModel(next.default_model);
      }
    }
  }, [providers, providerName]);

  const onProviderChange = (next: string) => {
    setProviderName(next);
    const provider = providers.find((p) => p.name === next);
    if (provider) setModel(provider.default_model);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    if (!name.trim() || !providerName.trim() || !model.trim()) return;
    setBusy(true);
    try {
      const input: CreateProfileInput = {
        name: name.trim(),
        provider: providerName.trim(),
        model: model.trim(),
      };
      await createAgentProfile(input);
      setName("");
      // Reset model to provider default so the next add starts clean.
      const provider = providers.find((p) => p.name === providerName);
      if (provider) setModel(provider.default_model);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="agent-profile-create" onSubmit={submit}>
      <label className="agent-profile-field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alice"
          disabled={busy}
        />
      </label>
      <ProviderSelect
        value={providerName}
        providers={providers}
        onChange={onProviderChange}
        disabled={busy}
      />
      <ModelSelect
        provider={providers.find((p) => p.name === providerName) ?? null}
        value={model}
        onChange={setModel}
        disabled={busy}
      />
      <button
        type="submit"
        className="agent-profile-create-btn"
        disabled={busy || !name.trim() || !providerName.trim() || !model.trim()}
      >
        {busy ? "Adding…" : "Add subagent"}
      </button>
    </form>
  );
}

// ---------- profile card (read + edit) --------------------------------

function ProfileCard({
  profile,
  providers,
  onError,
}: {
  profile: AgentProfile;
  providers: ProviderInfo[];
  onError: (e: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentProfile>(profile);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(profile);
  }, [profile, editing]);

  const startEdit = () => {
    setDraft(profile);
    setEditing(true);
    onError(null);
  };

  const cancelEdit = () => {
    setDraft(profile);
    setEditing(false);
  };

  const save = async () => {
    if (!draft.name.trim() || !draft.provider.trim() || !draft.model.trim()) {
      onError("name, provider and model are all required");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await updateAgentProfile(profile.id, {
        name: draft.name,
        provider: draft.provider,
        model: draft.model,
        avatar: draft.avatar ?? "",
        system_prompt: draft.system_prompt ?? "",
        default_workspace: draft.default_workspace ?? "",
        allowed_tools: draft.allowed_tools ?? [],
      });
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete subagent "${profile.name}"?`)) return;
    setBusy(true);
    onError(null);
    try {
      await deleteAgentProfile(profile.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const providerInfo = providers.find((p) => p.name === profile.provider) ?? null;
  const providerConfigured = providerInfo !== null;

  if (!editing) {
    return (
      <li className="agent-profile-card">
        <div className="agent-profile-summary">
          <div className="agent-profile-name">
            <span className="agent-profile-avatar" aria-hidden="true">
              {profile.avatar || initials(profile.name)}
            </span>
            <strong>{profile.name}</strong>
            {!providerConfigured ? (
              <span
                className="agent-profile-warning"
                title={`Provider "${profile.provider}" isn't configured on this server. Edit the subagent or add the provider in Settings → Providers.`}
              >
                provider missing
              </span>
            ) : null}
          </div>
          <div className="agent-profile-meta">
            <code>{profile.provider}</code> · <code>{profile.model}</code>
          </div>
          {profile.system_prompt ? (
            <p className="agent-profile-prompt">{profile.system_prompt}</p>
          ) : null}
        </div>
        <div className="agent-profile-actions">
          <button type="button" onClick={startEdit} disabled={busy}>
            Edit
          </button>
          <button
            type="button"
            className="agent-profile-delete"
            onClick={() => void remove()}
            disabled={busy}
          >
            Delete
          </button>
        </div>
      </li>
    );
  }

  const draftProvider =
    providers.find((p) => p.name === draft.provider) ?? null;

  return (
    <li className="agent-profile-card editing">
      <label className="agent-profile-field">
        <span>Name</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          disabled={busy}
        />
      </label>
      <label className="agent-profile-field">
        <span>Avatar (emoji or short text)</span>
        <input
          type="text"
          value={draft.avatar ?? ""}
          onChange={(e) => setDraft({ ...draft, avatar: e.target.value })}
          placeholder="🤖"
          disabled={busy}
        />
      </label>
      <ProviderSelect
        value={draft.provider}
        providers={providers}
        onChange={(name) => {
          const next = providers.find((p) => p.name === name);
          setDraft({
            ...draft,
            provider: name,
            // Auto-pick the new provider's default model when switching;
            // user can override via the model select afterwards.
            model: next ? next.default_model : draft.model,
          });
        }}
        disabled={busy}
        allowOrphan={!providerConfigured}
      />
      <ModelSelect
        provider={draftProvider}
        value={draft.model}
        onChange={(model) => setDraft({ ...draft, model })}
        disabled={busy}
      />
      <label className="agent-profile-field full">
        <span>System prompt (optional)</span>
        <textarea
          rows={4}
          value={draft.system_prompt ?? ""}
          onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
          placeholder="You are a careful Rust reviewer…"
          disabled={busy}
        />
      </label>
      <label className="agent-profile-field full">
        <span>Default workspace (optional)</span>
        <input
          type="text"
          value={draft.default_workspace ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, default_workspace: e.target.value })
          }
          placeholder="/Users/me/code/jarvis"
          disabled={busy}
        />
      </label>
      <div className="agent-profile-actions">
        <button type="button" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={cancelEdit} disabled={busy}>
          Cancel
        </button>
      </div>
    </li>
  );
}

// ---------- shared sub-controls ---------------------------------------

function ProviderSelect({
  value,
  providers,
  onChange,
  disabled,
  allowOrphan = false,
}: {
  value: string;
  providers: ProviderInfo[];
  onChange: (next: string) => void;
  disabled?: boolean;
  /// When the persisted profile references a provider the server doesn't
  /// know about (e.g. a config edit removed it), keep the orphaned name
  /// in the dropdown labeled `(missing)` so the user can see what's
  /// there before picking a replacement.
  allowOrphan?: boolean;
}) {
  const knownNames = providers.map((p) => p.name);
  const showOrphan = allowOrphan && value && !knownNames.includes(value);
  return (
    <label className="agent-profile-field">
      <span>Provider</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {providers.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
            {p.is_default ? " (default)" : ""}
          </option>
        ))}
        {showOrphan ? (
          <option value={value}>{value} (missing)</option>
        ) : null}
      </select>
    </label>
  );
}

function ModelSelect({
  provider,
  value,
  onChange,
  disabled,
}: {
  provider: ProviderInfo | null;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const options = useMemo(() => {
    if (!provider) return [] as string[];
    // Default model first, then the rest of the catalog. Dedupe in case
    // the registry already lists the default in `models`.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of [provider.default_model, ...provider.models]) {
      if (m && !seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
    return out;
  }, [provider]);

  // When the provider is orphaned (server doesn't list it), we have no
  // catalog to drive the dropdown — fall through to a plain free-text
  // input so the existing `value` is visible and editable. The user
  // can switch to a real provider via the provider select to repopulate
  // the catalog.
  if (!provider) {
    return (
      <div className="agent-profile-field agent-profile-model-field">
        <span>Model</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model id"
          disabled={disabled}
        />
      </div>
    );
  }

  const isCustom = !options.includes(value);
  const selectValue = isCustom ? CUSTOM_MODEL_SENTINEL : value;

  return (
    <div className="agent-profile-field agent-profile-model-field">
      <span>Model</span>
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM_MODEL_SENTINEL) {
            // Pivot to free-text by clearing the value; the input below
            // takes over.
            onChange("");
          } else {
            onChange(v);
          }
        }}
        disabled={disabled}
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
            {m === provider.default_model ? " (default)" : ""}
          </option>
        ))}
        <option value={CUSTOM_MODEL_SENTINEL}>Custom…</option>
      </select>
      {isCustom ? (
        <input
          className="agent-profile-model-custom"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="enter custom model id"
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
