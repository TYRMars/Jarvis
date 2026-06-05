// Settings → Memory. Surfaces the self-improving-agent's long-term
// user memory (Phase 1 of docs/proposals/self-improving-agent.zh-CN.md):
// the short, pinnable facts the agent injects into the system prompt on
// the next turn ("user prefers terse answers", "reply in zh-CN", …).
//
// Read/write against /v1/memories (user scope only in Phase 1). Live
// updates arrive over the WS as memory_upserted / memory_deleted frames,
// routed through services/memories.ts so the list stays synced across
// tabs without polling. Returns the "not configured" empty state when
// the server has no memory store wired (503).

import { useEffect, useState } from "react";

import { Section } from "./Section";
import { Button, TextField, Textarea } from "../../ui";
import { t } from "../../../utils/i18n";
import {
  createUserMemory,
  deleteMemory,
  loadUserMemories,
  memoriesLoaded,
  memoriesSnapshot,
  patchMemory,
  subscribeMemories,
  type MemoryItem,
  type MemoryKind,
} from "../../../services/memories";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const KINDS: MemoryKind[] = [
  "preference",
  "fact",
  "lesson",
  "gotcha",
  "convention",
];

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function MemorySection({ embedded }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<LoadState>(
    memoriesLoaded() ? { kind: "ready" } : { kind: "loading" },
  );
  const [tick, setTick] = useState(0);
  const [topError, setTopError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadUserMemories()
      .then(() => {
        if (alive) setState({ kind: "ready" });
      })
      .catch((e: Error) => {
        if (!alive) return;
        // The server returns 503 with "memory store not configured"
        // when no learning store is wired — show the calm empty state
        // rather than a scary error.
        if (/not configured/i.test(e.message)) {
          setState({ kind: "unavailable" });
        } else {
          setState({ kind: "error", message: e.message });
        }
      });
    const unsub = subscribeMemories(() => setTick((n) => n + 1));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // `tick` bumps on every cache change (WS frame or local mutation),
  // forcing a re-render; the snapshot is recomputed inline each time.
  // Reading `tick` keeps the dependency explicit for future readers.
  void tick;
  const memories = memoriesSnapshot();

  const body = () => {
    if (state.kind === "loading") {
      return <p className="settings-empty">{tx("memoryLoading", "Loading…")}</p>;
    }
    if (state.kind === "unavailable") {
      return (
        <p className="settings-empty">
          {tx(
            "memoryUnavailable",
            "Long-term memory is not configured on this server. Set JARVIS_MEMORY_STORE_URL (or leave the default) and restart to enable it.",
          )}
        </p>
      );
    }
    return (
      <>
        <NewMemoryForm onError={setTopError} />
        {topError && (
          <p className="requirement-detail-comment-error" role="alert">
            {tx("memoryErrorPrefix", "Memory error")}: {topError}
          </p>
        )}
        {state.kind === "error" && (
          <p className="requirement-detail-comment-error" role="alert">
            {state.message}
          </p>
        )}
        {memories.length === 0 ? (
          <p className="settings-empty">
            {tx(
              "memoryListEmpty",
              "No long-term memories yet. Add one above, or let the agent learn your preferences as you chat.",
            )}
          </p>
        ) : (
          <ul className="memory-settings-list">
            {memories.map((m) => (
              <MemoryRow key={m.id} memory={m} onError={setTopError} />
            ))}
          </ul>
        )}
      </>
    );
  };

  return (
    <Section
      id="memory"
      titleKey="memorySettingsHeading"
      titleFallback="Memory"
      descKey="memorySettingsDesc"
      descFallback="Long-term facts and preferences the agent recalls across conversations."
      embedded={embedded}
    >
      {body()}
    </Section>
  );
}

// ---------- new-memory inline form ----------------------------------

function NewMemoryForm({ onError }: { onError: (m: string | null) => void }) {
  const [title, setTitle] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [pinned, setPinned] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const tTitle = title.trim();
    const tBody = bodyText.trim();
    if (!tTitle || !tBody) return;
    setPending(true);
    onError(null);
    try {
      await createUserMemory({ title: tTitle, body: tBody, kind, pinned });
      setTitle("");
      setBodyText("");
      setKind("preference");
      setPinned(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="memory-settings-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={tx("memoryAddTitle", "Title")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={pending}
        maxLength={200}
      />
      <Textarea
        label={tx("memoryAddBody", "Detail")}
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        disabled={pending}
        rows={2}
      />
      <div className="memory-settings-add-row">
        <label className="memory-settings-kind">
          <span>{tx("memoryAddKind", "Kind")}</span>
          <select
            className="ui-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as MemoryKind)}
            disabled={pending}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="memory-settings-pin">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
            disabled={pending}
          />
          <span>{tx("memoryAddPin", "Pin")}</span>
        </label>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={pending || !title.trim() || !bodyText.trim()}
        >
          {tx("memoryAddSubmit", "Add memory")}
        </Button>
      </div>
    </form>
  );
}

// ---------- one row -------------------------------------------------

function MemoryRow({
  memory,
  onError,
}: {
  memory: MemoryItem;
  onError: (m: string | null) => void;
}) {
  const [pending, setPending] = useState(false);

  const togglePin = async () => {
    setPending(true);
    onError(null);
    try {
      await patchMemory(memory.id, { pinned: !memory.pinned });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(tx("memoryConfirmDelete", "Delete this memory?"))) return;
    setPending(true);
    onError(null);
    try {
      await deleteMemory(memory.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const agentMade = memory.source?.kind === "agent" || memory.source?.kind === "run";

  return (
    <li className="memory-settings-row">
      <div className="memory-settings-row-main">
        <div className="memory-settings-row-head">
          <span className={`memory-kind-badge memory-kind-${memory.kind}`}>
            {kindLabel(memory.kind)}
          </span>
          {memory.pinned && (
            <span className="memory-pin-badge" title={tx("memoryPinned", "Pinned")}>
              ★
            </span>
          )}
          {agentMade && (
            <span
              className="memory-source-badge"
              title={tx("memoryAgentInferred", "Inferred by the agent")}
            >
              {tx("memoryAgentBadge", "agent")}
            </span>
          )}
          <strong className="memory-settings-row-title">{memory.title}</strong>
        </div>
        <p className="memory-settings-row-body">{memory.body}</p>
        {memory.tags && memory.tags.length > 0 && (
          <div className="memory-settings-row-tags">
            {memory.tags.map((tag) => (
              <span key={tag} className="memory-tag-chip">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="memory-settings-row-actions">
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void togglePin()}>
          {memory.pinned ? tx("memoryUnpin", "Unpin") : tx("memoryPin", "Pin")}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void remove()}>
          {tx("memoryDelete", "Delete")}
        </Button>
      </div>
    </li>
  );
}

function kindLabel(k: MemoryKind): string {
  switch (k) {
    case "preference":
      return tx("memoryKindPreference", "Preference");
    case "fact":
      return tx("memoryKindFact", "Fact");
    case "lesson":
      return tx("memoryKindLesson", "Lesson");
    case "gotcha":
      return tx("memoryKindGotcha", "Gotcha");
    case "convention":
      return tx("memoryKindConvention", "Convention");
  }
}
