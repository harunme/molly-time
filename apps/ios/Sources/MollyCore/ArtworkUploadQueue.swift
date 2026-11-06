import Foundation
import Observation
import CryptoKit

/// Account-owned optimistic covers. Local drafts survive process termination;
/// retries resume the upload/job instead of re-sending already accepted bytes.
@MainActor @Observable
public final class ArtworkUploadQueue {
    public struct Draft: Codable, Sendable {
        public let id: UUID
        public let itemID: String
        public let data: Data
        public var upload: Upload?
        public var savedURL: String?
    }
    public private(set) var drafts: [String: Draft] = [:]
    private let root: URL
    private var directory: URL?
    private var scope: String?
    private var generation = UUID()
    private var tasks: [String: Task<Void, Never>] = [:]
    private let delay: @MainActor (Int) async throws -> Void

    public init(root: URL? = nil, delay: @escaping @MainActor (Int) async throws -> Void = { attempt in
        try await Task.sleep(for: .seconds([2, 5, 15, 60, 300][min(attempt, 4)]))
    }) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MollyPendingCovers-v1", isDirectory: true)
        self.delay = delay
    }
    private func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func file(_ itemID: String) -> URL? { directory?.appendingPathComponent(hash(itemID) + ".json") }
    private func persist(_ draft: Draft) {
        guard let directory, let file = file(draft.itemID) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let bytes = try? JSONEncoder().encode(draft) { try? bytes.write(to: file, options: .atomic) }
    }
    public func configure(scope: String, api: APIClient) {
        guard self.scope != scope else { resume(api: api); return }
        reset()
        self.scope = scope
        let directory = root.appendingPathComponent(hash(scope), isDirectory: true)
        self.directory = directory
        for file in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            if let bytes = try? Data(contentsOf: file), let draft = try? JSONDecoder().decode(Draft.self, from: bytes) {
                drafts[draft.itemID] = draft
            }
        }
        resume(api: api)
    }
    public func reset() {
        generation = UUID()
        tasks.values.forEach { $0.cancel() }; tasks.removeAll()
        drafts.removeAll(); directory = nil; scope = nil
    }
    public func enqueue(_ data: Data, itemID: String, api: APIClient) {
        guard scope != nil, !data.isEmpty else { return }
        let previous = drafts[itemID]?.upload
        tasks.removeValue(forKey: itemID)?.cancel()
        let draft = Draft(id: UUID(), itemID: itemID, data: data)
        drafts[itemID] = draft; persist(draft)
        if let previous, ["uploading", "failed"].contains(previous.status) {
            Task { try? await api.command("/api/manage/uploads/\(previous.id)/cancel") }
        }
        resume(api: api)
    }
    public func acknowledge(itemID: String, imageURL: String) {
        guard let draft = drafts[itemID], draft.savedURL == imageURL else { return }
        drafts[itemID] = nil
        if let file = file(itemID) { try? FileManager.default.removeItem(at: file) }
    }
    public func resume(api: APIClient) {
        let account = generation
        for draft in drafts.values where draft.savedURL == nil && tasks[draft.itemID] == nil {
            tasks[draft.itemID] = Task { [weak self] in
                guard let self else { return }
                defer {
                    if self.generation == account, self.drafts[draft.itemID] == nil || self.drafts[draft.itemID]?.id == draft.id { self.tasks[draft.itemID] = nil }
                }
                for attempt in 0..<6 {
                    guard !Task.isCancelled, self.generation == account, let current = self.drafts[draft.itemID], current.id == draft.id else { return }
                    do {
                        try await ResourceArtworkUpload.send(current.data, itemID: current.itemID, api: api, resume: current.upload) { [weak self] upload in
                            guard let self, self.generation == account else { return }
                            guard var value = self.drafts[current.itemID], value.id == current.id else {
                                if upload.status == "uploading" { Task { try? await api.command("/api/manage/uploads/\(upload.id)/cancel") } }
                                return
                            }
                            value.upload = upload; self.drafts[current.itemID] = value; self.persist(value)
                        }
                        let resource: Resource = try await api.request("/api/manage/resources/\(current.itemID)")
                        guard !Task.isCancelled, self.generation == account, var value = self.drafts[current.itemID], value.id == current.id else { return }
                        value.savedURL = resource.imageUrl; self.drafts[current.itemID] = value; self.persist(value)
                        api.onLibraryChange?()
                        return
                    } catch {
                        guard !Task.isCancelled, self.generation == account else { return }
                        // Authentication and invalid input need a new session or
                        // selection, not an endless loop of chargeable requests.
                        if case APIError.unauthorized = error { return }
                        if case APIError.http(let code, _) = error, [400, 403, 413, 422].contains(code) { return }
                        if case APIError.http(let code, _) = error, [404, 410].contains(code) {
                            if var value = self.drafts[current.itemID], value.id == current.id {
                                value.upload = nil; self.drafts[current.itemID] = value; self.persist(value)
                            }
                        }
                        do { try await self.delay(attempt) } catch { return }
                    }
                }
            }
        }
    }
}
