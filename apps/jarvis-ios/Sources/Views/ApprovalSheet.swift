import SwiftUI

/// Shown when the agent pauses on an `approval_request` — the gated
/// tool (fs.write / shell.exec / …) will not run until the user
/// approves, and a deny reason is surfaced back to the model.
struct ApprovalSheet: View {
    let approval: PendingApproval
    /// `(approved, denyReason)`
    let onDecision: (Bool, String?) -> Void

    @State private var denyReason = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Label {
                    Text("Jarvis 请求执行敏感工具")
                        .font(.headline)
                } icon: {
                    Image(systemName: "exclamationmark.shield.fill")
                        .foregroundStyle(.orange)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text(approval.name)
                        .font(.system(.subheadline, design: .monospaced))
                        .fontWeight(.semibold)
                    ScrollView {
                        Text(approval.arguments.prettyPrinted)
                            .font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 220)
                    .padding(8)
                    .background(Color(uiColor: .secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                TextField("拒绝原因(可选,会反馈给模型)", text: $denyReason)
                    .textFieldStyle(.roundedBorder)

                HStack(spacing: 12) {
                    Button(role: .destructive) {
                        onDecision(false, denyReason.isEmpty ? nil : denyReason)
                    } label: {
                        Text("拒绝")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        onDecision(true, nil)
                    } label: {
                        Text("允许")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
                Spacer()
            }
            .padding()
            .navigationTitle("工具审批")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
