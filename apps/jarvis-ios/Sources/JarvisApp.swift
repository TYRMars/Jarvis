import SwiftUI

@main
struct JarvisApp: App {
    var body: some Scene {
        WindowGroup {
            ConversationListView()
                // Handle `jarvis://pair?origin=…&token=…` deep links (a scanned QR
                // opened as a URL, or a tapped pairing link) → write the same
                // UserDefaults keys ServerConfig reads.
                .onOpenURL { url in
                    if let p = PairingPayload.parse(url.absoluteString) {
                        UserDefaults.standard.set(p.origin, forKey: ServerConfig.defaultsKey)
                        if let token = p.token {
                            UserDefaults.standard.set(token, forKey: ServerConfig.tokenDefaultsKey)
                        }
                    }
                }
        }
    }
}
