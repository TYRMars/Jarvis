import SwiftUI

/// Inline card for an `ask.*` HITL question — rendered above the input
/// bar (like the plan-proposal card) while the turn is parked on the
/// operator's answer.
///
/// `confirm` renders 确认/拒绝; `choice` renders one button per option;
/// everything else (`input`, `review`, unknown kinds) renders a
/// free-text field. Cancel is always available — it sends
/// `status:"cancelled"` so the agent can move on.
struct HitlCardView: View {
    let request: HitlRequest
    /// (payload, status) — nil payload with "cancelled" on dismissal.
    let onResolve: (String?, String) -> Void

    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble")
                    .foregroundStyle(.blue)
                Text(request.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Spacer()
                Button {
                    onResolve(nil, "cancelled")
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
            if let body = request.body, !body.isEmpty {
                Text(.init(body))  // Markdown-aware
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            switch request.kind {
            case "confirm":
                HStack(spacing: 10) {
                    Button("确认") { onResolve("yes", "approved") }
                        .buttonStyle(.borderedProminent)
                    Button("拒绝") { onResolve("no", "denied") }
                        .buttonStyle(.bordered)
                }
            case "choice" where !request.options.isEmpty:
                // Options as tappable rows (wraps for long labels).
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(request.options) { option in
                        Button {
                            onResolve(option.value, "submitted")
                        } label: {
                            Text(option.label)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            default:
                HStack(spacing: 8) {
                    TextField(request.defaultValue ?? "输入回答…", text: $text, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(submitText)
                    Button("回答", action: submitText)
                        .buttonStyle(.borderedProminent)
                        .disabled(trimmed.isEmpty && request.defaultValue == nil)
                }
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.blue.opacity(0.35), lineWidth: 1)
        )
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submitText() {
        let answer = trimmed.isEmpty ? (request.defaultValue ?? "") : trimmed
        guard !answer.isEmpty else { return }
        onResolve(answer, "submitted")
    }
}
