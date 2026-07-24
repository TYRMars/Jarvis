import Foundation

/// A human-in-the-loop question surfaced by an `ask.*` tool — the
/// `hitl_request` frame's `request` object. Mirrors `@jarvis/core`'s
/// `HitlRequest` (`packages/core/src/hitl.ts`); unknown kinds render
/// as free-text input so new server kinds degrade gracefully.
struct HitlRequest: Identifiable, Equatable {
    struct Option: Identifiable, Equatable {
        let value: String
        let label: String
        var id: String { value }
    }

    let id: String
    /// `confirm` / `input` / `choice` / `review` (open set).
    let kind: String
    let title: String
    let body: String?
    let options: [Option]
    let defaultValue: String?

    static func parse(_ value: JSONValue?) -> HitlRequest? {
        guard let obj = value?.objectValue,
              let id = obj["id"]?.stringValue, !id.isEmpty
        else { return nil }
        let options = (obj["options"]?.arrayValue ?? []).compactMap { entry -> Option? in
            guard let o = entry.objectValue, let v = o["value"]?.stringValue else { return nil }
            return Option(value: v, label: o["label"]?.stringValue ?? v)
        }
        return HitlRequest(
            id: id,
            kind: obj["kind"]?.stringValue ?? "input",
            title: obj["title"]?.stringValue ?? "",
            body: obj["body"]?.stringValue,
            options: options,
            defaultValue: obj["default_value"]?.stringValue)
    }
}
