import Foundation
import Observation

public struct TrashDeletion: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let error: String
    public var pending: Bool { status == "pending" }
}
public struct TrashDeletionReceipt: Decodable, Sendable {
    public let ok: Bool
    public let deleting: Bool?
}

/// Tracks deletion outside the trash screen. Missing jobs have finished; failed
/// polls never imply success, and a pre-submit poll cannot complete a new job.
@MainActor @Observable public final class TrashDeletionStore {
    public private(set) var jobs: [String: TrashDeletion] = [:]
    public private(set) var settlementRevision = 0
    public var hasPending: Bool { jobs.values.contains(where: \.pending) }
    private var epoch = UUID()
    private var submitted = 0
    private var task: Task<Bool, Never>?
    public init() { }
    public func track(_ id: String) {
        submitted += 1
        jobs[id] = TrashDeletion(id: id, status: "pending", error: "")
    }
    public func reset() {
        epoch = UUID(); task?.cancel(); task = nil
        jobs = [:]; settlementRevision = 0; submitted = 0
    }
    /// True only for the caller that applies a completion/failure transition.
    public func refresh(fetch: @escaping @MainActor () async throws -> [TrashDeletion]) async -> Bool {
        if let task { _ = await task.value; return false }
        let generation = epoch, revision = submitted
        let work = Task { @MainActor [self] in
            defer { if epoch == generation { task = nil } }
            do {
                let result = try await fetch()
                guard epoch == generation, revision == submitted, !Task.isCancelled else { return false }
                let next = Dictionary(result.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
                let settled = jobs.values.contains { old in
                    next[old.id] == nil || (old.pending && next[old.id]?.pending == false)
                }
                jobs = next
                if settled { settlementRevision += 1 }
                return settled
            } catch { return false }
        }
        task = work
        return await work.value
    }
}
