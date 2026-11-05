import Foundation
import Testing
@testable import MollyCore

struct ParentWorkflowTests {
    @Test func hiddenParentOverridesPublishedEpisode() throws {
        let resource = try JSONDecoder().decode(Resource.self, from: Data(#"{"id":"e","name":"视频","type":"Episode","overview":"","status":"published","ready":true,"runtimeMs":1,"imageUrl":"","hiddenByFolder":{"id":"s","name":"合集"}}"#.utf8))
        #expect(!resource.childrenCanWatch)
        #expect(resource.statusLabel == "所在合集未开放")
        #expect(Resource(id: "e", name: "视频", type: "Episode").childrenCanWatch)
    }
    private func control(_ extra: String) throws -> WatchControls.Control {
        try JSONDecoder().decode(WatchControls.Control.self, from: Data((#"{"deviceId":"tv","name":"客厅","online":true,"version":3,"enabled":true,"mode":"episodes","amount":2"# + extra + "}").utf8))
    }
    @Test func legacyAndLiveAllowances() throws {
        #expect(try control("").remainingLabel == "每天 2 集")
        let playing = try control(#", "status":"allowed","acknowledged":2,"round":{"mode":"episodes","remainingEpisodes":1,"episodeId":"e"}"#)
        #expect(playing.awaitingConfirmation)
        #expect(playing.remainingLabel == "这一集之后，还能看 1 集")
        let last = try control(#", "status":"allowed","round":{"mode":"episodes","remainingEpisodes":0,"episodeId":"e"}"#)
        #expect(last.remainingLabel == "这是今天最后一集")
        #expect(try control(#", "status":"resting","round":null"#).remainingLabel == "今日观看已结束")
        #expect(try control(#", "status":"allowed","round":{"mode":"minutes","remainingMs":60001}"#).remainingLabel == "今天还能看 2 分钟")
        #expect(try control(#", "status":"allowed","round":{"mode":"minutes","remainingMs":1}"#).remainingLabel == "今天还能看不到 1 分钟")
    }
    @Test func reminderCommandResponseDoesNotRequireDeviceListFields() throws {
        let state = try JSONDecoder().decode(ParentReminderState.self, from: Data(#"{"requestId":"r1","phase":"pending","episodeId":"e","sessionId":"w","warningPath":"/api/reminders/warning/playback","farewellPath":"/api/reminders/farewell/playback"}"#.utf8))
        #expect(state.requestId == "r1")
        #expect(state.phase == "pending")
    }
    @Test func resumableDraftSurvivesSourceRemovalAndIsIsolated() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source.mp4")
        let bytes = Data(repeating: 7, count: 1024 * 1024 + 3)
        try bytes.write(to: source)
        let store = UploadDraftStore(root: root, scope: "server|alice", purpose: "library")
        let savedURL = try store.importMovie(source)
        let upload = try JSONDecoder().decode(Upload.self, from: Data(#"{"id":"up","itemId":"e","offset":42,"size":1048579,"status":"uploading","transport":"local","partSize":4194304,"error":""}"#.utf8))
        try store.save(.init(name: "小视频", folder: Resource(id: "f", name: "合集"), resource: Resource(id: "e", name: "小视频"), upload: upload, allowChildren: true, published: false, reminderKind: nil))
        try FileManager.default.removeItem(at: source)
        let restored = try UploadDraftStore(root: root, scope: "server|alice", purpose: "library").load()
        #expect(restored?.upload?.id == "up")
        #expect(restored?.folder?.id == "f")
        #expect(restored?.allowChildren == true)
        #expect(try Data(contentsOf: savedURL) == bytes)
        #expect(try UploadDraftStore(root: root, scope: "server|bob", purpose: "library").load() == nil)
        #expect(try UploadDraftStore(root: root, scope: "server|alice", purpose: "reminder").load() == nil)
        try store.clear()
        #expect(try store.load() == nil)
        #expect(!FileManager.default.fileExists(atPath: savedURL.path))
    }
    @Test func backgroundResumeIntentIsBackwardCompatibleAndPausePersists() throws {
        let legacy = Data(#"{"name":"视频","allowChildren":false,"published":false}"#.utf8)
        #expect(try JSONDecoder().decode(UploadDraftStore.Draft.self, from: legacy).autoResume == nil)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("source.mp4")
        try Data([1]).write(to: source)
        let store = UploadDraftStore(root: root, scope: "server|alice", purpose: "library")
        _ = try store.importMovie(source)
        for resume in [true, false] {
            try store.save(.init(name: "视频", folder: nil, resource: nil, upload: nil,
                                 allowChildren: false, published: false, reminderKind: nil, autoResume: resume))
            #expect(try store.load()?.autoResume == resume)
        }
    }
    @Test func reminderSettingsDistinguishBuiltinAndCustomWithoutBreakingOldServers() throws {
        let current = Data(#"{"warning":{"ready":true,"source":"builtin"},"farewell":{"ready":true,"source":"custom","itemId":"f"}}"#.utf8)
        let decoded = try JSONDecoder().decode(ReminderSettings.self, from: current)
        #expect(decoded.warning?.source == "builtin")
        #expect(decoded.farewell.source == "custom")
        let old = Data(#"{"farewell":{"ready":false}}"#.utf8)
        #expect(try JSONDecoder().decode(ReminderSettings.self, from: old).farewell.source == nil)
    }
    @Test func missingMovieDoesNotOfferBrokenResume() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = UploadDraftStore(root: root, scope: "a", purpose: "library")
        try store.save(.init(name: "视频", folder: nil, resource: nil, upload: nil, allowChildren: false, published: false, reminderKind: nil))
        #expect(try store.load() == nil)
    }
}
