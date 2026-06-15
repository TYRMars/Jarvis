import Foundation

/// One row of `GET /v1/conversations`. Timestamps stay as the
/// RFC-3339 strings the server sends; parsing happens lazily for display.
struct ConversationSummary: Codable, Identifiable, Hashable {
    let id: String
    let createdAt: String?
    let updatedAt: String?
    let messageCount: Int?
    let title: String?
    let projectId: String?
    let source: String?
    let lifecycle: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, source, lifecycle
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case messageCount = "message_count"
        case projectId = "project_id"
    }

    var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        return String(id.prefix(8))
    }

    var updatedDate: Date? {
        guard let s = updatedAt else { return nil }
        return Self.parseRfc3339(s)
    }

    static func parseRfc3339(_ s: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }
}

/// Body of `GET /v1/conversations/:id`.
struct ConversationDetail: Codable {
    let id: String
    let messages: [ChatMessage]
    let projectId: String?

    private enum CodingKeys: String, CodingKey {
        case id, messages
        case projectId = "project_id"
    }
}
