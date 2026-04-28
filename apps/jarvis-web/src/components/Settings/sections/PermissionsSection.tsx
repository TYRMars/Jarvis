// Settings → Permissions: list current rules grouped by bucket,
// inline-add a new rule, and pick the persisted default mode.
//
// Source of truth lives on the server — this section refetches
// `/v1/permissions` whenever the WS reports a rule change
// (`permissionRulesVersion` bumps) so concurrent edits from
// another window or a CLI session show up here. The mode shown
// here is the *persisted* default; the per-socket mode (set via
// the chat-header `ModeBadge`) lives in `appStore.permissionMode`
// and isn't editable from this section.

import { useEffect, useState } from "react";
import { useAppStore } from "../../../store/appStore";
import { Row, Section } from "./Section";
import { t } from "../../../utils/i18n";
import {
  appendRule,
  deleteRule,
  fetchPermissionTable,
  setDefaultMode,
  type Decision,
  type PermissionMode,
  type PermissionTable,
  type Scope,
  type ScopedRule,
} from "../../../services/permissions";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const MODES: Array<{ mode: PermissionMode; key: string; fallback: string }> = [
  { mode: "ask", key: "permModeAsk", fallback: "Ask" },
  { mode: "accept-edits", key: "permModeAcceptEdits", fallback: "Accept edits" },
  { mode: "plan", key: "permModePlan", fallback: "Plan" },
  { mode: "auto", key: "permModeAuto", fallback: "Auto" },
  { mode: "bypass", key: "permModeBypass", fallback: "Bypass" },
];

const BUCKETS: Array<{ bucket: Decision; key: string; fallback: string }> = [
  { bucket: "deny", key: "settingsPermsBucketDeny", fallback: "Deny" },
  { bucket: "ask", key: "settingsPermsBucketAsk", fallback: "Ask" },
  { bucket: "allow", key: "settingsPermsBucketAllow", fallback: "Allow" },
];

const SCOPES: Array<{ scope: Scope; key: string; fallback: string }> = [
  { scope: "session", key: "scopeSession", fallback: "Session" },
  { scope: "project", key: "scopeProject", fallback: "Project (committed)" },
  { scope: "user", key: "scopeUser", fallback: "User (private)" },
];

