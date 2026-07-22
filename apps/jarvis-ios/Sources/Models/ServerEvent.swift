import Foundation

/// One frame from `GET /v1/chat/ws`. Covers the `AgentEvent` variants
/// the app renders plus the transport bookkeeping frames; everything
/// else degrades to `.ignored` so new server frames never crash the UI.
///
/// Frames are decoded leniently from a generic JSON object keyed on
/// `type` (snake_case), matching the serde tagging of
/// `harness_core::AgentEvent` and the WS frames in
/// `harness-server/src/routes.rs`.
enum ServerEvent {
    // --- AgentEvent variants ---
    case delta(content: String)
    case assistantMessage(message: ChatMessage)
    case approvalRequest(id: String, name: String, arguments: JSONValue)
    case approvalDecision(id: String, name: String, approved: Bool, reason: String?)
    case toolStart(id: String, name: String, arguments: JSONValue)
    case toolProgress(id: String, stream: String, chunk: String)
    case toolEnd(id: String, name: String, content: String)
    /// Full snapshot of the agent's working plan (replace, not patch).
    case planUpdate(items: [PlanItem])
    /// One frame from a running subagent (`subagent.<name>` tool).
    case subagent(frame: SubagentFrame)
    /// The memory backend compacted history before an LLM call.
    case memoryCompacted(source: String, turnsDropped: Int)
    /// The provider fallback chain kicked in mid-turn.
    case providerFallback(from: String, to: String, reason: String)
    case usage(model: String, promptTokens: Int?, completionTokens: Int?,
               cachedTokens: Int?)
    /// Plan Mode: the agent finished read-only investigation and
    /// proposed a plan. A `done` follows — the turn is over until the
    /// user accepts (`accept_plan`) or refines (`refine_plan`).
    case planProposed(plan: String)
    case done
    case error(message: String)

    // --- permission / routing frames ---
    /// Current per-socket permission mode. Sent on connect and after
    /// `set_mode` / `accept_plan` / a tool-initiated `mode_changed`.
    /// `mode` is kebab-case (`ask` / `accept-edits` / `plan` / `auto`
    /// / `bypass`); `via` is `"tool"` / `"plan_accepted"` when the
    /// switch wasn't a direct user action.
    case permissionMode(mode: String, via: String?)
    /// Acknowledges a `configure` frame — the socket's sticky
    /// provider/model selection that subsequent turns route to.
    case configured(provider: String?, model: String?)

    // --- transport frames ---
    case started(id: String)
    /// `live` is true when a turn is still running server-side — the
    /// socket is attached to its broadcast tail and missed events
    /// replay right after this frame.
    case resumed(id: String, messageCount: Int, live: Bool)
    /// Replay of an approval the agent is *still* blocked on, sent
    /// after `resumed` so a reconnecting client re-prompts the user.
    case approvalPending(id: String, name: String, arguments: JSONValue)
    /// Brackets the snapshot replay on a `resume { after_seq }`.
    /// `firstSeq` is the oldest seq retained server-side — a gap
    /// versus the client's high-water mark means events were evicted.
    case tailReplayStart(firstSeq: UInt64?)
    case tailReplayDone
    /// The requested `after_seq` cursor was evicted from the ring
    /// buffer — the client must do a full REST history reload.
    case resumeError(reason: String)
    case interrupted
    case reset

    /// Any frame the app doesn't render (mode_changed, broadcast
    /// frames, …). Carries the type tag for debugging.
    case ignored(type: String)

    // MARK: decoding

    /// Decodes one WS text frame. The returned `seq` is the
    /// per-conversation sequence number the server stamps onto
    /// replayable frames — track the high-water mark to resume with
    /// `after_seq` after a disconnect.

    static func decode(_ text: String) -> (event: ServerEvent, seq: UInt64?)? {
        guard let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let obj = value.objectValue,
              let type = obj["type"]?.stringValue
        else { return nil }

        let seq = obj["seq"]?.intValue.map(UInt64.init)
        let event = decodeTyped(type: type, obj: obj, raw: data)
        return (event, seq)
    }

