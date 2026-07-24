import SwiftUI

/// One conversation: streamed transcript + input bar + approval sheet.
struct ChatView: View {
    let conversationId: String?
    let title: String

    @State private var model: ChatViewModel
    @FocusState private var inputFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var refineText = ""
    @State private var showRefine = false

    init(conversationId: String?, title: String) {
        self.conversationId = conversationId
        self.title = title
        _model = State(initialValue: ChatViewModel(conversationId: conversationId))
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if let plan = model.proposedPlan {
                Divider()
                PlanProposalView(
                    plan: plan,
                    onAccept: { model.acceptPlan(postMode: $0) },
                    onRefine: { showRefine = true })
                    .padding(.horizontal)
                    .padding(.vertical, 6)
            }
            if let hitl = model.pendingHitl {
                Divider()
                HitlCardView(request: hitl) { payload, status in
                    model.resolveHitl(payload: payload, status: status)
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
            }
            if !model.plan.isEmpty {
                Divider()
                PlanCardView(items: model.plan)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
            }
            Divider()
            inputBar
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { modeMenu }
            ToolbarItem(placement: .topBarTrailing) { modelMenu }
        }
        .task { await model.start() }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { _, phase in
            // The socket rarely survives a suspension; reconnect as
            // soon as we're back instead of waiting out the backoff.
            if phase == .active { model.ensureConnected() }
        }
        .sheet(item: $model.pendingApproval) { approval in
            ApprovalSheet(approval: approval) { approved, reason in
                model.resolveApproval(approve: approved, reason: reason)
            }
            .presentationDetents([.medium, .large])
            .interactiveDismissDisabled()
        }
        .alert("优化计划", isPresented: $showRefine) {
            TextField("补充要求…", text: $refineText)
            Button("取消", role: .cancel) { refineText = "" }
            Button("发送") {
                model.refinePlan(refineText)
                refineText = ""
            }
        } message: {
            Text("把反馈发给 Jarvis,它会重新规划。")
        }
    }

    /// Permission-mode badge + switcher. Lets the user drop into Plan
    /// Mode so the next message triggers read-only investigation.
    private var modeMenu: some View {
        Menu {
            ForEach(ChatViewModel.selectableModes, id: \.value) { mode in
                Button {
                    model.setMode(mode.value)
                } label: {
                    if model.permissionMode == mode.value {
                        Label(mode.label, systemImage: "checkmark")
                    } else {
                        Text(mode.label)
                    }
                }
            }
        } label: {
            Label(ChatViewModel.modeLabel(model.permissionMode),
                  systemImage: model.permissionMode == "plan"
                    ? "list.bullet.clipboard" : "shield.lefthalf.filled")
                .font(.caption)
        }
        .disabled(model.isStreaming)
    }

    /// Provider/model picker. Hidden when the server advertises a
    /// single model (nothing to choose).
    @ViewBuilder
    private var modelMenu: some View {
        if model.providers.contains(where: { $0.models.count > 1 })
            || model.providers.count > 1 {
            Menu {
                ForEach(model.providers) { provider in
                    Section(provider.name) {
                        ForEach(provider.models, id: \.self) { m in
                            Button {
                                model.selectModel(provider: provider.name, model: m)
                            } label: {
                                if model.currentModel == m
                                    && model.currentProviderName == provider.name {
                                    Label(m, systemImage: "checkmark")
                                } else {
                                    Text(m)
                                }
                            }
                        }
                    }
                }
            } label: {
                Label(model.currentModel ?? "模型", systemImage: "cpu")
                    .font(.caption)
            }
            .disabled(model.isStreaming)
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if model.isReconnecting {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text("连接断开,正在重连…")
                        }
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .center)
                    } else if let error = model.connectionError {
                        Label(error, systemImage: "wifi.exclamationmark")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    ForEach(model.items) { item in
                        TranscriptItemView(item: item)
                            .id(item.id)
                    }
                    if model.isStreaming {
                        HStack(spacing: 6) {
                            ProgressView()
                            Text("思考中…")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .id("streaming-indicator")
                    }
                }
                .padding()
            }
            .onChange(of: model.items.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: model.isStreaming) {
                scrollToBottom(proxy)
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            if model.isStreaming {
                proxy.scrollTo("streaming-indicator", anchor: .bottom)
            } else if let last = model.items.last {
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }

    private var inputBar: some View {
        VStack(spacing: 4) {
            if let usage = model.usage {
                Text(usage.compactLine)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            inputRow
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("发消息给 Jarvis…", text: $model.draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .focused($inputFocused)
                .onSubmit { model.send() }

            if model.isStreaming {
                Button {
                    model.interrupt()
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(.red)
                }
            } else {
                Button {
                    model.send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

/// Renders one transcript entry: user / assistant bubble, tool card,
/// info or error line.
struct TranscriptItemView: View {
    let item: TranscriptItem

    var body: some View {
        switch item.kind {
        case .user(let text):
            HStack {
                Spacer(minLength: 40)
                Text(text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 18))
            }
        case .assistant(let text):
            HStack {
                Text(.init(text))  // Markdown-aware
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(uiColor: .secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                    .textSelection(.enabled)
                Spacer(minLength: 40)
            }
        case .tool(let name, let arguments, let output, let denied):
            ToolCallCard(name: name, arguments: arguments, output: output, denied: denied)
        case .subagent(let card):
            SubagentCardView(card: card)
        case .info(let text):
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        case .error(let text):
            Label(text, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }
}

/// Collapsible card for one tool invocation.
struct ToolCallCard: View {
    let name: String
    let arguments: String
    let output: String?
    let denied: Bool

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: denied
                        ? "hand.raised.fill"
                        : (output == nil ? "gearshape.2" : "checkmark.circle"))
                        .foregroundStyle(denied ? .red : (output == nil ? .orange : .green))
                    Text(name)
                        .font(.system(.footnote, design: .monospaced))
                        .fontWeight(.medium)
                    if output == nil && !denied {
                        ProgressView().controlSize(.mini)
                    }
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    Text("参数")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    codeBlock(arguments)
                    if let output, !output.isEmpty {
                        Text("结果")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        codeBlock(String(output.prefix(4000)))
                    }
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

    private func codeBlock(_ text: String) -> some View {
        ScrollView(.horizontal) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
