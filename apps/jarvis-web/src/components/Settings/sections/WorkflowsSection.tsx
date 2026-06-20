// Settings → Workflows. A catalogue of declarative, multi-step agent
// recipes (docs/proposals/declarative-workflows.zh-CN.md). Each workflow
// is an ordered list of agent steps; binding one to a requirement (from
// the requirement detail) makes "working" the card run the whole recipe.
//
// Read/write against /v1/workflows via services/workflows.ts. Returns the
// "not configured" empty state when the server has no workflow store
// wired (503).

import { useEffect, useState } from "react";

import { Section } from "./Section";
import { Button, TextField, Textarea } from "../../ui";
import { t } from "../../../utils/i18n";
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  loadWorkflows,
  newAgentStep,
  runWorkflow,
  stepKindLabel,
  subscribeWorkflows,
  updateWorkflow,
  workflowsLoaded,
  workflowsSnapshot,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStep,
} from "../../../services/workflows";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** A workflow whose top-level steps are all plain agent steps can be
 *  edited in the simple list editor; nested groups are API-only for now. */
function isFlatAgentWorkflow(def: WorkflowDefinition): boolean {
  return def.steps.every((s) => s.kind.type === "agent");
}

export function WorkflowsSection({ embedded }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<LoadState>(
    workflowsLoaded() ? { kind: "ready" } : { kind: "loading" },
  );
  const [tick, setTick] = useState(0);
  const [topError, setTopError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null);

  useEffect(() => {
    let alive = true;
    void loadWorkflows()
      .then(() => {
        if (alive) setState({ kind: "ready" });
      })
      .catch((e: Error) => {
        if (!alive) return;
        if (/not configured/i.test(e.message)) {
          setState({ kind: "unavailable" });
        } else {
          setState({ kind: "error", message: e.message });
        }
      });
    const unsub = subscribeWorkflows(() => setTick((n) => n + 1));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  void tick;
  const workflows = workflowsSnapshot();

  const body = () => {
    if (state.kind === "loading") {
      return <p className="settings-empty">{tx("workflowsLoading", "Loading…")}</p>;
    }
    if (state.kind === "unavailable") {
      return (
        <p className="settings-empty">
          {tx(
            "workflowsUnavailable",
            "Workflows are not configured on this server. Set JARVIS_DB_URL (or leave the default JSON backend) and restart to enable them.",
          )}
        </p>
      );
    }
    return (
      <>
        <WorkflowForm
          key={editing?.id ?? "new"}
          editing={editing}
          onError={setTopError}
          onDone={() => setEditing(null)}
        />
        {topError && (
          <p className="requirement-detail-comment-error" role="alert">
            {tx("workflowsErrorPrefix", "Workflow error")}: {topError}
          </p>
        )}
        {state.kind === "error" && (
          <p className="requirement-detail-comment-error" role="alert">
            {state.message}
          </p>
        )}
        {workflows.length === 0 ? (
          <p className="settings-empty">
            {tx(
              "workflowsListEmpty",
              "No workflows yet. Define one above — a sequence of agent steps the harness runs in order.",
            )}
          </p>
        ) : (
          <ul className="workflow-settings-list">
            {workflows.map((w) => (
              <WorkflowRow
                key={w.id}
                workflow={w}
                onEdit={() => setEditing(w)}
                onError={setTopError}
              />
            ))}
          </ul>
        )}
      </>
    );
  };

  return (
    <Section
      id="workflows"
      titleKey="workflowsSettingsHeading"
      titleFallback="Workflows"
      descKey="workflowsSettingsDesc"
      descFallback="Multi-step agent recipes. Bind one to a requirement to run the whole sequence instead of a single turn."
      embedded={embedded}
    >
      {body()}
    </Section>
  );
}

// ---------- create / edit form -------------------------------------

interface DraftStep {
  name: string;
  prompt: string;
  model: string;
  outputKey: string;
}

function stepToDraft(s: WorkflowStep): DraftStep {
  if (s.kind.type === "agent") {
    return {
      name: s.name,
      prompt: s.kind.prompt,
      model: s.kind.model ?? "",
      outputKey: s.kind.output_key ?? "",
    };
  }
  // Non-agent steps aren't editable in the simple list; show a stub.
  return { name: s.name, prompt: "", model: "", outputKey: "" };
}

function draftToStep(d: DraftStep): WorkflowStep {
  const step = newAgentStep(d.name.trim() || "Step");
  if (step.kind.type === "agent") {
    step.kind.prompt = d.prompt;
    step.kind.model = d.model.trim() || undefined;
    step.kind.output_key = d.outputKey.trim() || undefined;
  }
  return step;
}

function WorkflowForm({
  editing,
  onError,
  onDone,
}: {
  editing: WorkflowDefinition | null;
  onError: (m: string | null) => void;
  onDone: () => void;
}) {
  const flat = !editing || isFlatAgentWorkflow(editing);
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [steps, setSteps] = useState<DraftStep[]>(
    editing && flat
      ? editing.steps.map(stepToDraft)
      : [{ name: "Step 1", prompt: "", model: "", outputKey: "" }],
  );
  const [pending, setPending] = useState(false);

  const setStep = (i: number, patch: Partial<DraftStep>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStep = () =>
    setSteps((prev) => [
      ...prev,
      { name: `Step ${prev.length + 1}`, prompt: "", model: "", outputKey: "" },
    ]);
  const removeStep = (i: number) =>
    setSteps((prev) => prev.filter((_, idx) => idx !== i));

  const canSubmit =
    name.trim().length > 0 &&
    (!flat || steps.some((s) => s.prompt.trim().length > 0));

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    onError(null);
    try {
      if (editing) {
        await updateWorkflow(editing.id, {
          name: name.trim(),
          description: description.trim(),
          // Only rewrite steps when editing a flat workflow; otherwise
          // leave the API-authored nested steps untouched.
          ...(flat
            ? {
                steps: steps
                  .filter((s) => s.prompt.trim().length > 0)
                  .map(draftToStep),
              }
            : {}),
        });
      } else {
        await createWorkflow({
          name: name.trim(),
          description: description.trim() || null,
          steps: steps
            .filter((s) => s.prompt.trim().length > 0)
            .map(draftToStep),
        });
      }
      setName("");
      setDescription("");
      setSteps([{ name: "Step 1", prompt: "", model: "", outputKey: "" }]);
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="workflow-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="workflow-settings-form-head">
        <strong>
          {editing
            ? tx("workflowsEditTitle", "Edit workflow")
            : tx("workflowsNewTitle", "New workflow")}
        </strong>
        {editing && (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            {tx("workflowsCancelEdit", "Cancel")}
          </Button>
        )}
      </div>
      <TextField
        label={tx("workflowsName", "Name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={pending}
        maxLength={120}
      />
      <Textarea
        label={tx("workflowsDescription", "Description")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={pending}
        rows={2}
      />

      {flat ? (
        <div className="workflow-settings-steps">
          {steps.map((s, i) => (
            <div key={i} className="workflow-settings-step">
              <div className="workflow-settings-step-head">
                <span className="workflow-step-index">{i + 1}</span>
                <input
                  className="ui-input workflow-step-name"
                  value={s.name}
                  placeholder={tx("workflowsStepName", "Step name")}
                  onChange={(e) => setStep(i, { name: e.target.value })}
                  disabled={pending}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending || steps.length <= 1}
                  onClick={() => removeStep(i)}
                >
                  {tx("workflowsRemoveStep", "Remove")}
                </Button>
              </div>
              <Textarea
                label={tx("workflowsStepPrompt", "Instruction")}
                value={s.prompt}
                onChange={(e) => setStep(i, { prompt: e.target.value })}
                disabled={pending}
                rows={2}
                placeholder={tx(
                  "workflowsStepPromptPlaceholder",
                  "Use {{ prev }} or {{ outputs.<key> }} to reference earlier steps",
                )}
              />
              <div className="workflow-settings-step-row">
                <input
                  className="ui-input"
                  value={s.model}
                  placeholder={tx("workflowsStepModel", "model (optional)")}
                  onChange={(e) => setStep(i, { model: e.target.value })}
                  disabled={pending}
                />
                <input
                  className="ui-input"
                  value={s.outputKey}
                  placeholder={tx("workflowsStepOutputKey", "output key (optional)")}
                  onChange={(e) => setStep(i, { outputKey: e.target.value })}
                  disabled={pending}
                />
              </div>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={addStep}>
            {tx("workflowsAddStep", "+ Add step")}
          </Button>
        </div>
      ) : (
        <p className="settings-empty">
          {tx(
            "workflowsAdvancedNotice",
            "This workflow uses nested steps (pipeline / phase / parallel). Edit its steps via the API; here you can rename it.",
          )}
        </p>
      )}

      <div className="workflow-settings-form-actions">
        <Button type="submit" variant="primary" size="sm" disabled={pending || !canSubmit}>
          {editing
            ? tx("workflowsSave", "Save changes")
            : tx("workflowsCreate", "Create workflow")}
        </Button>
      </div>
    </form>
  );
}

// ---------- one workflow row ---------------------------------------

function WorkflowRow({
  workflow,
  onEdit,
  onError,
}: {
  workflow: WorkflowDefinition;
  onEdit: () => void;
  onError: (m: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);

  const refreshRuns = async () => {
    try {
      setRuns(await listWorkflowRuns(workflow.id));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const toggleRuns = async () => {
    const next = !runsOpen;
    setRunsOpen(next);
    if (next) await refreshRuns();
  };

  const run = async () => {
    setPending(true);
    onError(null);
    try {
      await runWorkflow(workflow.id);
      if (!runsOpen) setRunsOpen(true);
      await refreshRuns();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(tx("workflowsConfirmDelete", "Delete this workflow?"))) return;
    setPending(true);
    onError(null);
    try {
      await deleteWorkflow(workflow.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="workflow-settings-row">
      <div className="workflow-settings-row-head">
        <strong className="workflow-settings-row-title">{workflow.name}</strong>
        <span className="workflow-settings-row-meta">
          {t("workflowsStepCount", workflow.steps.length)}
        </span>
        <div className="workflow-settings-row-actions">
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void run()}>
            {tx("workflowsRun", "Run")}
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onEdit}>
            {tx("workflowsEdit", "Edit")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void toggleRuns()}>
            {runsOpen ? tx("workflowsHideRuns", "Hide runs") : tx("workflowsShowRuns", "Runs")}
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void remove()}>
            {tx("workflowsDelete", "Delete")}
          </Button>
        </div>
      </div>
      {workflow.description && (
        <p className="workflow-settings-row-desc">{workflow.description}</p>
      )}
      <div className="workflow-settings-row-steps">
        {workflow.steps.map((s, i) => (
          <span key={s.id || i} className="workflow-step-chip">
            {i + 1}. {s.name}
            <em className="workflow-step-chip-kind">{stepKindLabel(s.kind.type)}</em>
          </span>
        ))}
      </div>
      {runsOpen && <WorkflowRuns runs={runs} />}
    </li>
  );
}

export function WorkflowRuns({ runs }: { runs: WorkflowRun[] | null }) {
  if (runs === null) {
    return <p className="settings-empty">{tx("workflowsRunsLoading", "Loading runs…")}</p>;
  }
  if (runs.length === 0) {
    return <p className="settings-empty">{tx("workflowsNoRuns", "No runs yet.")}</p>;
  }
  return (
    <ul className="workflow-runs-list">
      {runs.map((r) => (
        <li key={r.id} className={`workflow-run-item workflow-run-${r.status}`}>
          <div className="workflow-run-head">
            <span className={`workflow-run-badge workflow-run-badge-${r.status}`}>
              {r.status}
            </span>
            <span className="workflow-run-time">{r.started_at}</span>
            {r.error && <span className="workflow-run-error">{r.error}</span>}
          </div>
          <ol className="workflow-run-steps">
            {r.step_results.map((s) => (
              <li key={s.step_id} className={`workflow-run-step workflow-run-step-${s.status}`}>
                <span className="workflow-run-step-name">{s.name}</span>
                <span className={`workflow-run-step-status workflow-run-step-status-${s.status}`}>
                  {s.status}
                </span>
                {s.output && (
                  <span className="workflow-run-step-output">
                    {s.output.length > 160 ? `${s.output.slice(0, 160)}…` : s.output}
                  </span>
                )}
                {s.error && <span className="workflow-run-step-err">{s.error}</span>}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}
