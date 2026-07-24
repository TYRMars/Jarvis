import SwiftUI

/// Configure + monitor the home machine's dynamic DNS (the "对外 DDNS 配置能力").
/// Reads/writes `/v1/ddns/*` on the connected server. The provider picker drives
/// which credential fields appear; secrets are write-only (the GET is scrubbed).
@MainActor
final class DDNSViewModel: ObservableObject {
    @Published var provider: DdnsProviderKind = .duckdns
    @Published var hostname = ""
    @Published var port = 7001
    @Published var upnpEnabled = true
    @Published var credentials: [String: String] = [:]

    @Published var status: DdnsStatus?
    @Published var busy = false
    @Published var message: String?
    @Published var unavailable = false  // server returned 503 (DDNS not enabled)

    private let api = JarvisAPI()

    func load() async {
        do {
            status = try await api.ddnsStatus()
            let cfg = try await api.ddnsConfig()
            if let p = cfg.provider { provider = p }
            if let h = cfg.hostname { hostname = h }
            if let pt = cfg.port { port = pt }
            if let u = cfg.upnpEnabled { upnpEnabled = u }
            unavailable = false
        } catch APIError.http(let code, _) where code == 503 {
            unavailable = true
            message = "服务器未开启 DDNS。请在电脑上设置 JARVIS_DDNS_ENABLE=1 后重启。"
        } catch {
            message = "加载失败:\(error.localizedDescription)"
        }
    }

    var missingRequired: Bool {
        hostname.trimmingCharacters(in: .whitespaces).isEmpty
            || provider.requiredCredentialKeys.contains { (credentials[$0] ?? "").isEmpty }
    }

    func save() async {
        busy = true; defer { busy = false }
        let creds = credentials.filter { !$0.value.isEmpty }
        let input = DdnsConfigInput(
            provider: provider, hostname: hostname.trimmingCharacters(in: .whitespaces), port: port,
            recordType: "A", intervalSeconds: nil, upnpEnabled: upnpEnabled, credentials: creds)
        do {
            _ = try await api.putDdnsConfig(input)
            status = try await api.ddnsUpdate()
            message = status?.lastResult?.message ?? "已保存并更新。"
        } catch { message = "保存失败:\(error.localizedDescription)" }
    }

    func updateNow() async {
        busy = true; defer { busy = false }
        do { status = try await api.ddnsUpdate(); message = status?.lastResult?.message }
        catch { message = "更新失败:\(error.localizedDescription)" }
    }

    func testUpnp() async {
        busy = true; defer { busy = false }
        do { message = try await api.upnpTest(port: port).message }
        catch { message = "UPnP 测试失败:\(error.localizedDescription)" }
    }
}

struct DDNSView: View {
    @StateObject private var vm = DDNSViewModel()

    var body: some View {
        Form {
            if let s = vm.status { statusSection(s) }

            Section("服务商") {
                Picker("Provider", selection: $vm.provider) {
                    ForEach(DdnsProviderKind.allCases) { Text($0.displayName).tag($0) }
                }
                TextField("域名(home.example.com)", text: $vm.hostname)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Stepper("端口:\(vm.port)", value: $vm.port, in: 1...65535)
                Toggle("尝试 UPnP 自动端口映射", isOn: $vm.upnpEnabled)
            }

            Section("凭据") {
                ForEach(vm.provider.credentialKeys, id: \.self) { key in
                    let required = vm.provider.requiredCredentialKeys.contains(key)
                    SecureField(key + (required ? "(必填)" : "(可选)"),
                                text: Binding(get: { vm.credentials[key] ?? "" },
                                              set: { vm.credentials[key] = $0 }))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            } footer: {
                Text("凭据仅上传到你自己的服务器并安全保存(0600),不会回显。")
            }

            if let m = vm.message {
                Section { Text(m).font(.footnote).foregroundStyle(.secondary) }
            }

            Section {
                Button { Task { await vm.save() } } label: {
                    if vm.busy { ProgressView() } else { Text("保存并更新") }
                }.disabled(vm.missingRequired || vm.busy || vm.unavailable)
                Button("立即更新") { Task { await vm.updateNow() } }.disabled(vm.busy || vm.unavailable)
                Button("测试 UPnP") { Task { await vm.testUpnp() } }.disabled(vm.busy || vm.unavailable)
            }
        }
        .navigationTitle("远程访问 / DDNS")
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load() }
    }

    @ViewBuilder
    private func statusSection(_ s: DdnsStatus) -> some View {
        Section("状态") {
            LabeledContent("已配置", value: s.configured ? "是" : "否")
            if let ip = s.publicIp { LabeledContent("公网 IP", value: ip) }
            if let host = s.hostname { LabeledContent("域名", value: host) }
            if let last = s.lastUpdate { LabeledContent("上次更新", value: last) }
            if let r = s.lastResult {
                LabeledContent("结果", value: (r.ok ? "✓ " : "✗ ") + r.message)
            }
            if let upnp = s.upnp {
                LabeledContent("UPnP", value: upnp.mapped ? "已映射" : (upnp.message ?? "未映射"))
            }
            LabeledContent("可达性", value: s.reachable.map { $0 ? "可达" : "不可达" } ?? "未知")
            if !s.lanAddrs.isEmpty {
                LabeledContent("局域网", value: s.lanAddrs.joined(separator: ", "))
            }
        }
    }
}
