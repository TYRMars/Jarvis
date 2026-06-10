// Settings → Tools — read-only catalog of every registered tool.
// Phase 1 of the model-tool-compatibility rollout. The catalog
// pulls from `GET /v1/tools` which derives source / pack / risk
// from registration-time annotations (MCP-bridged → Mcp, subagent
// wrapper → SubAgent) plus name-convention heuristics.
//
// Per-tool enable / disable / risk override is intentionally NOT
// in Phase 1 — the underlying registry doesn't yet support
// per-tool runtime mutation. This page is a transparency surface:
// "what tools does the agent have, where did they come from, and
// how risky are they?"

import { useEffect, useMemo, useState } from "react";
import { Section } from "./Section";
import { Select } from "../../ui";
import { t } from "../../../utils/i18n";
import {
  loadTools,
  setToolEnabled,
  type ToolMetadata,
  type ToolPack,
  type ToolRisk,
  type ToolSourceKind,
  type ToolsResponse,
} from "../../../services/tools";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const SOURCE_OPTIONS: { value: ToolSourceKind | ""; label: string }[] = [
  { value: "", label: t("setSecCSourceAll") },
  { value: "builtin", label: t("setSecCSourceBuiltin") },
  { value: "mcp", label: "MCP" },
  { value: "plugin", label: t("setSecCSourcePlugin") },
  { value: "subagent", label: "SubAgent" },
];

const PACK_OPTIONS: { value: ToolPack | ""; label: string }[] = [
  { value: "", label: t("setSecCPackAll") },
  { value: "file-read", label: t("setSecCPackFileRead") },
  { value: "file-write", label: t("setSecCPackFileWrite") },
  { value: "code-search", label: t("setSecCPackCodeSearch") },
  { value: "shell", label: t("setSecCPackShell") },
  { value: "git", label: "Git" },
  { value: "web", label: t("setSecCPackWeb") },
  { value: "project", label: t("setSecCPackProject") },
  { value: "requirement", label: t("setSecCPackRequirement") },
  { value: "todo", label: t("setSecCPackTodo") },
  { value: "doc", label: t("setSecCPackDoc") },
  { value: "memory", label: t("setSecCPackMemory") },
  { value: "skill", label: t("setSecCPackSkill") },
  { value: "cloud", label: t("setSecCPackCloud") },
  { value: "sub-agent", label: "SubAgent" },
  { value: "mcp", label: "MCP" },
  { value: "other", label: t("setSecCPackOther") },
];

const RISK_OPTIONS: { value: ToolRisk | ""; label: string }[] = [
  { value: "", label: t("setSecCRiskAll") },
  { value: "read-only", label: t("setSecCRiskReadOnly") },
  { value: "metadata-write", label: t("setSecCRiskMetadataWrite") },
  { value: "workspace-write", label: t("setSecCRiskWorkspaceWrite") },
  { value: "shell", label: t("setSecCPackShell") },
  { value: "network", label: t("setSecCRiskNetwork") },
  { value: "external-side-effect", label: t("setSecCRiskExternalSideEffect") },
  { value: "secret-access", label: t("setSecCRiskSecretAccess") },
];

function riskTone(risk: ToolRisk): "muted" | "warn" | "danger" {
  switch (risk) {
    case "read-only":
    case "metadata-write":
      return "muted";
    case "network":
    case "workspace-write":
      return "warn";
    case "shell":
    case "external-side-effect":
    case "secret-access":
      return "danger";
  }
}

function describeSource(meta: ToolMetadata): string {
  const s = meta.source;
  if (!s || s.kind === "builtin") return t("setSecCDescBuiltin");
  if (s.kind === "mcp") return `MCP · ${s.server}`;
  if (s.kind === "plugin") return `${t("setSecCDescPlugin")} · ${s.plugin}`;
  if (s.kind === "subagent") return `${t("setSecCDescSubagent")} · ${s.subagent}`;
  return t("setSecCDescUnknown");
}

