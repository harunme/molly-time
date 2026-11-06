import Foundation
import Observation

/// Startup recovery is distinct from signing out: a failed connection keeps credentials.
@MainActor @Observable
public final class SessionRestoration {
    public private(set) var restoring = true
    public private(set) var failure: String?
    private var completed = false
    private var generation = UUID()
    private var task: Task<Void, Never>?
    private let sleep: @MainActor (Duration) async throws -> Void

    public init(sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.sleep = sleep
    }

    /// Login, logout and a definitive 401 supersede any outstanding startup request.
    public func finish() {
        generation = UUID()
        task?.cancel(); task = nil
        completed = true; restoring = false; failure = nil
    }

    public func restoreIfNeeded(load: @escaping @MainActor () async throws -> Void) async {
        guard !completed else { return }
        if let task { await task.value; return }
        let current = generation
        restoring = true
        let work = Task {
            defer {
                if self.generation == current { self.restoring = false; self.task = nil }
            }
            for attempt in 0..<3 {
                guard self.generation == current, !Task.isCancelled else { return }
                do {
                    try await load()
                    guard self.generation == current, !Task.isCancelled else { return }
                    self.completed = true; self.failure = nil
                    return
                } catch {
                    guard self.generation == current, !Task.isCancelled else { return }
                    if error as? APIError == .unauthorized {
                        self.finish()
                        return
                    }
                    if Self.isTransient(error), attempt < 2 {
                        do { try await self.sleep(.seconds(attempt + 1)) }
                        catch { return }
                        continue
                    }
                    self.failure = Self.isTransient(error)
                        ? "暂时无法连接服务，请检查网络后重试。"
                        : error.localizedDescription
                    return
                }
            }
        }
        task = work
        await work.value
    }

    private static func isTransient(_ error: Error) -> Bool {
        if case let APIError.http(status, _) = error { return [502, 503, 504].contains(status) }
        guard let error = error as? URLError else { return false }
        return [.timedOut, .networkConnectionLost, .notConnectedToInternet,
                .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(error.code)
    }
}