    private static func decodeTyped(
        type: String, obj: [String: JSONValue], raw: Data
    ) -> ServerEvent {
        switch type {
        case "delta":
            return .delta(content: obj["content"]?.stringValue ?? "")

        case "assistant_message":
            struct Frame: Codable { let message: ChatMessage }
            if let f = try? JSONDecoder().decode(Frame.self, from: raw) {
                return .assistantMessage(message: f.message)
            }
            return .ignored(type: type)

        case "approval_request":
            return .approvalRequest(
                id: obj["id"]?.stringValue ?? "",
                name: obj["name"]?.stringValue ?? "",
                arguments: obj["arguments"] ?? .null)

        case "approval_decision":
            // `decision` is internally tagged:
            //   {"decision":"approve"} | {"decision":"deny","reason":...}
            let decision = obj["decision"]
            let kind = decision?["decision"]?.stringValue ?? ""
            return .approvalDecision(
                id: obj["id"]?.stringValue ?? "",
                name: obj["name"]?.stringValue ?? "",
                approved: kind == "approve",
                reason: decision?["reason"]?.stringValue)

        case "tool_start":
            return .toolStart(
                id: obj["id"]?.stringValue ?? "",
                name: obj["name"]?.stringValue ?? "",
                arguments: obj["arguments"] ?? .null)

        case "tool_progress":
            return .toolProgress(
                id: obj["id"]?.stringValue ?? "",
                stream: obj["stream"]?.stringValue ?? "",
                chunk: obj["chunk"]?.stringValue ?? "")

        case "tool_end":
            return .toolEnd(
                id: obj["id"]?.stringValue ?? "",
                name: obj["name"]?.stringValue ?? "",
                content: obj["content"]?.stringValue ?? "")

        case "plan_update":
            let items = (obj["items"]?.arrayValue ?? [])
                .compactMap(PlanItem.init(json:))
            return .planUpdate(items: items)

        case "sub_agent_event":
            if let frame = obj["frame"].flatMap(SubagentFrame.init(json:)) {
                return .subagent(frame: frame)
            }
            return .ignored(type: type)

        case "memory_compacted":
            let info = obj["info"]
            return .memoryCompacted(
                source: info?["source"]?.stringValue ?? "",
                turnsDropped: info?["turns_dropped"]?.intValue ?? 0)

        case "provider_fallback":
            let event = obj["event"]
            return .providerFallback(
                from: event?["from"]?.stringValue ?? "?",
                to: event?["to"]?.stringValue ?? "?",
                reason: event?["reason"]?.stringValue ?? "")

        case "usage":
            return .usage(
                model: obj["model"]?.stringValue ?? "",
                promptTokens: obj["prompt_tokens"]?.intValue,
                completionTokens: obj["completion_tokens"]?.intValue,
                cachedTokens: obj["cached_prompt_tokens"]?.intValue)

        case "plan_proposed":
            return .planProposed(plan: obj["plan"]?.stringValue ?? "")

        case "permission_mode":
            return .permissionMode(
                mode: obj["mode"]?.stringValue ?? "ask",
                via: obj["via"]?.stringValue)

        case "configured":
            return .configured(
                provider: obj["provider"]?.stringValue,
                model: obj["model"]?.stringValue)

        case "done":
            return .done

        case "error":
            return .error(message: obj["message"]?.stringValue ?? "unknown error")

        // `session` is the Node server's ack for a `new` frame (the
        // Rust server used `started`); both establish the persisted
        // conversation id, so they decode to the same case. See #492.
        case "session", "started":
            return .started(id: obj["id"]?.stringValue ?? "")

        case "resumed":
            return .resumed(
                id: obj["id"]?.stringValue ?? "",
                messageCount: obj["message_count"]?.intValue ?? 0,
                live: obj["live"]?.boolValue ?? false)

        case "approval_pending":
            return .approvalPending(
                id: obj["id"]?.stringValue ?? "",
                name: obj["name"]?.stringValue ?? "",
                arguments: obj["arguments"] ?? .null)

        case "tail_replay_start":
            return .tailReplayStart(
                firstSeq: obj["first_seq"]?.intValue.map(UInt64.init))

        case "tail_replay_done":
            return .tailReplayDone

        case "resume_error":
            return .resumeError(reason: obj["reason"]?.stringValue ?? "unknown")

        case "interrupted":
            return .interrupted

        case "reset":
            return .reset

        default:
            return .ignored(type: type)
        }
    }
}
