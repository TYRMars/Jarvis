import Foundation

enum APIError: LocalizedError {
    case badURL
    case http(status: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "服务器地址无效,请在设置中检查。"
        case .http(let status, let body):
            return "HTTP \(status): \(body.prefix(200))"
        }
    }
}

/// Thin REST client over the `/v1` surface of `harness-server`.
struct JarvisAPI {
    var session: URLSession = .shared

    private func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(string: ServerConfig.baseURLString) else {
            throw APIError.badURL
        }
        components.path = path
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.badURL }
        return url
    }

    private func request(
        _ method: String, _ url: URL, body: Data? = nil
    ) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 15
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        // Bearer token for servers that require auth (DDNS-exposed). Loopback
        // servers leave ServerConfig.token nil and stay unauthenticated.
        if let token = ServerConfig.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.http(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    // MARK: endpoints

    /// `GET /health`
    func health() async throws {
        _ = try await request("GET", url("/health"))
    }

    /// `GET /v1/conversations?limit=N`
    func listConversations(limit: Int = 50) async throws -> [ConversationSummary] {
        let data = try await request(
            "GET",
            url("/v1/conversations", query: [URLQueryItem(name: "limit", value: "\(limit)")]))
        return try JSONDecoder().decode([ConversationSummary].self, from: data)
    }

    /// `GET /v1/conversations/:id` — full message history.
    func getConversation(id: String) async throws -> ConversationDetail {
        let data = try await request("GET", url("/v1/conversations/\(id)"))
        return try JSONDecoder().decode(ConversationDetail.self, from: data)
    }

    /// `DELETE /v1/conversations/:id`
    func deleteConversation(id: String) async throws {
        _ = try await request("DELETE", url("/v1/conversations/\(id)"))
    }

    /// `GET /v1/providers` — provider/model catalog for the picker.
    func listProviders() async throws -> ProvidersResponse {
        let data = try await request("GET", url("/v1/providers"))
        return try JSONDecoder().decode(ProvidersResponse.self, from: data)
    }

    // MARK: remote access + DDNS

    /// `GET /v1/remote/info` — connect-screen summary (LAN addrs, external, auth).
    func remoteInfo() async throws -> RemoteInfo {
        let data = try await request("GET", url("/v1/remote/info"))
        return try JSONDecoder().decode(RemoteInfo.self, from: data)
    }

    /// `GET /v1/ddns/status` — live DDNS runtime snapshot (503 when DDNS off).
    func ddnsStatus() async throws -> DdnsStatus {
        let data = try await request("GET", url("/v1/ddns/status"))
        return try JSONDecoder().decode(DdnsStatus.self, from: data)
    }

    /// `GET /v1/ddns/config` — scrubbed config view.
    func ddnsConfig() async throws -> DdnsConfigView {
        let data = try await request("GET", url("/v1/ddns/config"))
        return try JSONDecoder().decode(DdnsConfigView.self, from: data)
    }

    /// `PUT /v1/ddns/config` — set provider + hostname + credentials.
    @discardableResult
    func putDdnsConfig(_ input: DdnsConfigInput) async throws -> DdnsConfigView {
        let body = try JSONEncoder().encode(input)
        let data = try await request("PUT", url("/v1/ddns/config"), body: body)
        return try JSONDecoder().decode(DdnsConfigView.self, from: data)
    }

    /// `POST /v1/ddns/update` — force one update cycle now.
    @discardableResult
    func ddnsUpdate() async throws -> DdnsStatus {
        let data = try await request("POST", url("/v1/ddns/update"), body: Data("{}".utf8))
        return try JSONDecoder().decode(DdnsStatus.self, from: data)
    }

    /// `POST /v1/ddns/upnp/test` — best-effort UPnP port-map probe.
    func upnpTest(port: Int?) async throws -> DdnsUpnpStatus {
        let body = try JSONSerialization.data(withJSONObject: port.map { ["port": $0] } ?? [:])
        let data = try await request("POST", url("/v1/ddns/upnp/test"), body: body)
        return try JSONDecoder().decode(DdnsUpnpStatus.self, from: data)
    }
}
