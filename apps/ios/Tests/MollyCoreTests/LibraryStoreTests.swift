import Foundation
import Testing
@testable import MollyCore

@MainActor private final class LibraryFixture {
    var items = (1...5).map { Resource(id: "\($0)", name: "内容 \($0)") }
    var pages: [Int] = []
    var detailCalls = 0
    var delay: Duration = .zero
    var failure: APIError?
    func page(_ folder: String?, _ number: Int) async throws -> Page<Resource> {
        pages.append(number)
        if delay != .zero { try await Task.sleep(for: delay) }
        if let failure { throw failure }
        let start = min(items.count, (number - 1) * 2)
        return Page(items: Array(items[start..<min(items.count, start + 2)]), page: number, pageSize: 2, total: items.count)
    }
    func detail(_ id: String) async throws -> Resource {
        detailCalls += 1
        return Resource(id: id, name: "合集")
    }
    func load(_ store: LibraryStore, folder: String? = "folder", through: Int = 1, force: Bool = false) async throws -> LibrarySnapshot {
        try await store.load(folderID: folder, throughPage: through, force: force, fetchPage: page, fetchFolder: detail)
    }
}

@MainActor struct LibraryStoreTests {
    @Test func repeatedNavigationAndConcurrentRequestsReuseOneLoad() async throws {
        let store = LibraryStore(), fixture = LibraryFixture()
        fixture.delay = .milliseconds(30)
        async let first = fixture.load(store)
        async let duplicate = fixture.load(store)
        let values = try await (first, duplicate)
        #expect(values.0.items == values.1.items)
        _ = try await fixture.load(store)
        #expect(fixture.pages == [1])
        #expect(fixture.detailCalls == 1)
        #expect(store.cached(folderID: "folder")?.items.count == 2)
    }

    @Test func detailAndListStartWithoutWaitingForEachOther() async throws {
        let store = LibraryStore(), fixture = LibraryFixture()
        var detailFinished = false
        _ = try await store.load(folderID: "folder", fetchPage: { folder, page in
            #expect(!detailFinished)
            return try await fixture.page(folder, page)
        }, fetchFolder: { id in
            try await Task.sleep(for: .milliseconds(60))
            #expect(fixture.pages == [1])
            detailFinished = true
            return try await fixture.detail(id)
        })
        #expect(detailFinished)
    }

    @Test func paginationOnlyFetchesMissingPagesAndRefreshPreservesThem() async throws {
        let store = LibraryStore(), fixture = LibraryFixture()
        _ = try await fixture.load(store)
        let expanded = try await fixture.load(store, through: 2)
        #expect(fixture.pages == [1, 2])
        #expect(fixture.detailCalls == 1)
        #expect(expanded.items.count == 4)
        fixture.items.reverse()
        store.invalidate()
        #expect(store.cached(folderID: "folder")?.items == expanded.items)
        let reordered = try await fixture.load(store)
        #expect(reordered.page == 2)
        #expect(reordered.items.map(\.id) == ["5", "4", "3", "2"])
        #expect(fixture.pages == [1, 2, 1, 2])
        #expect(fixture.detailCalls == 2)
        fixture.items = Array(fixture.items.prefix(1))
        store.invalidate()
        let shortened = try await fixture.load(store)
        #expect(shortened.page == 1)
        #expect(shortened.items.count == 1)
        #expect(!shortened.hasNextPage)
    }

    @Test func laterPageWaiterExtendsAnInFlightLoad() async throws {
        let store = LibraryStore(), fixture = LibraryFixture()
        fixture.delay = .milliseconds(30)
        async let first = fixture.load(store)
        async let later = fixture.load(store, through: 3)
        let (_, full) = try await (first, later)
        #expect(full.items.count == 5)
        #expect(fixture.pages == [1, 2, 3])
        #expect(fixture.detailCalls == 1)
    }

    @Test func ttlAndExplicitRefreshRevalidateButTransientFailureKeepsContent() async throws {
        var date = Date()
        let store = LibraryStore(now: { date }), fixture = LibraryFixture()
        let original = try await fixture.load(store)
        date += 61
        _ = try await fixture.load(store)
        _ = try await fixture.load(store, force: true)
        #expect(fixture.pages == [1, 1, 1])
        fixture.failure = .http(503, "暂时不可用")
        do { _ = try await fixture.load(store, force: true); Issue.record("Expected failure") }
        catch { #expect(store.cached(folderID: "folder")?.items == original.items) }
        fixture.failure = .http(404, "合集不存在")
        do { _ = try await fixture.load(store, force: true); Issue.record("Expected failure") }
        catch { #expect(store.cached(folderID: "folder") == nil) }
    }

    @Test func mutationAndAccountResetRejectLateResponses() async throws {
        for reset in [false, true] {
            let store = LibraryStore(), fixture = LibraryFixture()
            _ = try await fixture.load(store)
            var continuation: CheckedContinuation<Page<Resource>, Never>?
            let old = Task { @MainActor in
                try await store.load(folderID: "folder", force: true, fetchPage: { _, _ in
                    await withCheckedContinuation { continuation = $0 }
                }, fetchFolder: fixture.detail)
            }
            while continuation == nil { await Task.yield() }
            if reset { store.reset(); #expect(store.cached(folderID: "folder") == nil) }
            else { store.invalidate() }
            fixture.items = [Resource(id: "new", name: "新的排列")]
            _ = try await fixture.load(store)
            continuation?.resume(returning: Page(items: [Resource(id: "old", name: "旧数据")], page: 1, pageSize: 2, total: 1))
            do { _ = try await old.value; Issue.record("Stale response was accepted") }
            catch { #expect(error is CancellationError) }
            #expect(store.cached(folderID: "folder")?.items.map(\.id) == ["new"])
        }
    }

    @Test func cancellingOneViewDoesNotCancelSharedNavigationLoad() async throws {
        let store = LibraryStore(), fixture = LibraryFixture()
        fixture.delay = .milliseconds(30)
        let disappearing = Task { try await fixture.load(store) }
        while fixture.pages.isEmpty { await Task.yield() }
        disappearing.cancel()
        let next = try await fixture.load(store)
        _ = try await disappearing.value
        #expect(next.items.count == 2)
        #expect(fixture.pages == [1])
    }
}