export function ToolsSection() {
  const [data, setData] = useState<ToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<ToolSourceKind | "">("");
  const [packFilter, setPackFilter] = useState<ToolPack | "">("");
  const [riskFilter, setRiskFilter] = useState<ToolRisk | "">("");
  const [search, setSearch] = useState("");
  const [busyTool, setBusyTool] = useState<string | null>(null);

  const handleToggle = async (meta: ToolMetadata) => {
    const next = meta.enabled === false; // currently disabled? next is true (enable)
    setBusyTool(meta.name);
    setError(null);
    try {
      await setToolEnabled(meta.name, next);
      // Optimistic local update so the row reflects the new state
      // without waiting for a refetch.
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tools: prev.tools.map((t) =>
            t.name === meta.name ? { ...t, enabled: next } : t,
          ),
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyTool(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadTools({
      source: sourceFilter || undefined,
      pack: packFilter || undefined,
      risk: riskFilter || undefined,
    })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceFilter, packFilter, riskFilter]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.tools;
    const needle = search.toLowerCase();
    return data.tools.filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle),
    );
  }, [data, search]);

  return (
    <Section
      id="tools"
      titleKey="settingsToolsTitle"
      titleFallback="Tools"
      descKey="settingsToolsDesc"
      descFallback="Every tool the agent can call, classified by source, product pack, and risk. Toggle a tool off to hide it from the LLM until restart — the mute set is in-process only."
    >
      <div className="settings-tools-toolbar">
        <input
          type="search"
          placeholder={tx("settingsToolsSearch", "Search by name or description…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="settings-tools-search"
        />
        <Select
          value={sourceFilter}
          onChange={(v) => setSourceFilter(v)}
          options={SOURCE_OPTIONS}
        />
        <Select
          value={packFilter}
          onChange={(v) => setPackFilter(v)}
          options={PACK_OPTIONS}
        />
        <Select
          value={riskFilter}
          onChange={(v) => setRiskFilter(v)}
          options={RISK_OPTIONS}
        />
      </div>

      {error ? (
        <div className="settings-inline-error" role="alert">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <p className="settings-empty">{tx("settingsToolsLoading", "Loading…")}</p>
      ) : !data || data.tools.length === 0 ? (
        <p className="settings-empty">
          {tx("settingsToolsEmpty", "No tools match the current filters.")}
        </p>
      ) : (
        <>
          <div className="settings-row-hint">
            {tx("settingsToolsCount", "Showing")} <strong>{filtered.length}</strong>
            {filtered.length !== data.total ? ` / ${data.total}` : ""}
          </div>
          <ul className="settings-tools-list">
            {filtered.map((meta) => (
              <li
                key={meta.name}
                className={
                  "settings-tools-row" +
                  (meta.enabled === false ? " settings-tools-row-muted" : "")
                }
              >
                <div className="settings-tools-row-head">
                  <span className="mono settings-tools-name">{meta.name}</span>
                  <button
                    type="button"
                    className={
                      "settings-tools-toggle" +
                      (meta.enabled === false ? " off" : " on")
                    }
                    title={
                      meta.enabled === false
                        ? tx("settingsToolsEnableTitle", "Click to enable this tool")
                        : tx("settingsToolsDisableTitle", "Click to mute this tool")
                    }
                    onClick={() => handleToggle(meta)}
                    disabled={busyTool === meta.name}
                  >
                    {meta.enabled === false
                      ? tx("settingsToolsEnable", "Enable")
                      : tx("settingsToolsDisable", "Disable")}
                  </button>
                  <span className={`settings-tag settings-tag-${riskTone(meta.risk)}`}>
                    {meta.risk}
                  </span>
                  {meta.pack ? (
                    <span className="settings-tag" title={t("setSecCTitleProductPack")}>
                      {meta.pack}
                    </span>
                  ) : null}
                  <span className="settings-tag" title={t("setSecCTitleSource")}>
                    {describeSource(meta)}
                  </span>
                  {meta.requiresApproval ? (
                    <span
                      className="settings-tag settings-tag-warn"
                      title={t("setSecCTitleApprovalGated")}
                    >
                      {t("setSecCTagApproval")}
                    </span>
                  ) : null}
                  {meta.cacheable ? (
                    <span className="settings-tag" title={t("setSecCTitleCacheable")}>
                      {t("setSecCTagCache")}
                    </span>
                  ) : null}
                  {meta.isTerminal ? (
                    <span className="settings-tag" title={t("setSecCTitleTerminalTool")}>
                      {t("setSecCTagTerminal")}
                    </span>
                  ) : null}
                </div>
                <p className="settings-tools-desc">{meta.description}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
