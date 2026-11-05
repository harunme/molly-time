import Foundation
import Testing
@testable import MollyCore

@MainActor
struct DeviceRefreshTriggerTests {
    @Test func delayedTVHandshakeUpdatesAnAlreadyLoadedList() async {
        var time = Date(timeIntervalSince1970: 0)
        let trigger = DeviceRefreshTrigger(now: { time }, sleep: { delay in
            time = time.addingTimeInterval(Double(delay.components.seconds))
        })
        var displayed = [String]()
        var samples = [[String]]()
        trigger.bindingConfirmed()
        await trigger.refresh(since: 0) {
            // Approval succeeds at t=0; the TV doesn't poll until t=6.
            displayed = time.timeIntervalSince1970 >= 6 ? ["living-room"] : []
            samples.append(displayed)
        }
        #expect(samples.first == [])
        #expect(displayed == ["living-room"])
        #expect(time.timeIntervalSince1970 == 60)
        let requests = samples.count
        await trigger.refresh(since: trigger.revision) { samples.append(displayed) }
        #expect(samples.count == requests) // Ordinary tab switching stays cached.
    }

    @Test func initialLoadAndClosingAnUnconfirmedSheetDoNotPoll() async {
        var requests = 0
        let trigger = DeviceRefreshTrigger(sleep: { _ in Issue.record("Unexpected retry") })
        await trigger.refresh(since: nil) { requests += 1 }
        await trigger.refresh(since: trigger.revision) { requests += 1 }
        #expect(requests == 1)
    }

    @Test func returningToTabKeepsPendingHandshakeAlive() async {
        var time = Date(timeIntervalSince1970: 0)
        var interrupted = true
        var requests = 0
        let trigger = DeviceRefreshTrigger(now: { time }, sleep: { delay in
            if interrupted { throw CancellationError() }
            time = time.addingTimeInterval(Double(delay.components.seconds))
        })
        trigger.bindingConfirmed()
        await trigger.refresh(since: 0) { requests += 1 }
        #expect(requests == 1)
        interrupted = false
        // Even though the first request completed, its empty result is not final.
        await trigger.refresh(since: trigger.revision) { requests += 1 }
        #expect(requests > 1)
        #expect(time.timeIntervalSince1970 == 60)
    }

    @Test func accountResetStopsOldHandshakeRefreshes() async {
        let trigger = DeviceRefreshTrigger(sleep: { _ in Issue.record("Old account retried") })
        var requests = 0
        trigger.bindingConfirmed()
        await trigger.refresh(since: 0) {
            requests += 1
            trigger.reset()
        }
        #expect(requests == 1)
        await trigger.refresh(since: nil) { requests += 1 }
        #expect(requests == 2) // New account gets just its own initial load.
    }
}
