import { useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { sendFrame, isOpen } from "../../services/socket";
import { t } from "../../utils/i18n";

function send(frame: any): boolean {
  if (!isOpen()) return false;
  return sendFrame(frame);
}

function statusText(status: string, reason?: string | null): string {
  switch (status) {
    case "approved":
      return t("approved");
    case "denied":
      return t("denied", reason || "");
    case "submitted":
      return t("submitted");
    case "cancelled":
      return t("cancelled");
    case "expired":
      return t("expired");
    default:
      return t("approving");
  }
}

export function AskTextCard({ requestId }: { requestId: string }) {
  const entry = useAppStore((s) => s.hitls.find((c) => c.request.id === requestId));
  const request = entry?.request;
  const defaultText = typeof request?.default_value === "string" ? request.default_value : "";
  const defaultChoice = useMemo(() => {
    if (typeof request?.default_value === "string") return request.default_value;
    return request?.options?.[0]?.value || "";
  }, [request?.default_value, request?.options]);
  const [text, setText] = useState(defaultText);
  const [choice, setChoice] = useState(defaultChoice);
  const [sent, setSent] = useState(false);

  if (!entry || !request) return null;

  const locked = sent || entry.status !== "pending";
  const reply = (status: string, payload?: any, reason?: string | null) => {
    const ok = send({
      type: "hitl_response",
      request_id: request.id,
      status,
      payload,
      reason: reason ?? null,
    });
    if (ok) setSent(true);
  };

  return (
    <div className="ask-card" data-status={entry.status}>
      <div className="ask-title">{request.title}</div>
      {request.body ? <div className="ask-body">{request.body}</div> : null}

      {request.kind === "input" ? (
        <textarea
          className="ask-input"
          rows={(request.metadata && request.metadata.multiline) === false ? 1 : 3}
          value={text}
          disabled={locked}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (!locked) reply("submitted", text);
            }
          }}
        />
      ) : null}

      {request.kind === "choice" ? (
        <select
          className="ask-select"
          value={choice}
          disabled={locked}
          onChange={(e) => setChoice(e.target.value)}
        >
          {(request.options || []).map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : null}

      <div className="ask-actions">
        {request.kind === "confirm" || request.kind === "review" ? (
          <>
            <button type="button" disabled={locked} onClick={() => reply("approved", true)}>
              {t("approve")}
            </button>
            <button type="button" disabled={locked} onClick={() => reply("denied", false)}>
              {t("deny")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={locked}
              onClick={() => reply("submitted", request.kind === "choice" ? choice : text)}
            >
              {t("submit")}
            </button>
            <button type="button" disabled={locked} onClick={() => reply("cancelled", null)}>
              {t("cancel")}
            </button>
          </>
        )}
      </div>
      <div className="ask-status">{statusText(entry.status, entry.reason)}</div>
    </div>
  );
}
