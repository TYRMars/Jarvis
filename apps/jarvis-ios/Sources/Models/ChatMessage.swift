import Foundation

/// Mirrors `harness_core::Message` — externally tagged by `role`,
/// shaped like the OpenAI chat-completions wire format.
enum ChatMessage: Codable, Hashable {
    case system(content: String)
    case user(content: String)
    case assistant(content: String?, toolCalls: [ToolCall])
    case tool(toolCallId: String, content: String)

    private enum CodingKeys: String, CodingKey {
        case role, content
        case toolCalls = "tool_calls"
        case toolCallId = "tool_call_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let role = try c.decode(String.self, forKey: .role)
        switch role {
        case "system":
            self = .system(content: try c.decodeIfPresent(String.self, forKey: .content) ?? "")
        case "user":
            self = .user(content: try c.decodeIfPresent(String.self, forKey: .content) ?? "")
        case "assistant":
            self = .assistant(
                content: try c.decodeIfPresent(String.self, forKey: .content),
                toolCalls: try c.decodeIfPresent([ToolCall].self, forKey: .toolCalls) ?? [])
        case "tool":
            self = .tool(
                toolCallId: try c.decodeIfPresent(String.self, forKey: .toolCallId) ?? "",
                content: try c.decodeIfPresent(String.self, forKey: .content) ?? "")
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .role, in: c, debugDescription: "unknown role `\(role)`")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .system(let content):
            try c.encode("system", forKey: .role)
            try c.encode(content, forKey: .content)
        case .user(let content):
            try c.encode("user", forKey: .role)
            try c.encode(content, forKey: .content)
        case .assistant(let content, let toolCalls):
            try c.encode("assistant", forKey: .role)
            try c.encodeIfPresent(content, forKey: .content)
            if !toolCalls.isEmpty {
                try c.encode(toolCalls, forKey: .toolCalls)
            }
        case .tool(let toolCallId, let content):
            try c.encode("tool", forKey: .role)
            try c.encode(toolCallId, forKey: .toolCallId)
            try c.encode(content, forKey: .content)
        }
    }
}

/// Mirrors `harness_core::ToolCall` — `arguments` is already-parsed JSON.
struct ToolCall: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let arguments: JSONValue
}
