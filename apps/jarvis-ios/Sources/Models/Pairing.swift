import Foundation

/// A pairing payload encoded by the home server's QR / link
/// (`jarvis://pair?origin=…&token=…&name=…`). Also accepts a bare
/// `http(s)://…` origin (manual entry / a plain QR of the URL).
struct PairingPayload: Equatable {
    var origin: String
    var token: String?
    var name: String

    static func parse(_ raw: String) -> PairingPayload? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed) else { return nil }
        switch comps.scheme {
        case "jarvis":
            let items = comps.queryItems ?? []
            func q(_ k: String) -> String? { items.first { $0.name == k }?.value }
            guard let origin = q("origin"), !origin.isEmpty else { return nil }
            return PairingPayload(origin: origin, token: q("token"), name: q("name") ?? origin)
        case "http", "https":
            return PairingPayload(origin: trimmed, token: nil, name: comps.host ?? trimmed)
        default:
            return nil
        }
    }
}
