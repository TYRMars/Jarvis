import SwiftUI

/// Plan-Mode review card (`plan_proposed`). Shows the agent's
/// proposed plan and lets the user accept it (choosing the
/// permission mode execution runs under) or send refinement
/// feedback. Pinned above the input bar until resolved.
struct PlanProposalView: View {
    let plan: String
    /// Called with the chosen post-accept permission mode (kebab-case).
    let onAccept: (String) -> Void
    let onRefine: () -> Void

    @State private var expanded = true
    @State private var showAcceptOptions = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "list.bullet.clipboard")
                        .foregroundStyle(.tint)
                    Text("Jarvis 提出了执行计划")
                        .font(.footnote)
                        .fontWeight(.semibold)
                    Spacer()
                    Image(systemName: expanded ? "chevron.down" : "chevron.up")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                ScrollView {
                    Text(.init(plan))  // Markdown-aware
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 220)
            }

            HStack(spacing: 12) {
                Button {
                    onRefine()
                } label: {
                    Text("优化计划").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button {
                    showAcceptOptions = true
                } label: {
                    Text("接受并执行").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .confirmationDialog(
            "以哪种权限执行?", isPresented: $showAcceptOptions, titleVisibility: .visible
        ) {
            Button("允许编辑(自动批准写入)") { onAccept("accept-edits") }
            Button("逐项审批(每个敏感工具都确认)") { onAccept("ask") }
            Button("全自动") { onAccept("auto") }
            Button("取消", role: .cancel) {}
        }
    }
}
