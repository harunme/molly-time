import Foundation

public struct LibrarySnapshot: Sendable {
    public let items: [Resource]
    public let total: Int
    public let page: Int
    public let hasNextPage: Bool
    public let folder: Resource?
}

/// One account owns this cache. Navigation reuses recent pages; mutations make
/// them stale without removing the content needed for an immediate first frame.
@MainActor public final class LibraryStore {
    private final class Entry {
        let snapshot: LibrarySnapshot
        let revision: UUID
        let date: Date
        init(_ snapshot: LibrarySnapshot, revision: UUID, date: Date) {
            self.snapshot = snapshot; self.revision = revision; self.date = date
        }
    }
    private struct Pending {
        let id: UUID
        let task: Task<LibrarySnapshot, Error>
    }
    private let entries = NSCache<NSString, Entry>()
    private var pending: [String: Pending] = [:]
    private var revision = UUID()
    private let lifetime: TimeInterval
    private let now: () -> Date

    public init(lifetime: TimeInterval = 60, now: @escaping () -> Date = Date.init) {
        self.lifetime = lifetime; self.now = now
        entries.countLimit = 24
        entries.totalCostLimit = 6_000 // Resources, rather than unbounded visited folders.
    }
    private func key(_ folderID: String?) -> String { folderID.map { "folder:\($0)" } ?? "root" }
    public func cached(folderID: String?) -> LibrarySnapshot? {
        entries.object(forKey: key(folderID) as NSString)?.snapshot
    }
    public func invalidate() {
        revision = UUID()
        pending.values.forEach { $0.task.cancel() }
        pending.removeAll()
    }
    public func reset() { invalidate(); entries.removeAllObjects() }

    public func load(folderID: String?, throughPage: Int = 1, force: Bool = false,
                     fetchPage: @escaping @MainActor (String?, Int) async throws -> Page<Resource>,
                     fetchFolder: @escaping @MainActor (String) async throws -> Resource) async throws -> LibrarySnapshot {
        let cacheKey = key(folderID)
        let epoch = revision
        let target = max(1, throughPage)
        // A caller disappearing does not cancel work shared by a new screen.
        // A caller asking for a later page first joins the current request.
        if let work = pending[cacheKey] {
            let value = try await work.task.value
            guard epoch == revision else { throw CancellationError() }
            if value.page >= target || !value.hasNextPage { return value }
            return try await load(folderID: folderID, throughPage: target,
                                  fetchPage: fetchPage, fetchFolder: fetchFolder)
        }
        let entry = entries.object(forKey: cacheKey as NSString)
        let fresh = entry.map { $0.revision == epoch && now().timeIntervalSince($0.date) < lifetime } ?? false
        if !force, fresh, let value = entry?.snapshot,
           value.page >= target || !value.hasNextPage { return value }
        let previous = !force && fresh ? entry?.snapshot : nil
        // Revalidate all already loaded pages together so refreshing never drops
        // the scroll position or mixes new ordering with old pagination.
        let lastPage = max(target, entry?.snapshot.page ?? 1)
        let id = UUID()
        let work = Task { @MainActor [self] in
            defer { if pending[cacheKey]?.id == id { pending[cacheKey] = nil } }
            do {
                async let detail: Resource? = Self.folderDetail(folderID, previous: previous, fetch: fetchFolder)
                var items = previous?.items ?? []
                var ids = Set(items.map(\.id))
                var loadedPage = previous?.page ?? 0
                var total = previous?.total ?? 0
                var hasNext = previous?.hasNextPage ?? true
                for number in (loadedPage + 1)...lastPage {
                    let result = try await fetchPage(folderID, number)
                    try Task.checkCancellation()
                    for item in result.items where ids.insert(item.id).inserted { items.append(item) }
                    loadedPage = number; total = result.total
                    hasNext = result.hasNext && !result.items.isEmpty
                    if !hasNext { break }
                }
                let folder = try await detail
                try Task.checkCancellation()
                guard revision == epoch else { throw CancellationError() }
                if folder?.status == "archived" { throw APIError.http(404, "合集已移入最近删除。") }
                let result = LibrarySnapshot(items: items, total: total, page: loadedPage, hasNextPage: hasNext, folder: folder)
                entries.setObject(Entry(result, revision: epoch, date: now()), forKey: cacheKey as NSString, cost: max(1, items.count))
                return result
            } catch {
                if revision == epoch, case APIError.http(404, _) = error {
                    entries.removeObject(forKey: cacheKey as NSString)
                }
                throw error
            }
        }
        pending[cacheKey] = Pending(id: id, task: work)
        return try await work.value
    }

    private static func folderDetail(_ id: String?, previous: LibrarySnapshot?,
                                     fetch: @escaping @MainActor (String) async throws -> Resource) async throws -> Resource? {
        guard let id else { return nil }
        if let previous { return previous.folder }
        return try await fetch(id)
    }
}
