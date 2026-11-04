import Foundation

/// A session-owned, bounded cache. A disappearing view does not cancel a shared
/// load. Stale entries remain available for display while revalidation runs.
@MainActor
public final class ResourceCache<Value> {
    private final class Entry {
        let value: Value
        let date = Date()
        init(_ value: Value) { self.value = value }
    }
    private struct Pending {
        let id: UUID
        let task: Task<Value, Error>
    }
    private let values = NSCache<NSString, Entry>()
    private var pending: [String: Pending] = [:]
    private var generation = UUID()
    private let lifetime: TimeInterval
    public init(costLimit: Int = 64 * 1024 * 1024, countLimit: Int = 200, lifetime: TimeInterval = 600) {
        values.totalCostLimit = costLimit
        values.countLimit = countLimit
        self.lifetime = lifetime
    }
    public func cached(for key: String) -> Value? { values.object(forKey: key as NSString)?.value }
    public func value(for key: String, cost: @escaping (Value) -> Int = { _ in 1 },
                      load: @escaping @MainActor () async throws -> Value) async throws -> Value {
        if let entry = values.object(forKey: key as NSString), Date().timeIntervalSince(entry.date) < lifetime {
            return entry.value
        }
        let epoch = generation
        let request: Pending
        if let existing = pending[key] { request = existing }
        else {
            request = Pending(id: UUID(), task: Task { try await load() })
            pending[key] = request
        }
        defer { if pending[key]?.id == request.id { pending[key] = nil } }
        let result = try await request.task.value
        guard epoch == generation else { throw CancellationError() }
        values.setObject(Entry(result), forKey: key as NSString, cost: max(1, cost(result)))
        return result
    }
    public func removeAll() {
        generation = UUID()
        pending.values.forEach { $0.task.cancel() }
        pending.removeAll()
        values.removeAllObjects()
    }
}
