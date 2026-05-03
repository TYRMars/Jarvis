// Settings → Agents tab. Phase 3.6.
//
// Manages named agent profiles ("Alice on Codex / GPT-5") that
// kanban requirements can be assigned to. Each profile bundles
// provider + model + optional system prompt / avatar / default
// workspace / tool allowlist.
//
// Reads from the in-memory cache populated by services/agentProfiles.ts;
// edits round-trip through the same module's CRUD helpers and
// reconcile via the WS frame appliers wired in domainFrames.ts.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import { t } from "../../../utils/i18n";
import {
  createAgentProfile,
  deleteAgentProfile,
  listAgentProfiles,
  loadAgentProfiles,
  subscribeAgentProfiles,
  updateAgentProfile,
} from "../../../services/agentProfiles";
import type { AgentProfile } from "../../../types/frames";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function AgentsSection() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  useEffect(() => {
    void loadAgentProfiles();
    const off = subscribeAgentProfiles(() => setProfiles(listAgentProfiles()));
    setProfiles(listAgentProfiles());
    return off;
  }, []);

  return (
    <Section
      id="agents"
      titleKey="settingsAgentsTitle"
      titleFallback="Agents"
      descKey="settingsAgentsDesc"
      descFallback="Named agent profiles requirements can be assigned to. Each profile picks a provider + model and an optional system prompt prepended to the run manifest."
    >
      <CreateAgentForm />
      <div className="settings-agent-list" role="list">
        {profiles.length === 0 ? (
          <p className="settings-agent-empty">{tx("settingsAgentsEmpty", "No agents defined yet.")}</p>
        ) : (
          profiles.map((p) => <AgentRow key={p.id} profile={p} />)
        )}
      </div>
    </Section>
  );
}

function CreateAgentForm() {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !provider.trim() || !model.trim()) {
      setError(tx("settingsAgentsRequiredFields", "Name, provider, and model are all required."));
      return;
    }
    setBusy(true);
    try {
      await createAgentProfile({
        name: name.trim(),
        provider: provider.trim(),
        model: model.trim(),
        system_prompt: systemPrompt.trim() || undefined,
      });
      setName("");
      setProvider("");
      setModel("");
      setSystemPrompt("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-agent-create" onSubmit={submit}>
      <Row label={tx("settingsAgentsName", "Name")}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alice"
          disabled={busy}
        />
      </Row>
      <Row label={tx("settingsAgentsProvider", "Provider")}>
        <input
          type="text"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="openai / anthropic / codex / ..."
          disabled={busy}
        />
      </Row>
      <Row label={tx("settingsAgentsModel", "Model")}>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-4o-mini"
          disabled={busy}
        />
      </Row>
      <Row label={tx("settingsAgentsSystemPrompt", "System prompt (optional)")}>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={3}
          disabled={busy}
        />
      </Row>
      {error && <p className="settings-agent-error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? tx("settingsAgentsCreating", "Creating…") : tx("settingsAgentsCreate", "Create agent")}
      </button>
    </form>
  );
}

function AgentRow({ profile }: { profile: AgentProfile }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    system_prompt: profile.system_prompt ?? "",
    avatar: profile.avatar ?? "",
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await updateAgentProfile(profile.id, {
        name: draft.name,
        provider: draft.provider,
        model: draft.model,
        system_prompt: draft.system_prompt,
        avatar: draft.avatar,
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(tx("settingsAgentsConfirmDelete", `Delete agent "${profile.name}"?`))) return;
    setBusy(true);
    try {
      await deleteAgentProfile(profile.id);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="settings-agent-row editing" role="listitem">
        <Row label={tx("settingsAgentsName", "Name")}>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            disabled={busy}
          />
        </Row>
        <Row label={tx("settingsAgentsProvider", "Provider")}>
          <input
            type="text"
            value={draft.provider}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
            disabled={busy}
          />
        </Row>
        <Row label={tx("settingsAgentsModel", "Model")}>
          <input
            type="text"
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            disabled={busy}
          />
        </Row>
        <Row label={tx("settingsAgentsAvatar", "Avatar")}>
          <input
            type="text"
            value={draft.avatar}
            onChange={(e) => setDraft({ ...draft, avatar: e.target.value })}
            placeholder="🦊"
            disabled={busy}
          />
        </Row>
        <Row label={tx("settingsAgentsSystemPrompt", "System prompt (optional)")}>
          <textarea
            value={draft.system_prompt}
            onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
            rows={3}
            disabled={busy}
          />
        </Row>
        <div className="settings-agent-row-actions">
          <button type="button" onClick={save} disabled={busy}>
            {tx("settingsAgentsSave", "Save")}
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            {tx("settingsAgentsCancel", "Cancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-agent-row" role="listitem">
      <div className="settings-agent-row-head">
        {profile.avatar && (
          <span className="settings-agent-avatar" aria-hidden="true">
            {profile.avatar}
          </span>
        )}
        <strong className="settings-agent-name">{profile.name}</strong>
        <span className="settings-agent-provider">
          {profile.provider} · {profile.model}
        </span>
      </div>
      {profile.system_prompt && (
        <p className="settings-agent-prompt">{profile.system_prompt}</p>
      )}
      <div className="settings-agent-row-actions">
        <button type="button" onClick={() => setEditing(true)} disabled={busy}>
          {tx("settingsAgentsEdit", "Edit")}
        </button>
        <button type="button" onClick={remove} disabled={busy} className="danger">
          {tx("settingsAgentsDelete", "Delete")}
        </button>
      </div>
    </div>
  );
}