export function PermissionsSection() {
  const version = useAppStore((s) => s.permissionRulesVersion);
  const [table, setTable] = useState<PermissionTable | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchPermissionTable()
      .then((t) => {
        if (!alive) return;
        if (t == null) {
          setUnavailable(true);
          setTable(null);
        } else {
          setUnavailable(false);
          setTable(t);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [version]);

  return (
    <Section
      id="permissions"
      titleKey="settingsPermsTitle"
      titleFallback="Permissions"
      descKey="settingsPermsDesc"
      descFallback="Five modes set the default decision; rules are an override list. Eval order: deny → ask → allow → mode default."
    >
      {unavailable ? (
        <div className="settings-empty">
          {tx(
            "settingsPermsUnavailable",
            "Permission store not configured. Restart with --workspace pointing at a writable directory.",
          )}
        </div>
      ) : loading || table == null ? (
        <div className="settings-empty">…</div>
      ) : (
        <PermissionsBody table={table} />
      )}
    </Section>
  );
}

function PermissionsBody({ table }: { table: PermissionTable }) {
  return (
    <>
      <Row
        label={tx("settingsPermsCurrentMode", "Default mode")}
        hint={tx(
          "settingsPermsCurrentModeHint",
          "What happens when no rule matches a tool call.",
        )}
      >
        <ModePicker current={table.default_mode} />
      </Row>

      <div className="settings-row settings-row-stack">
        <div className="settings-row-label">
          <div>{tx("settingsPermsRules", "Rules")}</div>
        </div>
        <div className="settings-row-control settings-stack">
          {BUCKETS.map((b) => (
            <RuleBucket
              key={b.bucket}
              bucket={b.bucket}
              label={tx(b.key, b.fallback)}
              rules={table[b.bucket]}
            />
          ))}
          <AddRuleForm />
        </div>
      </div>
    </>
  );
}

function ModePicker({ current }: { current: PermissionMode }) {
  // The persisted mode is written to user-scope by default — the
  // safest place that stays out of git but follows the user across
  // projects on the same machine.
  const [scope, setScope] = useState<Scope>("user");
  const [busy, setBusy] = useState<PermissionMode | null>(null);

  return (
    <div className="settings-stack">
      <div className="settings-pill-group" role="radiogroup" aria-label={tx("permModePicker", "Pick a mode")}>
        {MODES.map((opt) => {
          const selected = opt.mode === current;
          // Bypass + project scope is server-rejected (committing
          // bypass to git would silently disable approval for every
          // teammate). Disable the pill in that combination so the
          // user gets a clear hover hint instead of a 400 banner.
          const projectBypass = opt.mode === "bypass" && scope === "project";
          return (
            <button
              key={opt.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              className={
                "settings-pill" +
                (selected ? " active" : "") +
                (opt.mode === "bypass" ? " danger" : "")
              }
              disabled={busy != null || projectBypass}
              title={
                projectBypass
                  ? tx(
                      "settingsPermsBypassProjectBlocked",
                      "Bypass cannot be saved to project scope (would commit to git).",
                    )
                  : tx(opt.key, opt.fallback)
              }
              onClick={async () => {
                if (selected) return;
                if (opt.mode === "bypass") {
                  const ok = window.confirm(tx("permModeBypassConfirm", ""));
                  if (!ok) return;
                }
                setBusy(opt.mode);
                await setDefaultMode(scope, opt.mode);
                setBusy(null);
              }}
            >
              {tx(opt.key, opt.fallback)}
            </button>
          );
        })}
      </div>
      <label className="settings-toggle">
        <span className="settings-toggle-label">{tx("settingsPermsRuleScope", "Scope")}</span>
        <select
          className="settings-input"
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
        >
          {SCOPES.map((s) => (
            <option key={s.scope} value={s.scope}>
              {tx(s.key, s.fallback)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function RuleBucket({
  bucket,
  label,
  rules,
}: {
  bucket: Decision;
  label: string;
  rules: ScopedRule[];
}) {
  if (rules.length === 0) {
    return (
      <div className="perm-bucket">
        <div className="perm-bucket-title">{label}</div>
        <div className="perm-bucket-empty">—</div>
      </div>
    );
  }
  return (
    <div className="perm-bucket">
      <div className="perm-bucket-title">{label}</div>
      <ul className="perm-rule-list">
        {rules.map((r, idx) => (
          <RuleRow key={`${bucket}-${idx}-${r.tool}`} bucket={bucket} index={idx} rule={r} />
        ))}
      </ul>
    </div>
  );
}

function RuleRow({
  bucket,
  index,
  rule,
}: {
  bucket: Decision;
  index: number;
  rule: ScopedRule;
}) {
  const [busy, setBusy] = useState(false);
  const matchers = rule.matchers ?? {};
  const matcherEntries = Object.entries(matchers);
  return (
    <li className="perm-rule">
      <div className="perm-rule-main">
        <span className="perm-rule-tool">{rule.tool}</span>
        <span className="perm-rule-scope" data-scope={rule.scope}>
          {tx(`scope${capitalise(rule.scope)}`, rule.scope)}
        </span>
        {matcherEntries.length > 0 ? (
          <span className="perm-rule-matchers">
            {matcherEntries.map(([ptr, pat]) => (
              <span key={ptr} className="perm-rule-matcher">
                <code>{ptr}</code> = <code>{pat}</code>
              </span>
            ))}
          </span>
        ) : (
          <span className="perm-rule-matchers muted">(any args)</span>
        )}
      </div>
      <button
        type="button"
        className="settings-btn settings-btn-ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await deleteRule({ scope: rule.scope, bucket, index });
          // The server fans `permission_rules_changed` over the WS
          // which bumps `permissionRulesVersion` and refetches —
          // no local state mutation needed here.
          setBusy(false);
        }}
      >
        {tx("settingsPermsRuleDelete", "Delete")}
      </button>
    </li>
  );
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

interface DraftMatcher {
  pointer: string;
  pattern: string;
}

function AddRuleForm() {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState("");
  const [bucket, setBucket] = useState<Decision>("allow");
  const [scope, setScope] = useState<Scope>("user");
  const [matchers, setMatchers] = useState<DraftMatcher[]>([]);
  const [busy, setBusy] = useState(false);

  function reset() {
    setTool("");
    setBucket("allow");
    setScope("user");
    setMatchers([]);
  }

  if (!open) {
    return (
      <button
        type="button"
        className="settings-btn settings-btn-secondary perm-add-btn"
        onClick={() => setOpen(true)}
      >
        {tx("settingsPermsAddRule", "Add rule")}
      </button>
    );
  }

  return (
    <div className="perm-add-form">
      <Row
        label={tx("settingsPermsRuleTool", "Tool")}
        hint={tx(
          "settingsPermsRuleToolHint",
          'Tool name (e.g. "shell.exec") or "*" for any tool.',
        )}
      >
        <input
          className="settings-input"
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          placeholder="shell.exec"
        />
      </Row>

      <Row label={tx("settingsPermsRuleBucket", "Decision")}>
        <div className="settings-pill-group" role="radiogroup">
          {BUCKETS.map((b) => (
            <button
              key={b.bucket}
              type="button"
              role="radio"
              aria-checked={bucket === b.bucket}
              className={"settings-pill" + (bucket === b.bucket ? " active" : "")}
              onClick={() => setBucket(b.bucket)}
            >
              {tx(b.key, b.fallback)}
            </button>
          ))}
        </div>
      </Row>

      <Row label={tx("settingsPermsRuleScope", "Scope")}>
        <select
          className="settings-input"
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
        >
          {SCOPES.map((s) => (
            <option key={s.scope} value={s.scope}>
              {tx(s.key, s.fallback)}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label={tx("settingsPermsRuleMatcher", "Matcher")}
        hint={tx(
          "settingsPermsRuleMatcherHint",
          "JSON pointer (e.g. /command) → glob pattern. Leave blank to match every call.",
        )}
      >
        <div className="settings-stack">
          {matchers.map((m, i) => (
            <div key={i} className="perm-matcher-row">
              <input
                className="settings-input"
                placeholder="/command"
                value={m.pointer}
                onChange={(e) => {
                  const next = matchers.slice();
                  next[i] = { ...m, pointer: e.target.value };
                  setMatchers(next);
                }}
              />
              <input
                className="settings-input"
                placeholder="npm test"
                value={m.pattern}
                onChange={(e) => {
                  const next = matchers.slice();
                  next[i] = { ...m, pattern: e.target.value };
                  setMatchers(next);
                }}
              />
              <button
                type="button"
                className="settings-btn settings-btn-ghost"
                onClick={() => setMatchers(matchers.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="settings-btn settings-btn-ghost perm-add-matcher"
            onClick={() => setMatchers([...matchers, { pointer: "", pattern: "" }])}
          >
            {tx("settingsPermsAddMatcher", "+ matcher")}
          </button>
        </div>
      </Row>

      <div className="settings-input-row">
        <button
          type="button"
          className="settings-btn"
          disabled={busy || tool.trim().length === 0}
          onClick={async () => {
            setBusy(true);
            const matcherMap: Record<string, string> = {};
            for (const m of matchers) {
              const ptr = m.pointer.trim();
              const pat = m.pattern.trim();
              if (ptr.length > 0 && pat.length > 0) matcherMap[ptr] = pat;
            }
            const ok = await appendRule({
              scope,
              bucket,
              rule: {
                tool: tool.trim(),
                ...(Object.keys(matcherMap).length > 0 ? { matchers: matcherMap } : {}),
              },
            });
            setBusy(false);
            if (ok) {
              reset();
              setOpen(false);
            }
          }}
        >
          {tx("settingsPermsRuleSave", "Save rule")}
        </button>
        <button
          type="button"
          className="settings-btn settings-btn-ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          {tx("settingsPermsRuleCancel", "Cancel")}
        </button>
      </div>
    </div>
  );
}
