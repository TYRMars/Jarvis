import Foundation
import Combine
import Network

/// A Jarvis server discovered on the LAN via Bonjour (`_jarvis._tcp`, advertised
/// by the server when `JARVIS_MDNS=1`).
struct DiscoveredServer: Identifiable, Equatable {
    var id: String { name }
    let name: String
}

/// Browses for `_jarvis._tcp` and publishes results. Uses the Network framework
/// (NWBrowser); pull in `Combine`/`Network` keeps it out of the Foundation-only
/// contract smoke (like ChatSocket). Tap a result to pre-fill the connect form,
/// then pair via QR / token (Bonjour gives the name; the origin+token come from
/// pairing or manual entry).
@MainActor
final class DiscoveryService: ObservableObject {
    @Published private(set) var servers: [DiscoveredServer] = []
    @Published private(set) var browsing = false
    private var browser: NWBrowser?

    func start() {
        stop()
        let params = NWParameters()
        params.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: "_jarvis._tcp", domain: nil), using: params)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found: [DiscoveredServer] = results.compactMap { result in
                if case let .service(name, _, _, _) = result.endpoint {
                    return DiscoveredServer(name: name)
                }
                return nil
            }
            Task { @MainActor in self?.servers = found }
        }
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready, .setup: self?.browsing = true
                case .failed, .cancelled: self?.browsing = false
                default: break
                }
            }
        }
        browser.start(queue: .main)
        self.browser = browser
        browsing = true
    }

    func stop() {
        browser?.cancel()
        browser = nil
        servers = []
        browsing = false
    }
}
