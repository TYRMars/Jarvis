import SwiftUI

/// Server connection settings. Writes the same UserDefaults key
/// `ServerConfig` reads, so changes apply to the next request/socket.
struct SettingsView: View {
    @AppStorage(ServerConfig.defaultsKey) private var serverURL = ServerConfig.fallback
    @Environment(\.dismiss) private var dismiss

    @State private var testing = false
    @State private var testResult: Result<Void, Error>?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.10:7001", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("运行 `jarvis serve` 的机器地址,默认端口 7001。真机调试时填 Mac 的局域网 IP,不要用 localhost。")
                }

                Section {
                    Button {
                        testConnection()
                    } label: {
                        if testing {
                            HStack {
                                ProgressView()
                                Text("测试中…")
                            }
                        } else {
                            Text("测试连接")
                        }
                    }
                    .disabled(testing)

                    switch testResult {
                    case .success:
                        Label("连接成功", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    case .failure(let error):
                        Label(error.localizedDescription, systemImage: "xmark.circle.fill")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    case nil:
                        EmptyView()
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    private func testConnection() {
        testing = true
        testResult = nil
        Task {
            do {
                try await JarvisAPI().health()
                testResult = .success(())
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
