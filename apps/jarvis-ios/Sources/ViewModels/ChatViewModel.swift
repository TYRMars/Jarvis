import Foundation
import Observation

/// One entry in the rendered transcript.
struct TranscriptItem: Identifiable {
    enum Kind {
        case user(String)
        case assistant(String)
        case tool(name: String, arguments: String, output: String?, denied: Bool)
        case subagent(SubagentCard)
        case info(String)
        case error(String)
    }

    let id: String
    var kind: Kind

    init(id: String = UUID().uuidString, kind: Kind) {
        self.id = id
        self.kind = kind
    }
}

/// Rendering state for one subagent invocation; updated in place as
/// `sub_agent_event` frames stream in.
struct SubagentCard {
    enum Status { case running, done, failed }

    var name: String
    var task: String = ""
    var model: String?
    var status: Status = .running
    /// Accumulated assistant deltas, tail-trimmed so a chatty
    /// subagent can't grow one transcript item unboundedly.
    var text: String = ""
    /// Last status line / currently-running tool, shown muted.
    var activity: String?
    var toolCount: Int = 0
    var finalMessage: String?
}

/// Latest provider-reported token usage. One `usage` event arrives
/// per LLM iteration; the newest prompt size is the current context.
struct UsageDisplay {
    var model: String
    var promptTokens: Int?
    var completionTokens: Int?
    var cachedTokens: Int?

    var compactLine: String {
        var parts: [String] = model.isEmpty ? [] : [model]
        if let p = promptTokens { parts.append("↑\(Self.compact(p))") }
        if let c = completionTokens { parts.append("↓\(Self.compact(c))") }
        if let cached = cachedTokens, cached > 0 {
            parts.append("缓存 \(Self.compact(cached))")
        }
        return parts.joined(separator: " · ")
    }

    private static func compact(_ n: Int) -> String {
        n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }
}

/// A pending `approval_request` waiting on the user.
struct PendingApproval: Identifiable {
    let id: String      // tool_call_id
    let name: String
    let arguments: JSONValue
}

@MainActor
@Observable
final class ChatViewModel {
    // MARK: rendered state
    private(set) var items: [TranscriptItem] = []
    private(set) var isStreaming = false
    private(set) var isReconnecting = false
    private(set) var connectionError: String?
    private(set) var plan: [PlanItem] = []
    private(set) var usage: UsageDisplay?
    var pendingApproval: PendingApproval?
    var draft = ""

    /// Current per-socket permission mode (kebab-case, e.g. `"ask"`,
    /// `"plan"`). Mirrors the server's `permission_mode` frames.
    private(set) var permissionMode = "ask"
    /// Set when the agent proposes a plan in Plan Mode; the chat
    /// surfaces an accept / refine card until the user resolves it.
    private(set) var proposedPlan: String?

    /// Provider/model catalog from `GET /v1/providers`.
    private(set) var providers: [ProviderInfo] = []
    private var defaultProviderName: String?
    /// Explicit user routing choice; `nil` means "use the server
    /// default". Persisted across reconnects by re-sending `configure`.
    private(set) var selectedProvider: String?
    private(set) var selectedModel: String?

    /// Provider/model the next turn will route to, falling back to
    /// the server default — drives the picker's current-selection label.
    var currentProviderName: String? {
        selectedProvider ?? defaultProviderName
    }
    var currentModel: String? {
        if let selectedModel { return selectedModel }
        return providers.first { $0.name == currentProviderName }?.defaultModel
    }

    /// Persisted conversation id. Set up front when opening an
    /// existing conversation; assigned by the first `start_turn` for
    /// a new one.
    private(set) var conversationId: String?

    private let api = JarvisAPI()
    private let socket = ChatSocket()
    /// True until the socket has entered persisted mode — decides
    /// between `start_turn` and a plain `user` frame. Existing
    /// conversations flip it when the eager `resume` is sent on
    /// connect; new ones after their first `start_turn`.
    private var needsStartTurn = true
    /// Index into `items` of the assistant bubble currently being
    /// streamed into, if any.
    private var streamingIndex: Int?
    /// tool_call_id → index into `items` for in-flight tool cards.
    private var toolIndex: [String: Int] = [:]
    /// subagent_id → index into `items` for in-flight subagent cards.
    private var subagentIndex: [String: Int] = [:]

