import SwiftUI

/// Collapsible card for one subagent invocation (`sub_agent_event`
/// frames). Updates in place: header shows name + live status, the
/// expanded body shows the task, the streamed output tail and the
/// final message.
struct SubagentCardView: View {
    let card: SubagentCard

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .foregroundStyle(iconColor)
                    Text("子代理 · \(card.name)")
                        .font(.system(.footnote, design: .monospaced))
                        .fontWeight(.medium)
                    if card.status == .running {
                        ProgressView().controlSize(.mini)
                    }
                    Spacer()
                    if card.toolCount > 0 {
                        Text("\(card.toolCount) 次工具")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if !card.task.isEmpty {
                Text(card.task)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(expanded ? nil : 1)
            }
            if let activity = card.activity, !activity.isEmpty {
                Text(activity)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if expanded {
                if !card.text.isEmpty {
                    ScrollView {
                        Text(card.text)
                            .font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 180)
                    .padding(6)
                    .background(Color(uiColor: .systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                if let final = card.finalMessage, !final.isEmpty {
                    Text(final)
                        .font(.caption)
                        .foregroundStyle(card.status == .failed ? .red : .primary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(10)
        .background(Color(uiColor: .tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(uiColor: .separator), lineWidth: 0.5)
        )
    }

    private var icon: String {
        switch card.status {
        case .running: return "person.crop.circle.badge.clock"
        case .done: return "person.crop.circle.badge.checkmark"
        case .failed: return "person.crop.circle.badge.xmark"
        }
    }

    private var iconColor: Color {
        switch card.status {
        case .running: return .orange
        case .done: return .green
        case .failed: return .red
        }
    }
}
