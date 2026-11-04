import Foundation
import Testing
@testable import MollyCore

@MainActor
struct ResourceCacheTests {
    @Test func simultaneousLoadsAndReturningCardsReuseOneResult() async throws {
        let cache = ResourceCache<String>()
        var requests = 0
        let load = {
            requests += 1
            try await Task.sleep(for: .milliseconds(20))
            return "cover"
        }
        async let first = cache.value(for: "account-A/cover", load: load)
        async let second = cache.value(for: "account-A/cover", load: load)
        let results = try await [first, second]
        #expect(results == ["cover", "cover"])
        #expect(requests == 1)
        #expect(cache.cached(for: "account-A/cover") == "cover")
        _ = try await cache.value(for: "account-A/cover", load: load)
        #expect(requests == 1)
        #expect(cache.cached(for: "account-B/cover") == nil)
    }
    @Test func disappearingCardDoesNotCancelSharedLoad() async throws {
        let cache = ResourceCache<String>()
        let gate = LoadGate()
        let waiter = Task { try await cache.value(for: "cover") { await gate.load() } }
        await gate.started()
        waiter.cancel()
        gate.finish("cover")
        _ = try await waiter.value
        #expect(cache.cached(for: "cover") == "cover")
    }
    @Test func logoutRejectsLateResponsesAndKeepsNewSessionValue() async throws {
        let cache = ResourceCache<String>()
        let gate = LoadGate()
        let old = Task { try await cache.value(for: "cover") { await gate.load() } }
        await gate.started()
        cache.removeAll()
        _ = try await cache.value(for: "cover") { "new-account" }
        gate.finish("old-account") // Simulate a transport that ignores cancellation.
        do { _ = try await old.value; Issue.record("Old response was accepted after logout") }
        catch { #expect(error is CancellationError) }
        #expect(cache.cached(for: "cover") == "new-account")
    }
    @Test func failedRefreshKeepsPreviouslyDisplayedCover() async throws {
        let cache = ResourceCache<String>(lifetime: 0)
        _ = try await cache.value(for: "cover") { "old-cover" }
        do { _ = try await cache.value(for: "cover") { throw URLError(.notConnectedToInternet) } }
        catch { }
        #expect(cache.cached(for: "cover") == "old-cover")
        _ = try await cache.value(for: "cover") { "updated-cover" }
        #expect(cache.cached(for: "cover") == "updated-cover")
    }
}

@MainActor
private final class LoadGate {
    private var continuation: CheckedContinuation<String, Never>?
    private var startWaiter: CheckedContinuation<Void, Never>?
    func load() async -> String {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            startWaiter?.resume(); startWaiter = nil
        }
    }
    func started() async {
        if continuation != nil { return }
        await withCheckedContinuation { startWaiter = $0 }
    }
    func finish(_ value: String) { continuation?.resume(returning: value); continuation = nil }
}