    // MARK: reconnect machinery

    /// High-water mark of the server's `seq` stamps — the
    /// `resume { after_seq }` cursor. Owned here (not on the socket)
    /// so the cursor and the replay-gap check share one serially-
    /// updated value.
    private var lastSeq: UInt64?
    /// Incremented per `openSocket()`; stale event loops compare
    /// against it and bail instead of double-handling frames or
    /// scheduling a duplicate reconnect.
    private var socketGeneration = 0
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    /// Set by `stop()` — suppresses reconnection during teardown.
    private var stopped = false

    init(conversationId: String? = nil) {
        self.conversationId = conversationId
    }

    // MARK: lifecycle

    func start() async {
        stopped = false
        // Populate the model picker without blocking the socket.
        Task { await loadProviders() }
        if let id = conversationId {
            await loadHistory(id: id)
        }
        openSocket()
    }

    func stop() {
        stopped = true
        reconnectTask?.cancel()
        socket.disconnect()
        isStreaming = false
        isReconnecting = false
    }

    /// Called when the app returns to the foreground — skip any
    /// pending backoff and reconnect immediately if the socket died
    /// while we were suspended.
    func ensureConnected() {
        guard !stopped, !socket.isConnected else { return }
        reconnectTask?.cancel()
        openSocket()
    }

    // MARK: user intents

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming else { return }
        guard socket.isConnected else {
            connectionError = "尚未连接服务器,正在重连…"
            ensureConnected()
            return
        }
        draft = ""
        items.append(TranscriptItem(kind: .user(text)))
        isStreaming = true
        streamingIndex = nil

