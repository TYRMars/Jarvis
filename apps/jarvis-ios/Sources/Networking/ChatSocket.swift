import Foundation

/// Frames the client sends on `/v1/chat/ws`. Mirrors the
/// `WsClientMessage` enum in `harness-server/src/routes.rs`
/// (`#[serde(tag = "type", rename_all = "snake_case")]`).
enum ClientFrame {
    /// Atomic "prepare persisted conversation + run first user turn".
    case startTurn(mode: String, id: String, content: String)
    /// Append a user turn to the socket's current conversation.
    case user(content: String)
    /// Load a persisted conversation and enter persisted mode.
    case resume(id: String, afterSeq: UInt64?)
    case approve(toolCallId: String)
    case deny(toolCallId: String, reason: String?)
    case interrupt
    /// Set the socket's sticky provider/model. Subsequent turns route
    /// here unless they carry their own. Rejected mid-turn.
    case configure(model: String?, provider: String?)
    /// Switch the per-socket permission mode at runtime.
    case setMode(mode: String)
    /// Accept a proposed plan and switch to `postMode`; the server
    /// pushes a synthetic "proceed" message and runs the next turn.
    case acceptPlan(postMode: String)
    /// Send refinement feedback for a proposed plan (a labelled user
    /// turn).
    case refinePlan(feedback: String)

    var jsonObject: [String: JSONValue] {
        switch self {
        case .startTurn(let mode, let id, let content):
            return [
                "type": .string("start_turn"),
                "mode": .string(mode),
                "id": .string(id),
                "content": .string(content),
            ]
        case .user(let content):
            return ["type": .string("user"), "content": .string(content)]
        case .resume(let id, let afterSeq):
            var obj: [String: JSONValue] = [
                "type": .string("resume"),
                "id": .string(id),
            ]
            if let afterSeq {
                obj["after_seq"] = .number(Double(afterSeq))
            }
            return obj
        case .approve(let toolCallId):
            return ["type": .string("approve"), "tool_call_id": .string(toolCallId)]
        case .deny(let toolCallId, let reason):
            var obj: [String: JSONValue] = [
                "type": .string("deny"),
                "tool_call_id": .string(toolCallId),
            ]
            if let reason, !reason.isEmpty {
                obj["reason"] = .string(reason)
            }
            return obj
        case .interrupt:
            return ["type": .string("interrupt")]
        case .configure(let model, let provider):
            var obj: [String: JSONValue] = ["type": .string("configure")]
            if let model { obj["model"] = .string(model) }
            if let provider { obj["provider"] = .string(provider) }
            return obj
        case .setMode(let mode):
            return ["type": .string("set_mode"), "mode": .string(mode)]
        case .acceptPlan(let postMode):
            return ["type": .string("accept_plan"), "post_mode": .string(postMode)]
        case .refinePlan(let feedback):
            return ["type": .string("refine_plan"), "feedback": .string(feedback)]
        }
    }

    func encoded() throws -> String {
        let data = try JSONEncoder().encode(JSONValue.object(jsonObject))
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}

/// URLSessionWebSocketTask wrapper for `/v1/chat/ws`. Decoded frames
/// arrive on the `events` AsyncStream; the stream finishes when the
/// socket closes (the view model decides whether to reconnect).
///
/// Each element carries the server's per-conversation `seq` stamp
/// (when present) alongside the event. The view model owns the
/// high-water mark — keeping it on the consumer side means the
/// `resume { after_seq }` cursor and the replay-gap check both see
/// the same serially-processed value, with no race against frames
/// the socket has received but the consumer hasn't handled yet.
///
/// `ChatSocket` is `@MainActor`-isolated: its `task`/`continuation` stores are
/// mutated by `ChatViewModel` (already `@MainActor`) *and* by the `receive`
/// completion handler, which fires on URLSession's delegate queue. Pinning all
/// state to the main actor — and hopping the delegate-queue callbacks back onto
/// it — is what keeps those two producers from racing (#497). It rippled to no
/// call sites: every caller lives on the main actor already.
@MainActor
final class ChatSocket {
    typealias Frame = (event: ServerEvent, seq: UInt64?)

    private var task: URLSessionWebSocketTask?
    private var continuation: AsyncStream<Frame>.Continuation?

    var isConnected: Bool { task != nil }

    /// Opens the socket and returns the inbound event stream.
    func connect() throws -> AsyncStream<Frame> {
        disconnect()
        guard let url = ServerConfig.chatSocketURL else {
            throw APIError.badURL
        }
        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task

        let stream = AsyncStream<Frame> { continuation in
            self.continuation = continuation
            continuation.onTermination = { _ in
                // Fires on an arbitrary queue when the consumer drops the
                // stream. `URLSessionTask.cancel` is thread-safe; cancel the
                // captured task directly so we never touch main-actor state
                // off the main actor.
                task.cancel(with: .normalClosure, reason: nil)
            }
        }
        task.resume()
        receiveLoop(on: task)
        return stream
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        continuation?.finish()
        continuation = nil
    }

    func send(_ frame: ClientFrame) async throws {
        guard let task else { throw APIError.badURL }
        let text = try frame.encoded()
        try await task.send(.string(text))
    }

    // MARK: private

    private func receiveLoop(on task: URLSessionWebSocketTask) {
        // `receive`'s completion handler fires on URLSession's delegate queue —
        // off the main actor. Hop back before touching `task`/`continuation` so
        // every access to them stays main-actor isolated. Without the hop the
        // delegate queue and the main actor raced on these stores (#497):
        // unbalanced ARC release → EXC_BAD_ACCESS, or `continuation` nil'd by a
        // concurrent `disconnect()` between the load and `finish()` here, which
        // strands the stream open and leaks the consumer forever.
        //
        // Ordering is preserved: the next `receive` is only re-armed from inside
        // this main-actor hop (via `receiveLoop`), so frames are handled one at
        // a time, never overlapping.
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message,
                       let (event, seq) = ServerEvent.decode(text) {
                        self.continuation?.yield((event, seq))
                    }
                    self.receiveLoop(on: task)
                case .failure:
                    self.continuation?.finish()
                    self.continuation = nil
                    self.task = nil
                }
            }
        }
    }
}
