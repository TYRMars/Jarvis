import Foundation

/// DDNS / remote-access wire models — mirror @jarvis/shared-types
/// (`DdnsConfigInput` / `DdnsConfigView` / `DdnsStatus` / `RemoteInfo`).
/// camelCase Swift props with snake_case CodingKeys, matching the rest of
/// Sources/Models. Foundation-only, so covered by the contract smoke test.

enum DdnsProviderKind: String, Codable, CaseIterable, Identifiable, Hashable {
    case cloudflare, duckdns, dyndns2, aliyun, dnspod
    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .cloudflare: return "Cloudflare"
        case .duckdns: return "DuckDNS"
        case .dyndns2: return "通用 dyndns2"
        case .aliyun: return "阿里云 DNS"
        case .dnspod: return "DNSPod"
        }
    }

    /// Credential fields shown in the config form (in order).
    var credentialKeys: [String] {
        switch self {
        case .cloudflare: return ["api_token", "zone_id"]
        case .duckdns: return ["token"]
        case .dyndns2: return ["username", "password", "server"]
        case .aliyun: return ["access_key_id", "access_key_secret", "domain"]
        case .dnspod: return ["id", "token", "domain"]
        }
    }

    /// Which credential fields are mandatory (the rest are optional).
    var requiredCredentialKeys: Set<String> {
        switch self {
        case .cloudflare: return ["api_token"]
        case .duckdns: return ["token"]
        case .dyndns2: return ["username", "password"]
        case .aliyun: return ["access_key_id", "access_key_secret"]
        case .dnspod: return ["id", "token"]
        }
    }
}

/// `PUT /v1/ddns/config` body — full config INCLUDING secrets.
struct DdnsConfigInput: Codable {
    var provider: DdnsProviderKind
    var hostname: String
    var port: Int
    var recordType: String?
    var intervalSeconds: Int?
    var upnpEnabled: Bool?
    var credentials: [String: String]

    private enum CodingKeys: String, CodingKey {
        case provider, hostname, port, credentials
        case recordType = "record_type"
        case intervalSeconds = "interval_seconds"
        case upnpEnabled = "upnp_enabled"
    }
}

/// `GET /v1/ddns/config` — scrubbed (never carries secret values).
struct DdnsConfigView: Codable {
    var provider: DdnsProviderKind?
    var hostname: String?
    var port: Int?
    var recordType: String?
    var intervalSeconds: Int?
    var upnpEnabled: Bool?
    var credentialKeys: [String]?
    var configured: Bool?

    private enum CodingKeys: String, CodingKey {
        case provider, hostname, port, configured
        case recordType = "record_type"
        case intervalSeconds = "interval_seconds"
        case upnpEnabled = "upnp_enabled"
        case credentialKeys = "credential_keys"
    }
}

struct DdnsUpnpStatus: Codable {
    var mapped: Bool
    var externalPort: Int?
    var internalPort: Int?
    var gatewayExternalIp: String?
    var message: String?

    private enum CodingKeys: String, CodingKey {
        case mapped, message
        case externalPort = "external_port"
        case internalPort = "internal_port"
        case gatewayExternalIp = "gateway_external_ip"
    }
}

struct DdnsLastResult: Codable {
    var ok: Bool
    var message: String
}

/// `GET /v1/ddns/status` — live runtime snapshot.
struct DdnsStatus: Codable {
    var enabled: Bool
    var configured: Bool
    var provider: DdnsProviderKind?
    var hostname: String?
    var publicIp: String?
    var lastUpdate: String?
    var lastResult: DdnsLastResult?
    var upnp: DdnsUpnpStatus?
    var reachable: Bool?
    var lanAddrs: [String]

    private enum CodingKeys: String, CodingKey {
        case enabled, configured, provider, hostname, upnp, reachable
        case publicIp = "public_ip"
        case lastUpdate = "last_update"
        case lastResult = "last_result"
        case lanAddrs = "lan_addrs"
    }
}

struct RemoteExternal: Codable {
    var hostname: String?
    var publicIp: String?
    var reachable: Bool?

    private enum CodingKeys: String, CodingKey {
        case hostname, reachable
        case publicIp = "public_ip"
    }
}

/// `GET /v1/remote/info` — the connect-screen summary.
struct RemoteInfo: Codable {
    var deviceName: String
    var lanAddrs: [String]
    var port: Int
    var external: RemoteExternal
    var requiresAuth: Bool
    var version: String?

    private enum CodingKeys: String, CodingKey {
        case external, port, version
        case deviceName = "device_name"
        case lanAddrs = "lan_addrs"
        case requiresAuth = "requires_auth"
    }
}
