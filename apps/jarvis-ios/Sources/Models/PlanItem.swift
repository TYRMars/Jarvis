import Foundation

/// Mirrors `harness_core::plan::PlanItem` — one step in the agent's
/// working plan. Every `plan_update` event carries the **full latest
/// snapshot** (replace, not patch), so the client just swaps its copy.
struct PlanItem: Identifiable, Hashable {
    /// Serialised snake_case on the wire; unknown statuses degrade to
    /// `.pending` (the forward-compat rule the server documents).
    enum Status: String {
        case pending
        case inProgress = "in_progress"
        case completed
        case cancelled
    }

    let id: String
    let title: String
    let status: Status
    let note: String?

    init?(json: JSONValue) {
        guard let obj = json.objectValue,
              let id = obj["id"]?.stringValue,
              let title = obj["title"]?.stringValue
        else { return nil }
        self.id = id
        self.title = title
        self.status = obj["status"]?.stringValue
            .flatMap(Status.init(rawValue:)) ?? .pending
        self.note = obj["note"]?.stringValue
    }
}
