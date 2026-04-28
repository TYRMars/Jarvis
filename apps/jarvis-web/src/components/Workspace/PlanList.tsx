// Workspace plan rail. Renders the agent's structured plan as a
// checklist. Each `plan_update` event from the server replaces the
// whole list (typed snapshot, not patch) — no stitching here.
//
// Status icons mirror the `harness_core::PlanStatus` enum:
//   pending      circle outline
//   in_progress  half-filled circle (animated by CSS)
//   completed    checkmark
//   cancelled    strikethrough X

import { useAppStore } from "../../store/appStore";
import type { PlanItem } from "../../store/appStore";

export function PlanCountSpan() {
  const plan = useAppStore((s) => s.plan);
  return <span id="plan-count">{String(plan.length)}</span>;
}

export function PlanList() {
  const plan = useAppStore((s) => s.plan);
  if (plan.length === 0) {
    return (
      <div className="plan-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6h11" />
          <path d="M9 12h11" />
          <path d="M9 18h11" />
          <path d="m3 6 1 1 2-2" />
          <path d="m3 12 1 1 2-2" />
          <path d="m3 18 1 1 2-2" />
        </svg>
        <strong data-i18n="noPlan">No plan yet.</strong>
        <span data-i18n="planEmptyBody">Jarvis writes the plan here as it explores. Keep chatting.</span>
      </div>
    );
  }
  return (
    <ol className="plan-list" aria-label="Agent plan">
      {plan.map((item) => (
        <PlanRow key={item.id} item={item} />
      ))}
    </ol>
  );
}

function PlanRow({ item }: { item: PlanItem }) {
  const status = item.status;
  return (
    <li className={`plan-item plan-item-${status}`}>
      <span className="plan-status-icon" aria-hidden="true">
        <StatusIcon status={status} />
      </span>
      <div className="plan-item-body">
        <div className="plan-item-title">{item.title}</div>
        {item.note ? <div className="plan-item-note">{item.note}</div> : null}
      </div>
      <span className="plan-status-label">{statusLabel(status)}</span>
    </li>
  );
}

function StatusIcon({ status }: { status: PlanItem["status"] }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (status) {
    case "completed":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m7 12 3 3 7-7" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12h8" />
        </svg>
      );
    case "pending":
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

function statusLabel(status: PlanItem["status"]): string {
  switch (status) {
    case "in_progress":
      return "doing";
    case "completed":
      return "done";
    case "cancelled":
      return "skip";
    case "pending":
    default:
      return "todo";
  }
}
