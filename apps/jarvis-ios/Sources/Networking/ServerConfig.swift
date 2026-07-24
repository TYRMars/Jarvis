import Foundation

/// Where the Jarvis server lives.
///
/// Base-URL switch (P7.10, the iOS analog of the web's `VITE_BACKEND_URL` +
/// runtime `localStorage` override). Resolution precedence, highest first:
///
///   1. UserDefaults `serverURL` — the runtime override the Settings screen
///      edits (via @AppStorage). Survives launches; wins over everything.
///   2. `JARVIS_SERVER_URL` process env — a launch / CI / dev default (set it in
///      the Xcode scheme's Run environment, or when driving the simulator
///      headlessly), without baking it into the build.
///   3. `JarvisServerURL` in Info.plist — the build-time default, so a build can
///      ship pointed at a specific backend (Rust or Node) out of the box.
///   4. `http://localhost:7001` — the loopback both backends listen on.
///
/// Both the Rust `harness-server` and the Node `@jarvis/jarvis-app serve` speak
/// the same `/v1` surface on :7001, so the default targets either; the override
/// chain lets the same build flip between them.
enum ServerConfig {
    static let defaultsKey = "serverURL"
    static let envKey = "JARVIS_SERVER_URL"
    static let plistKey = "JarvisServerURL"
    static let fallback = "http://localhost:7001"

    // Bearer token for servers that require auth (non-loopback / DDNS-exposed).
    // Same precedence chain as the URL; empty → nil (no Authorization header).
    static let tokenDefaultsKey = "serverToken"
    static let tokenEnvKey = "JARVIS_ACCESS_TOKEN"
    static let tokenPlistKey = "JarvisAccessToken"

    /// Pure resolver (unit-testable): first non-empty candidate wins, with one
    /// trailing slash trimmed so path concatenation stays clean; else `fallback`.
    static func resolve(userDefault: String?, env: String?, plist: String?) -> String {
        for candidate in [userDefault, env, plist] {
            guard let raw = candidate else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        }
        return fallback
    }

    /// Pure token resolver: first non-empty candidate wins; else nil.
    static func resolveToken(userDefault: String?, env: String?, plist: String?) -> String? {
        for candidate in [userDefault, env, plist] {
            guard let raw = candidate else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    static var token: String? {
        resolveToken(
            userDefault: UserDefaults.standard.string(forKey: tokenDefaultsKey),
            env: ProcessInfo.processInfo.environment[tokenEnvKey],
            plist: Bundle.main.object(forInfoDictionaryKey: tokenPlistKey) as? String)
    }

    static var baseURLString: String {
        resolve(
            userDefault: UserDefaults.standard.string(forKey: defaultsKey),
            env: ProcessInfo.processInfo.environment[envKey],
            plist: Bundle.main.object(forInfoDictionaryKey: plistKey) as? String)
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
