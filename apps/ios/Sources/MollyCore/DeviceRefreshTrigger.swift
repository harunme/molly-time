import Foundation
import Observation

/// Parent approval precedes TV polling and device creation. Keep invalidation
/// alive across sheet dismissal and tab changes while that handshake settles.
@MainActor @Observable
public final class DeviceRefreshTrigger {
    public private(set) var revision = 0
    private var refreshUntil: Date?
    private let now: () -> Date
    private let sleep: (Duration) async throws -> Void

    public init(now: @escaping () -> Date = Date.init,
                sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.now = now
        self.sleep = sleep
    }

    public func bindingConfirmed() {
        revision += 1
        refreshUntil = now().addingTimeInterval(60)
    }

    public func reset() {
        revision += 1
        refreshUntil = nil
    }

    public func refresh(since loadedRevision: Int?, load: () async -> Void) async {
        let requestedRevision = revision
        guard loadedRevision != revision || (refreshUntil.map { $0 > now() } ?? false) else { return }
        while !Task.isCancelled && requestedRevision == revision {
            await load()
            guard !Task.isCancelled, requestedRevision == revision,
                  let refreshUntil, refreshUntil > now() else { return }
            do { try await sleep(.seconds(min(3, refreshUntil.timeIntervalSince(now())))) }
            catch { return }
        }
    }
}
