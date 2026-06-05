import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { addMcpServer } from "../../services/mcp";
import {
  installSkillFromMarket,
  mcpConfigFromMarketEntry,
  searchMcpMarket,
  searchSkillMarket,
  type MarketMcpEntry,
  type MarketSkillEntry,
} from "../../services/market";
import { sendFrame } from "../../services/socket";
import { appStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import {
  createWorkflow,
  type CreateWorkflowInput,
  type WorkflowStep,
} from "../../services/workflows";

type MarketState<T> =
  | { kind: "loading" }
  | { kind: "ready"; entries: T[] }
  | { kind: "error"; message: string };

const SKILL_PAGE_SIZE = 30;
const SKILL_MAX_LIMIT = 100;
const MCP_PAGE_SIZE = 20;
const MCP_MAX_LIMIT = 50;

export function SkillMarketPanel({ onInstalled }: { onInstalled?: () => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<MarketState<MarketSkillEntry>>({ kind: "loading" });
  const [limit, setLimit] = useState(SKILL_PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (q = query, nextLimit = limit, mode: "replace" | "append" = "replace") => {
    if (mode === "replace") {
      setState({ kind: "loading" });
    } else {
      setLoadingMore(true);
    }
    searchSkillMarket(q, nextLimit)
      .then((entries) => setState({ kind: "ready", entries }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }))
      .finally(() => setLoadingMore(false));
  };

  useEffect(() => {
    refresh("", SKILL_PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLimit(SKILL_PAGE_SIZE);
    refresh(query, SKILL_PAGE_SIZE);
  };

  const hasMore = state.kind === "ready"
    && state.entries.length >= limit
    && limit < SKILL_MAX_LIMIT;

  const loadMore = () => {
    if (!hasMore || loadingMore) return;
    const nextLimit = Math.min(limit + SKILL_PAGE_SIZE, SKILL_MAX_LIMIT);
    setLimit(nextLimit);
    refresh(query, nextLimit, "append");
  };

  const loadMoreRef = useAutoLoadMore(hasMore && !loadingMore, loadMore);

  const install = async (entry: MarketSkillEntry) => {
    const key = `${entry.source}/${entry.skillId}`;
    setInstalling(key);
    setMessage(null);
    setError(null);
    try {
      const skill = await installSkillFromMarket(entry.source, entry.skillId);
      activateSkill(skill.name);
      onInstalled?.();
      setMessage(t("marketSkillInstalled", skill.name));
    } catch (e: unknown) {
      setError(t("marketSkillInstallFailed", String(e)));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="market-panel" aria-label={t("marketSkillTitle")}>
      <MarketHeader
        title={t("marketSkillTitle")}
        hint={t("custMktSkillHint")}
        query={query}
        setQuery={setQuery}
        onSubmit={submit}
        placeholder={t("custMktSkillSearchPlaceholder")}
      />
      {renderSkillMarket(state, installing, (entry) => { void install(entry); })}
      <MarketLoadMore
        refEl={loadMoreRef}
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={loadMore}
      />
      {message && <div className="settings-form-success">{message}</div>}
      {error && <div className="settings-form-error">{error}</div>}
    </div>
  );
}

export function McpMarketPanel({ onInstalled }: { onInstalled?: () => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<MarketState<MarketMcpEntry>>({ kind: "loading" });
  const [limit, setLimit] = useState(MCP_PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (q = query, nextLimit = limit, mode: "replace" | "append" = "replace") => {
    if (mode === "replace") {
      setState({ kind: "loading" });
    } else {
      setLoadingMore(true);
    }
    searchMcpMarket(q, nextLimit)
      .then((entries) => setState({ kind: "ready", entries }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }))
      .finally(() => setLoadingMore(false));
  };

  useEffect(() => {
    refresh("", MCP_PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLimit(MCP_PAGE_SIZE);
    refresh(query, MCP_PAGE_SIZE);
  };

  const hasMore = state.kind === "ready"
    && state.entries.length >= limit
    && limit < MCP_MAX_LIMIT;

  const loadMore = () => {
    if (!hasMore || loadingMore) return;
    const nextLimit = Math.min(limit + MCP_PAGE_SIZE, MCP_MAX_LIMIT);
    setLimit(nextLimit);
    refresh(query, nextLimit, "append");
  };

  const loadMoreRef = useAutoLoadMore(hasMore && !loadingMore, loadMore);

  const install = async (entry: MarketMcpEntry) => {
    const cfg = mcpConfigFromMarketEntry(entry);
    if (!cfg) return;
    setInstalling(entry.name);
    setMessage(null);
    setError(null);
    try {
      await addMcpServer(cfg);
      onInstalled?.();
      setMessage(t("marketMcpInstalled", cfg.prefix));
    } catch (e: unknown) {
      setError(t("marketMcpInstallFailed", String(e)));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="market-panel" aria-label={t("marketMcpTitle")}>
      <MarketHeader
        title={t("marketMcpTitle")}
        hint={t("custMktMcpHint")}
        query={query}
        setQuery={setQuery}
        onSubmit={submit}
        placeholder={t("custMktMcpSearchPlaceholder")}
      />
      {renderMcpMarket(state, installing, (entry) => { void install(entry); })}
      <MarketLoadMore
        refEl={loadMoreRef}
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={loadMore}
      />
      {message && <div className="settings-form-success">{message}</div>}
      {error && <div className="settings-form-error">{error}</div>}
    </div>
  );
}

function useAutoLoadMore(enabled: boolean, onLoadMore: () => void) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!enabled) return;
    if (typeof IntersectionObserver === "undefined") return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMoreRef.current();
      }
    }, { rootMargin: "240px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return sentinelRef;
}

function MarketLoadMore({
  refEl,
  hasMore,
  loading,
  onLoadMore,
}: {
  refEl: RefObject<HTMLDivElement | null>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div ref={refEl} className="market-load-more">
      <button
        type="button"
        className="settings-btn"
        onClick={onLoadMore}
        disabled={loading}
      >
        {loading ? t("custMktLoadingMore") : t("custMktLoadMore")}
      </button>
    </div>
  );
}

function MarketHeader({
  title,
  hint,
  query,
  setQuery,
  onSubmit,
  placeholder,
}: {
  title: string;
  hint: string;
  query: string;
  setQuery: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  placeholder: string;
}) {
  return (
    <div className="market-head">
      <div className="market-title-block">
        <div className="market-title">{title}</div>
        <div className="market-hint">{hint}</div>
      </div>
      <form className="market-search" onSubmit={onSubmit}>
        <input
          className="settings-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
        />
        <button type="submit" className="settings-btn">
          {t("marketSearchBtn")}
        </button>
      </form>
    </div>
  );
}

function renderSkillMarket(
  state: MarketState<MarketSkillEntry>,
  installing: string | null,
  onInstall: (entry: MarketSkillEntry) => void,
) {
  if (state.kind === "loading") return <div className="market-empty">…</div>;
  if (state.kind === "error") {
    return <div className="settings-form-error">{t("marketLoadFailed", state.message)}</div>;
  }
  if (state.entries.length === 0) {
    return <div className="market-empty">{t("marketEmpty")}</div>;
  }
  return (
    <ul className="market-list">
      {state.entries.map((entry) => {
        const key = `${entry.source}/${entry.skillId}`;
        return (
          <li key={key} className="market-item">
            <div className="market-item-main">
              <div className="market-item-title">
                <span className="mono">{entry.name}</span>
                {entry.isOfficial && <span className="market-tag">{t("marketOfficial")}</span>}
              </div>
              <div className="market-item-desc">{entry.installHint}</div>
              <div className="market-tags">
                <span>{entry.source}</span>
                {entry.installs != null && <span>{t("marketInstalls", entry.installs)}</span>}
              </div>
            </div>
            <button
              type="button"
              className="settings-btn"
              onClick={() => onInstall(entry)}
              disabled={installing !== null}
            >
              {installing === key ? t("marketInstalling") : t("marketInstallBtn")}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function renderMcpMarket(
  state: MarketState<MarketMcpEntry>,
  installing: string | null,
  onInstall: (entry: MarketMcpEntry) => void,
) {
  if (state.kind === "loading") return <div className="market-empty">…</div>;
  if (state.kind === "error") {
    return <div className="settings-form-error">{t("marketLoadFailed", state.message)}</div>;
  }
  if (state.entries.length === 0) {
    return <div className="market-empty">{t("marketEmpty")}</div>;
  }
  return (
    <ul className="market-list">
      {state.entries.map((entry) => (
        <McpMarketItem key={entry.name} entry={entry} installing={installing} onInstall={onInstall} />
      ))}
    </ul>
  );
}

function McpMarketItem({
  entry,
  installing,
  onInstall,
}: {
  entry: MarketMcpEntry;
  installing: string | null;
  onInstall: (entry: MarketMcpEntry) => void;
}) {
  const cfg = useMemo(() => mcpConfigFromMarketEntry(entry), [entry]);
  const hasRemoteOnly = !cfg && entry.remotes.length > 0;
  const disabledReason = hasRemoteOnly
    ? t("custMktMcpRemoteOnly")
    : t("custMktMcpNeedsEnv");
  return (
    <li className="market-item">
      <div className="market-item-main">
        <div className="market-item-title">
          <span className="mono">{entry.title || entry.name}</span>
          {entry.isLatest && <span className="market-tag">{t("marketLatest")}</span>}
        </div>
        <div className="market-item-desc">{entry.description || entry.name}</div>
        <div className="market-tags">
          {entry.packages.slice(0, 3).map((pkg) => (
            <span key={`${pkg.registryType}:${pkg.identifier}`}>
              {pkg.registryType} · {pkg.identifier}
            </span>
          ))}
          {entry.remotes.slice(0, 2).map((remote) => (
            <span key={`${remote.transportType}:${remote.url}`}>{remote.transportType}</span>
          ))}
          {entry.repositoryUrl && <span>{entry.repositoryUrl.replace(/^https?:\/\//, "")}</span>}
        </div>
      </div>
      <button
        type="button"
        className="settings-btn"
        onClick={() => onInstall(entry)}
        disabled={installing !== null || cfg == null}
        title={cfg == null ? disabledReason : undefined}
      >
        {installing === entry.name ? t("custMktAdding") : t("marketAddBtn")}
      </button>
    </li>
  );
}

function activateSkill(name: string) {
  if (!sendFrame({ type: "activate_skill", name })) return;
  const current = appStore.getState().activeSkills;
  const next = Array.from(new Set([...current, name]));
  appStore.getState().setActiveSkills?.(next);
}

// ---------- Workflow templates market ------------------------------
// Workflows are user-authored (no remote registry), so the market tab
// offers curated starter recipes. "Add" creates the definition via the
// workflow store; users then customize it under Manage and bind it to a
// requirement.

function agentStep(
  name: string,
  prompt: string,
  outputKey: string | null = null,
): WorkflowStep {
  return {
    id: "",
    name,
    kind: { type: "agent", prompt, subagent: null, model: null, output_key: outputKey },
  };
}

function phaseStep(name: string, title: string, steps: WorkflowStep[]): WorkflowStep {
  return { id: "", name, kind: { type: "phase", title, steps } };
}

function parallelStep(name: string, steps: WorkflowStep[]): WorkflowStep {
  return { id: "", name, kind: { type: "parallel", steps, join: "all_required" } };
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  build: () => CreateWorkflowInput;
}

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "i18n-audit",
    name: "中英文 i18n 排查与修复",
    description:
      "Per-page audit: inventory strings → parallel hardcoded/parity/untranslated lenses → fix both i18n blocks → verify tsc/lint/test. Bind one per page.",
    build: () => ({
      name: "i18n 中英文排查与修复",
      description:
        "Per-page Chinese/English audit-and-fix recipe (jarvis-web). Bind to a requirement per page. Strings live in apps/jarvis-web/src/utils/i18n.ts (en + zh blocks); t() falls back en->raw-key.",
      steps: [
        agentStep(
          "Inventory page strings",
          "List every user-facing string the target page renders (JSX text + label/placeholder/title/aria-label + toasts/empty states + data-i18n* markup), with file:line and whether it goes through t()/data-i18n. Read only.",
          "inventory",
        ),
        phaseStep("Audit", "Audit", [
          parallelStep("Audit lenses", [
            agentStep(
              "Hardcoded-string lens",
              "From the inventory below, list every hardcoded user-facing string not behind t()/data-i18n (English or Chinese), with file:line and a proposed namespaced key.\n\n{{ outputs.inventory }}",
              "hardcoded",
            ),
            agentStep(
              "Parity-key lens",
              "For every t('key') the page uses, check apps/jarvis-web/src/utils/i18n.ts has it in BOTH the en and zh blocks with matching arity. Report the gaps.\n\n{{ outputs.inventory }}",
              "missing_keys",
            ),
            agentStep(
              "Untranslated-zh lens",
              "Flag i18n keys this page uses whose zh value is still English (e.g. models:\"Models\"), with a suggested Chinese translation.\n\n{{ outputs.inventory }}",
              "untranslated",
            ),
          ]),
        ]),
        phaseStep("Fix", "Fix", [
          agentStep(
            "Apply i18n fixes",
            "Extract each hardcoded string to a namespaced t() key, add it to BOTH the en and zh blocks of utils/i18n.ts with matching arity and real Chinese, and translate untranslated zh values. Requires fs.edit.\n\nHardcoded: {{ outputs.hardcoded }}\nParity gaps: {{ outputs.missing_keys }}\nUntranslated: {{ outputs.untranslated }}",
            "changes",
          ),
        ]),
        phaseStep("Verify", "Verify", [
          agentStep(
            "Verify build + parity",
            "From apps/jarvis-web run npx tsc -b, npm run lint, npm run test; confirm no hardcoded strings remain and every key exists in both locales. Requires shell.exec. Report PASS or the exact errors.\n\n{{ outputs.changes }}",
          ),
        ]),
      ],
    }),
  },
  {
    id: "spec-to-done",
    name: "需求实现：方案 → 实现 → 验证",
    description:
      "Research the requirement, implement the change, then verify (build + tests). A solid default for coding requirements.",
    build: () => ({
      name: "方案 → 实现 → 验证",
      description: "Research -> implement -> verify recipe for a coding requirement.",
      steps: [
        agentStep(
          "Research & plan",
          "Investigate the codebase for this requirement and produce a concrete implementation plan listing the files to change.",
          "plan",
        ),
        agentStep(
          "Implement",
          "Implement the change following this plan; keep edits minimal and idiomatic. Requires fs.edit.\n\n{{ outputs.plan }}",
          "changes",
        ),
        agentStep(
          "Verify",
          "Build and run the relevant tests; report pass/fail with evidence. Requires shell.exec.\n\n{{ outputs.changes }}",
        ),
      ],
    }),
  },
  {
    id: "code-review",
    name: "代码评审",
    description:
      "Summarize the current diff, review it for bugs and simplifications, then write up findings by severity.",
    build: () => ({
      name: "代码评审",
      description: "Summarize -> review -> report recipe for the current diff.",
      steps: [
        agentStep(
          "Summarize diff",
          "Summarize the current git diff: what changed and why, grouped by area.",
          "summary",
        ),
        agentStep(
          "Review",
          "Review the diff for correctness bugs and reuse/simplification opportunities; cite file:line.\n\n{{ outputs.summary }}",
          "findings",
        ),
        agentStep(
          "Write report",
          "Write a concise review report from these findings, ordered by severity.\n\n{{ outputs.findings }}",
        ),
      ],
    }),
  },
];

export function WorkflowMarketPanel({ onInstalled }: { onInstalled?: () => void }) {
  const [adding, setAdding] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (tpl: WorkflowTemplate) => {
    setAdding(tpl.id);
    setMessage(null);
    setError(null);
    try {
      const def = await createWorkflow(tpl.build());
      onInstalled?.();
      setMessage(t("marketWorkflowAdded", def.name));
    } catch (e: unknown) {
      setError(t("custMktWorkflowAddFailed") + String(e));
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="market-panel" aria-label={t("marketWorkflowTitle")}>
      <div className="market-head">
        <div className="market-title-block">
          <div className="market-title">{t("marketWorkflowTitle")}</div>
          <div className="market-hint">
            {t("custMktWorkflowHint")}
          </div>
        </div>
      </div>
      <ul className="market-list">
        {WORKFLOW_TEMPLATES.map((tpl) => (
          <li key={tpl.id} className="market-item">
            <div className="market-item-main">
              <div className="market-item-title">
                <span>{tpl.name}</span>
              </div>
              <div className="market-item-desc">{tpl.description}</div>
            </div>
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                void add(tpl);
              }}
              disabled={adding !== null}
            >
              {adding === tpl.id ? t("custMktAdding") : t("marketAddBtn")}
            </button>
          </li>
        ))}
      </ul>
      {message && <div className="settings-form-success">{message}</div>}
      {error && <div className="settings-form-error">{error}</div>}
    </div>
  );
}
