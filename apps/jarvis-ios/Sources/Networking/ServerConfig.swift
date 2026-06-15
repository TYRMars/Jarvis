import Foundation

/// Where the Jarvis server lives. Persisted in UserDefaults under
/// `serverURL` (the Settings screen edits the same key via @AppStorage).
enum ServerConfig {
    static let defaultsKey = "serverURL"
    static let fallback = "http://localhost:7001"

    static var baseURLString: String {
        let raw = UserDefaults.standard.string(forKey: defaultsKey) ?? fallback
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return fallback }
        // Drop one trailing slash so path concatenation stays clean.
        return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
    }

    static var baseURL: URL? {
        URL(string: baseURLString)
    }

    /// `http(s)://host:port` → `ws(s)://host:port/v1/chat/ws`
    static var chatSocketURL: URL? {
        guard var components = URLComponents(string: baseURLString) else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/chat/ws"
        return components.url
    }
}
