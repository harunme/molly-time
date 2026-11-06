import Foundation
import Testing
@testable import MollyCore

@MainActor
struct FamilyStorageStoreTests {
    private func value(_ bytes: Int64, subtitle: String = "zh") throws -> FamilySettings {
        try JSONDecoder().decode(FamilySettings.self, from: Data("""
        {"familyName":"family","defaultSubtitle":"\(subtitle)","storage":{"usedBytes":\(bytes),"reservedBytes":0,"limitBytes":0}}
        """.utf8))
    }

    @Test func simultaneousReadersAndTabReturnsShareOneRequest() async throws {
        let store = FamilyStorageStore()
        let result = try value(19922311)
        var requests = 0
        let load = {
            requests += 1
            try await Task.sleep(for: .milliseconds(10))
            return result
        }
        async let first: Void = store.refresh(load: load)
        async let second: Void = store.refresh(load: load)
        _ = await (first, second)
        await store.refresh(load: load)
        #expect(requests == 1)
        #expect(store.settings?.defaultSubtitle == "zh")
        #expect(store.settings?.storage.usedBytes == 19922311)
    }

    @Test func successfulMutationDuringReadDiscardsStaleZeroAndRefreshes() async throws {
        let store = FamilyStorageStore()
        let gate = StorageGate()
        let zero = try value(0), uploaded = try value(19922311)
        var requests = 0
        let reading = Task {
            await store.refresh {
                requests += 1
                if requests == 1 { return await gate.load() }
                return uploaded
            }
        }
        await gate.started()
        store.invalidate()
        gate.finish(zero)
        await reading.value
        #expect(requests == 2)
        #expect(store.settings?.storage.usedBytes == 19922311)
        #expect(!store.loading)
    }

    @Test func accountSwitchRejectsLateResponseWithoutClearingNewValue() async throws {
        let store = FamilyStorageStore()
        let gate = StorageGate()
        let oldValue = try value(1000), newValue = try value(2000)
        let old = Task { await store.refresh { await gate.load() } }
        await gate.started()
        store.reset()
        #expect(store.settings == nil)
        await store.refresh { newValue }
        gate.finish(oldValue) // Simulate a transport that ignores cancellation.
        await old.value
        #expect(store.settings?.storage.usedBytes == 2000)
        #expect(!store.loading)
    }

    @Test func failedSilentRefreshPreservesValueAndRetries() async throws {
        let store = FamilyStorageStore()
        let before = try value(1000), after = try value(2000)
        await store.refresh { before }
        store.invalidate()
        await store.refresh { throw URLError(.notConnectedToInternet) }
        #expect(store.settings?.storage.usedBytes == 1000)
        await store.refresh { after }
        #expect(store.settings?.storage.usedBytes == 2000)
    }

    @Test func savedPreferenceIsImmediateAndRejectsAnOlderRead() async throws {
        let store = FamilyStorageStore()
        let before = try value(1000), after = try value(1000, subtitle: "en")
        await store.refresh { before }
        store.invalidate()
        let gate = StorageGate()
        var reads = 0
        let reading = Task {
            await store.refresh {
                reads += 1
                if reads == 1 { return await gate.load() }
                return after
            }
        }
        await gate.started()
        let saved = try JSONDecoder().decode(PlaybackPreferences.self, from: Data(#"{"defaultSubtitle":"en"}"#.utf8))
        store.applyPlaybackPreferences(saved)
        #expect(store.settings?.defaultSubtitle == "en")
        gate.finish(before)
        await reading.value
        #expect(reads == 2)
        #expect(store.settings?.defaultSubtitle == "en")
        store.reset()
        #expect(store.settings == nil)
    }

    @Test func foregroundRevalidationPicksUpAnotherDeviceChanges() async throws {
        var time = Date(timeIntervalSince1970: 0)
        let store = FamilyStorageStore(now: { time })
        let before = try value(1000), after = try value(2000)
        await store.refresh { before }
        time = time.addingTimeInterval(60)
        await store.refresh { after }
        #expect(store.settings?.storage.usedBytes == 2000)
    }
}

@MainActor
private final class StorageGate {
    private var continuation: CheckedContinuation<FamilySettings, Never>?
    private var startWaiter: CheckedContinuation<Void, Never>?
    func load() async -> FamilySettings {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            startWaiter?.resume(); startWaiter = nil
        }
    }
    func started() async {
        if continuation != nil { return }
        await withCheckedContinuation { startWaiter = $0 }
    }
    func finish(_ value: FamilySettings) { continuation?.resume(returning: value); continuation = nil }
}
