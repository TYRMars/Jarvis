import SwiftUI

/// Server connection settings. Writes the same UserDefaults keys `ServerConfig`
/// reads (`serverURL` + `serverToken`), so changes apply to the next
/// request/socket. Adds: a bearer-token field (for DDNS-exposed servers), LAN
/// discovery (Bonjour), QR pairing, and a link into the DDNS config screen.
struct SettingsView: View {
    @AppStorage(ServerConfig.defaultsKey) private var serverURL = ServerConfig.fallback
    @AppStorage(ServerConfig.tokenDefaultsKey) private var serverToken = ""
    @Environment(\.dismiss) private var dismiss

    @StateObject private var discovery = DiscoveryService()
    @State private var testing = false
    @State private var testResult: Result<String, Error>?
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if discovery.servers.isEmpty {
                        Label(discovery.browsing ? "正在搜索本机网络…" : "未发现服务器", systemImage: "antenna.radiowaves.left.and.right")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(discovery.servers) { server in
                            Label(server.name, systemImage: "desktopcomputer")
                        }
                    }
                } header: {
                    Text("本机网络发现")
                } footer: {
                    Text("电脑端设置 JARVIS_MDNS=1 后会广播 _jarvis._tcp。仍需通过扫码或手动填入地址+令牌完成连接。")
                }

                Section {
                    TextField("http://192.168.1.10:7001", text: $serverURL)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("访问令牌(对外暴露时必填)", text: $serverToken)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button {
                        showScanner = true
                    } label: {
                        Label("扫码配对", systemImage: "qrcode.viewfinder")
                    }
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("运行 `jarvis serve` 的机器地址,默认端口 7001。真机调试填 Mac 局域网 IP。对外(DDNS)访问时填电脑「远程访问」页生成的令牌,或直接扫码。")
                }

                Section {
                    Button {
                        testConnection()
                    } label: {
                        if testing {
                            HStack { ProgressView(); Text("测试中…") }
                        } else {
                            Text("测试连接")
                        }
                    }
                    .disabled(testing)

                    switch testResult {
                    case .success(let name):
                        Label("已连接:\(name)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    case .failure(let error):
                        Label(error.localizedDescription, systemImage: "xmark.circle.fill")
                            .foregroundStyle(.red).font(.footnote)
                    case nil:
                        EmptyView()
                    }
                }

                Section {
                    NavigationLink {
                        DDNSView()
                    } label: {
                        Label("远程访问 / DDNS", systemImage: "network")
                    }
                } footer: {
                    Text("配置本机对外的动态 DNS,让手机在外网也能连回家里。")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear { discovery.start() }
            .onDisappear { discovery.stop() }
            .sheet(isPresented: $showScanner) {
                QRScannerView { payload in
                    if let payload { apply(payload) }
                }
            }
        }
    }

    private func apply(_ payload: PairingPayload) {
        serverURL = payload.origin
        if let token = payload.token { serverToken = token }
    }

    private func testConnection() {
        testing = true
        testResult = nil
        Task {
            do {
                try await JarvisAPI().health()
                // /health is open; remote/info confirms the token works too.
                let info = try? await JarvisAPI().remoteInfo()
                testResult = .success(info?.deviceName ?? "OK")
            } catch {
                testResult = .failure(error)
            }
            testing = false
        }
    }
}

#Preview {
    SettingsView()
}
