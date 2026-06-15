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
}
