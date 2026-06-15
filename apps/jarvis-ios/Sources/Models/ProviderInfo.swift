import Foundation

/// One entry from `GET /v1/providers` — mirrors
/// `harness_server::ProviderInfo`. `kind` / `capabilities` are
/// optional (absent on legacy entries); the client only needs the
/// name + model list to drive the picker.
struct ProviderInfo: Codable, Identifiable, Hashable {
    let name: String
    let defaultModel: String
    let models: [String]
    let isDefault: Bool
    let kind: String?

    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, models, kind
        case defaultModel = "default_model"
        case isDefault = "is_default"
    }
}

/// Body of `GET /v1/providers`.
struct ProvidersResponse: Codable {
    let `default`: String?
    let providers: [ProviderInfo]
}
