import Foundation

/// Mirrors `harness_core::subagent::SubAgentFrame` — one event from a
/// running subagent, relayed by the agent loop while a
/// `subagent.<name>` tool executes. The wire shape is
/// `{"type":"sub_agent_event","frame":{subagent_id,subagent_name,event:{kind,…}}}`.
struct SubagentFrame {
    enum Event {
        case started(task: String, model: String?)
        /// Chunk of assistant-visible text; renderers concatenate.
        case delta(text: String)
        case toolStart(name: String)
        case toolEnd(name: String)
        /// SDK-style one-liner status update ("Searching files…").
        case status(message: String)
        case done(finalMessage: String)
        case error(message: String)
        /// Unrendered kinds (`usage`, future additions) — kept so a
        /// server upgrade never breaks decoding.
        case ignored(kind: String)
    }

    let subagentId: String
    let subagentName: String
    let event: Event

    init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let id = obj["subagent_id"]?.stringValue,
              let name = obj["subagent_name"]?.stringValue,
              let eventObj = obj["event"]?.objectValue,
              let kind = eventObj["kind"]?.stringValue
        else { return nil }
        self.subagentId = id
        self.subagentName = name

        switch kind {
        case "started":
            self.event = .started(
                task: eventObj["task"]?.stringValue ?? "",
                model: eventObj["model"]?.stringValue)
        case "delta":
            self.event = .delta(text: eventObj["text"]?.stringValue ?? "")
        case "tool_start":
            self.event = .toolStart(name: eventObj["name"]?.stringValue ?? "")
        case "tool_end":
            self.event = .toolEnd(name: eventObj["name"]?.stringValue ?? "")
        case "status":
            self.event = .status(message: eventObj["message"]?.stringValue ?? "")
        case "done":
            self.event = .done(finalMessage: eventObj["final_message"]?.stringValue ?? "")
        case "error":
            self.event = .error(message: eventObj["message"]?.stringValue ?? "")
        default:
            self.event = .ignored(kind: kind)
        }
    }
}
