import SwiftUI

/// Collapsible checklist for the agent's working plan
/// (`plan_update` events). Pinned between the transcript and the
/// input bar; every event replaces the whole snapshot, so the view
/// is a pure function of the latest `items`.
struct PlanCardView: View {
    let items: [PlanItem]

    @State private var expanded = false

    private var doneCount: Int {
        items.filter { $0.status == .completed }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "checklist")
                        .foregroundStyle(.tint)
                    Text("计划 \(doneCount)/\(items.count)")
                        .font(.footnote)
                        .fontWeight(.medium)
                    if let current = items.first(where: { $0.status == .inProgress }),
                       !expanded {
                        Text(current.title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: expanded ? "chevron.down" : "chevron.up")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(items) { item in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Image(systemName: icon(for: item.status))
                                    .font(.caption)
                                    .foregroundStyle(color(for: item.status))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title)
                                        .font(.caption)
                                        .strikethrough(item.status == .cancelled)
                                        .foregroundStyle(
                                            item.status == .cancelled ? .secondary : .primary)
                                    if let note = item.note, !note.isEmpty {
                                        Text(note)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
                .frame(maxHeight: 180)
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

    private func icon(for status: PlanItem.Status) -> String {
        switch status {
        case .pending: return "circle"
        case .inProgress: return "arrow.triangle.2.circlepath.circle"
        case .completed: return "checkmark.circle.fill"
        case .cancelled: return "xmark.circle"
        }
    }

    private func color(for status: PlanItem.Status) -> Color {
        switch status {
        case .pending: return .secondary
        case .inProgress: return .orange
        case .completed: return .green
        case .cancelled: return .secondary
        }
    }
}
