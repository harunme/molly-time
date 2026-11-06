import Foundation
import Observation

/// Account-scoped shared state. Mutations invalidate it; views never own a copy.
@MainActor @Observable
public final class FamilyStorageStore {
    public private(set) var settings: FamilySettings?
    public private(set) var loading = false
    public private(set) var failure: String?
    private var revision = 0
    private var appliedRevision = -1
    private var generation = UUID()
    private var updatedAt: Date?
    private var task: Task<Void, Never>?
    private let now: () -> Date

    public init(now: @escaping () -> Date = Date.init) { self.now = now }

    public func invalidate() { revision += 1 }

    public func applyPlaybackPreferences(_ value: PlaybackPreferences) {
        revision += 1 // Reject any read that started before the save completed.
        settings?.defaultSubtitle = value.defaultSubtitle
    }

    public func reset() {
        generation = UUID()
        task?.cancel(); task = nil
        settings = nil; loading = false; updatedAt = nil; failure = nil
        revision = 0; appliedRevision = -1
    }

    public func refresh(load: @escaping @MainActor () async throws -> FamilySettings) async {
        if let task { await task.value; return }
        guard settings == nil || revision != appliedRevision
                || now().timeIntervalSince(updatedAt ?? .distantPast) >= 60 else { return }
        let current = generation
        loading = true; failure = nil
        let work = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.generation == current { self.loading = false; self.task = nil }
            }
            while self.generation == current && !Task.isCancelled {
                let target = self.revision
                do {
                    let value = try await load()
                    guard self.generation == current, !Task.isCancelled else { return }
                    // An upload completed while this request was in flight.
                    // Discard the older answer and fetch the committed result.
                    guard target == self.revision else { continue }
                    self.failure = nil
                    self.settings = value
                    self.appliedRevision = target
                    self.updatedAt = self.now()
                    return
                } catch {
                    guard self.generation == current, !Task.isCancelled else { return }
                    if target != self.revision { continue }
                    self.failure = error.localizedDescription
                    // Keep the last value on transient failure; foreground sync retries.
                    return
                }
            }
        }
        task = work
        await work.value
    }
}
