import SwiftUI

/// Root screen: persisted conversations from `GET /v1/conversations`,
/// plus entry points for a new chat and server settings.
struct ConversationListView: View {
    @State private var model = ConversationListViewModel()
    @State private var showSettings = false
    /// Each new-chat tap gets a fresh identity so ChatView state resets.
    @State private var newChatToken: UUID?

    var body: some View {
        NavigationStack {
            Group {
                if let error = model.errorMessage, model.conversations.isEmpty {
                    ContentUnavailableView {
                        Label("无法连接服务器", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("检查设置") { showSettings = true }
                        Button("重试") { Task { await model.refresh() } }
                    }
                } else {
                    list
                }
            }
            .navigationTitle("Jarvis")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        newChatToken = UUID()
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                }
            }
            .navigationDestination(for: ConversationSummary.self) { row in
                ChatView(conversationId: row.id, title: row.displayTitle)
            }
            .navigationDestination(item: $newChatToken) { _ in
                ChatView(conversationId: nil, title: "新会话")
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .task { await model.refresh() }
            .refreshable { await model.refresh() }
        }
    }

    private var list: some View {
        List {
            ForEach(model.conversations) { row in
                NavigationLink(value: row) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.displayTitle)
                            .font(.body)
                            .lineLimit(2)
                        HStack(spacing: 8) {
                            if let date = row.updatedDate {
                                Text(date, style: .relative)
                            }
                            if let count = row.messageCount {
                                Text("\(count) 条消息")
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            }
            .onDelete { model.delete(at: $0) }
        }
        .listStyle(.plain)
        .overlay {
            if model.conversations.isEmpty && !model.isLoading {
                ContentUnavailableView(
                    "还没有会话",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("点右上角开始新会话"))
            }
        }
    }
}

#Preview {
    ConversationListView()
}