        Task {
            do {
                if needsStartTurn {
                    let mode: String
                    let id: String
                    if let existing = conversationId {
                        mode = "resume"
                        id = existing
                    } else {
                        mode = "new"
                        id = UUID().uuidString
                        conversationId = id
                    }
                    try await socket.send(.startTurn(mode: mode, id: id, content: text))
                    needsStartTurn = false
                } else {
                    try await socket.send(.user(content: text))
                }
            } catch {
                finishTurn(error: "发送失败: \(error.localizedDescription)")
            }
        }
    }

    func interrupt() {
        Task { try? await socket.send(.interrupt) }
    }

    func resolveApproval(approve: Bool, reason: String? = nil) {
        guard let pending = pendingApproval else { return }
        pendingApproval = nil
        Task {
            do {
                if approve {
                    try await socket.send(.approve(toolCallId: pending.id))
                } else {
                    try await socket.send(.deny(toolCallId: pending.id, reason: reason))
                }
            } catch {
                items.append(TranscriptItem(kind: .error("审批发送失败: \(error.localizedDescription)")))
            }
        }
    }

    /// Switch the per-socket permission mode (e.g. into `"plan"` so
    /// the next message triggers read-only investigation). The server
    /// echoes a `permission_mode` frame we mirror into `permissionMode`.
    func setMode(_ mode: String) {
        guard socket.isConnected, !isStreaming else { return }
        Task { try? await socket.send(.setMode(mode: mode)) }
    }

    /// Accept the proposed plan, switch to `postMode`, and let the
    /// server spawn the execution turn.
    func acceptPlan(postMode: String) {
        guard proposedPlan != nil else { return }
        proposedPlan = nil
        isStreaming = true
        streamingIndex = nil
        Task {
            do {
                try await socket.send(.acceptPlan(postMode: postMode))
            } catch {
                finishTurn(error: "接受计划失败: \(error.localizedDescription)")
            }
        }
    }

    /// Send refinement feedback for the proposed plan — a labelled
    /// user turn that re-runs the agent (still in Plan Mode).
    func refinePlan(_ feedback: String) {
        let text = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, proposedPlan != nil else { return }
        proposedPlan = nil
        items.append(TranscriptItem(kind: .user("优化计划:\(text)")))
        isStreaming = true
        streamingIndex = nil
        Task {
            do {
                try await socket.send(.refinePlan(feedback: text))
            } catch {
                finishTurn(error: "发送失败: \(error.localizedDescription)")
            }
        }
    }

    /// Pick the provider/model subsequent turns route to. Stores the
    /// choice (survives reconnects) and pushes it to the socket now.
    func selectModel(provider: String, model: String) {
        selectedProvider = provider
        selectedModel = model
        guard socket.isConnected, !isStreaming else { return }
        Task { try? await socket.send(.configure(model: model, provider: provider)) }
    }

    // MARK: private — providers

    private func loadProviders() async {
        do {
            let response = try await api.listProviders()
            providers = response.providers
            defaultProviderName = response.default
                ?? response.providers.first { $0.isDefault }?.name
        } catch {
            // Non-fatal — the picker just stays empty (single-model
            // deployments don't need it).
        }
    }

    // MARK: private — connection

    private func openSocket() {
        socketGeneration += 1
        let generation = socketGeneration
        do {
            let events = try socket.connect()
            connectionError = nil
            // `Task {}` inherits this view model's MainActor context,
            // so handling events here is actor-safe.
            Task { [weak self] in
                guard let self else { return }
                // Enter persisted mode up front for an existing
                // conversation: a live run's missed events replay
                // (`after_seq` = our high-water mark) and blocked
                // approvals re-prompt. Send failures surface via the
                // receive loop closing.
                if let id = self.conversationId {
                    try? await self.socket.send(
                        .resume(id: id, afterSeq: self.lastSeq))
                    self.needsStartTurn = false
                }
                // The socket's sticky routing is per-connection — a
                // reconnect resets it server-side, so re-push any
                // explicit user choice. (No-op when no turn is running.)
                if let model = self.selectedModel {
                    try? await self.socket.send(
                        .configure(model: model, provider: self.selectedProvider))
                }
                for await (event, seq) in events {
                    guard self.socketGeneration == generation else { return }
                    if self.isReconnecting { self.isReconnecting = false }
                    if self.reconnectAttempt != 0 { self.reconnectAttempt = 0 }
                    if let seq { self.lastSeq = seq }
                    self.handle(event)
                }
                // Socket closed. A server-side run may still be in
                // flight — reconnect and let `resume` replay what we
                // missed instead of declaring the turn dead.
                guard self.socketGeneration == generation, !self.stopped else { return }
                self.scheduleReconnect()
            }
        } catch {
            // `connect()` only throws on a bad URL — retrying won't
            // fix that; the settings screen will.
            connectionError = error.localizedDescription
        }
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        isReconnecting = true
        // A brand-new conversation that never started its first turn
        // has nothing server-side to resume — fail the turn loudly.
        if isStreaming && conversationId == nil {
            finishTurn(error: "连接已断开")
        }
        reconnectAttempt += 1
        let delay = min(0.5 * pow(2, Double(reconnectAttempt - 1)), 10)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, !self.stopped else { return }
            self.openSocket()
        }
    }

    // MARK: private — history

    private func loadHistory(id: String) async {
        do {
            let detail = try await api.getConversation(id: id)
            items = Self.transcript(from: detail.messages)
        } catch {
            connectionError = error.localizedDescription
        }
    }

    /// Full reload from the store — the catch-up path when replay
    /// can't bridge the gap (cursor evicted, or the run finished
    /// while we were disconnected). Drops the in-place update maps:
    /// their indices point into the old `items`.
    private func reloadHistory() async {
        guard let id = conversationId else { return }
        do {
            let detail = try await api.getConversation(id: id)
            items = Self.transcript(from: detail.messages)
            toolIndex = [:]
            subagentIndex = [:]
            streamingIndex = nil
        } catch {
            connectionError = error.localizedDescription
        }
    }

    // MARK: private — event handling

    private func handle(_ event: ServerEvent) {
        switch event {
        case .delta(let content):
            appendDelta(content)

        case .assistantMessage(let message):
            // Streaming deltas already built the visible text; the
            // complete message only matters when no deltas arrived
            // (non-streaming providers) — then render it whole.
            if case .assistant(let content, _) = message,
               let content, !content.isEmpty, streamingIndex == nil {
                items.append(TranscriptItem(kind: .assistant(content)))
            }
            // Tool calls render via tool_start/tool_end events.
            streamingIndex = nil

        case .approvalRequest(let id, let name, let arguments),
             .approvalPending(let id, let name, let arguments):
            pendingApproval = PendingApproval(id: id, name: name, arguments: arguments)

        case .approvalDecision(let id, _, let approved, _):
            if pendingApproval?.id == id { pendingApproval = nil }
            if !approved, let idx = toolIndex[id],
               case .tool(let name, let args, _, _) = items[idx].kind {
                items[idx].kind = .tool(name: name, arguments: args, output: nil, denied: true)
            }

        case .toolStart(let id, let name, let arguments):
            streamingIndex = nil
            let item = TranscriptItem(
                kind: .tool(name: name, arguments: arguments.prettyPrinted,
                            output: nil, denied: false))
            toolIndex[id] = items.count
            items.append(item)

        case .toolProgress(let id, _, let chunk):
            if let idx = toolIndex[id],
               case .tool(let name, let args, let output, let denied) = items[idx].kind {
                items[idx].kind = .tool(
                    name: name, arguments: args,
                    output: (output ?? "") + chunk, denied: denied)
            }

        case .toolEnd(let id, let name, let content):
            if let idx = toolIndex[id],
               case .tool(let cardName, let args, _, let denied) = items[idx].kind {
                items[idx].kind = .tool(
                    name: cardName, arguments: args, output: content, denied: denied)
            } else if toolIndex[id] == nil {
                // The matching tool_start predates a history reload —
                // render a completed card rather than dropping it.
                toolIndex[id] = items.count
                items.append(TranscriptItem(
                    kind: .tool(name: name, arguments: "{}",
                                output: content,
                                denied: content.hasPrefix("tool denied:"))))
            }

        case .planUpdate(let newPlan):
            plan = newPlan

        case .subagent(let frame):
            handleSubagent(frame)

        case .memoryCompacted(let source, let turnsDropped):
            if source != "no_op", turnsDropped > 0 {
                items.append(TranscriptItem(
                    kind: .info("记忆已压缩,折叠了 \(turnsDropped) 轮较早的对话")))
            }

        case .providerFallback(let from, let to, let reason):
            items.append(TranscriptItem(
                kind: .info("模型回退:\(from) → \(to)(\(reason))")))

        case .usage(let model, let prompt, let completion, let cached):
            usage = UsageDisplay(
                model: model, promptTokens: prompt,
                completionTokens: completion, cachedTokens: cached)

        case .planProposed(let plan):
            // The matching `done` flips isStreaming off; the card
            // waits on the user to accept or refine.
            proposedPlan = plan

        case .permissionMode(let mode, let via):
            permissionMode = mode
            if via == "tool" {
                items.append(TranscriptItem(
                    kind: .info("已切换到「\(Self.modeLabel(mode))」模式")))
            }

        case .configured(let provider, let model):
            if let provider { selectedProvider = provider }
            if let model { selectedModel = model }

        case .done:
            finishTurn(error: nil)

        case .error(let message):
            finishTurn(error: message)

        case .resumed(_, _, let live):
            if live {
                // A turn is running server-side; replayed + live-tail
                // events follow on this socket.
                isStreaming = true
            } else if isStreaming {
                // The run finished while we were disconnected — its
                // result is only in the store now.
                isStreaming = false
                streamingIndex = nil
                Task { await reloadHistory() }
            }

        case .tailReplayStart(let firstSeq):
            // Gap check: if the server's oldest retained frame is
            // newer than cursor+1, events we never saw were evicted.
            // Only meaningful when we *have* a cursor — on a cold
            // open the REST history was loaded seconds ago.
            if let first = firstSeq, let last = lastSeq, first > last + 1 {
                Task { await reloadHistory() }
            }

        case .resumeError(let reason):
            items.append(TranscriptItem(
                kind: .info("事件补放失败(\(reason)),已从服务器重新加载")))
            lastSeq = nil
            Task { await reloadHistory() }

        case .interrupted:
            finishTurn(error: nil)
            items.append(TranscriptItem(kind: .info("已中断")))

        case .started, .reset, .tailReplayDone, .ignored:
            break
        }
    }

    private func handleSubagent(_ frame: SubagentFrame) {
        if case .started(let task, let model) = frame.event {
            var card = SubagentCard(name: frame.subagentName)
            card.task = task
            card.model = model
            subagentIndex[frame.subagentId] = items.count
            items.append(TranscriptItem(kind: .subagent(card)))
            return
        }
        guard let idx = subagentIndex[frame.subagentId],
              case .subagent(var card) = items[idx].kind else { return }
        switch frame.event {
        case .started:
            return
        case .delta(let text):
            card.text = String((card.text + text).suffix(4000))
        case .toolStart(let name):
            card.toolCount += 1
            card.activity = "工具:\(name)"
        case .toolEnd:
            card.activity = nil
        case .status(let message):
            card.activity = message
        case .done(let finalMessage):
            card.status = .done
            card.activity = nil
            card.finalMessage = finalMessage
        case .error(let message):
            card.status = .failed
            card.activity = nil
            card.finalMessage = message
        case .ignored:
            return
        }
        items[idx].kind = .subagent(card)
    }

    private func appendDelta(_ content: String) {
        guard !content.isEmpty else { return }
        if let idx = streamingIndex, case .assistant(let text) = items[idx].kind {
            items[idx].kind = .assistant(text + content)
        } else {
            streamingIndex = items.count
            items.append(TranscriptItem(kind: .assistant(content)))
        }
    }

    private func finishTurn(error: String?) {
        isStreaming = false
        streamingIndex = nil
        pendingApproval = nil
        if let error {
            items.append(TranscriptItem(kind: .error(error)))
        }
    }

    /// Permission modes selectable from the chat (kebab-case wire
    /// value + Chinese label). `bypass` is intentionally omitted —
    /// it runs every gated tool without prompting.
    static let selectableModes: [(value: String, label: String)] = [
        ("ask", "逐项审批"),
        ("accept-edits", "允许编辑"),
        ("plan", "计划模式"),
        ("auto", "全自动"),
    ]

    static func modeLabel(_ mode: String) -> String {
        selectableModes.first { $0.value == mode }?.label ?? mode
    }

    /// Maps persisted history into transcript items (tool calls pair
    /// the assistant's `tool_calls` with the following `tool` results).
    static func transcript(from messages: [ChatMessage]) -> [TranscriptItem] {
        var out: [TranscriptItem] = []
        var pendingCalls: [String: ToolCall] = [:]
        var callItemIndex: [String: Int] = [:]

        for message in messages {
            switch message {
            case .system:
                continue
            case .user(let content):
                out.append(TranscriptItem(kind: .user(content)))
            case .assistant(let content, let toolCalls):
                if let content, !content.isEmpty {
                    out.append(TranscriptItem(kind: .assistant(content)))
                }
                for call in toolCalls {
                    pendingCalls[call.id] = call
                    callItemIndex[call.id] = out.count
                    out.append(TranscriptItem(
                        kind: .tool(name: call.name,
                                    arguments: call.arguments.prettyPrinted,
                                    output: nil, denied: false)))
                }
            case .tool(let toolCallId, let content):
                if let idx = callItemIndex[toolCallId],
                   case .tool(let name, let args, _, _) = out[idx].kind {
                    let denied = content.hasPrefix("tool denied:")
                    out[idx].kind = .tool(
                        name: name, arguments: args, output: content, denied: denied)
                }
            }
        }
        return out
    }
}
