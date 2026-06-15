import Foundation
import Observation

@MainActor
@Observable
final class ConversationListViewModel {
    private(set) var conversations: [ConversationSummary] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    private let api = JarvisAPI()

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            conversations = try await api.listConversations(limit: 100)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func delete(at offsets: IndexSet) {
        let doomed = offsets.map { conversations[$0] }
        conversations.remove(atOffsets: offsets)
        Task {
            for row in doomed {
                try? await api.deleteConversation(id: row.id)
            }
        }
    }
}
