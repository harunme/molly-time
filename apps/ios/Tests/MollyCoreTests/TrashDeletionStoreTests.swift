import Foundation
import Testing
@testable import MollyCore

@MainActor struct TrashDeletionStoreTests {
    @Test func acceptedJobsSettleOnceAndFailedJobsCanBeRetried() async {
        let store = TrashDeletionStore()
        store.track("one"); store.track("two")
        #expect(store.hasPending)
        let failed = TrashDeletion(id: "two", status: "failed", error: "offline")
        #expect(await store.refresh { [failed] })
        #expect(store.jobs["one"] == nil)
        #expect(store.jobs["two"] == failed)
        #expect(!store.hasPending)
        #expect(store.settlementRevision == 1)
        #expect(!(await store.refresh { [failed] }))
        store.track("two")
        #expect(store.jobs["two"]?.error == "")
        #expect(await store.refresh { [] })
        #expect(store.settlementRevision == 2)
    }

    @Test func networkFailureNeverCompletesDeletion() async {
        let store = TrashDeletionStore()
        store.track("one")
        #expect(!(await store.refresh { throw URLError(.timedOut) }))
        #expect(store.hasPending)
        #expect(store.settlementRevision == 0)
        #expect(await store.refresh { [] })
    }

    @Test func stalePollCannotEraseANewlyAcceptedJob() async {
        let store = TrashDeletionStore()
        #expect(!(await store.refresh {
            // The HTTP response was captured before the deletion was accepted.
            store.track("new")
            return []
        }))
        #expect(store.jobs["new"]?.pending == true)
        #expect(store.settlementRevision == 0)
        #expect(await store.refresh { [] })
    }

    @Test func accountSwitchDiscardsOldResponse() async {
        let store = TrashDeletionStore()
        store.track("old")
        #expect(!(await store.refresh {
            store.reset()
            store.track("new")
            return [TrashDeletion(id: "old", status: "failed", error: "offline")]
        }))
        #expect(store.jobs.keys.sorted() == ["new"])
        #expect(store.settlementRevision == 0)
        #expect(await store.refresh { [] })
    }

    @Test func serverJobsAreRecoveredAfterAppRestart() async {
        let store = TrashDeletionStore()
        #expect(!(await store.refresh { [TrashDeletion(id: "queued", status: "pending", error: "")] }))
        #expect(store.hasPending)
        #expect(await store.refresh { [] })
    }

    @Test func concurrentPollersShareOneRequestAndOneCompletion() async throws {
        let store = TrashDeletionStore()
        store.track("one")
        var calls = 0
        let fetch: @MainActor () async throws -> [TrashDeletion] = {
            calls += 1
            try await Task.sleep(for: .milliseconds(30))
            return []
        }
        async let first = store.refresh(fetch: fetch)
        async let second = store.refresh(fetch: fetch)
        let results = await [first, second]
        #expect(results.filter { $0 }.count == 1)
        #expect(calls == 1)
        #expect(store.settlementRevision == 1)
    }
}
