import Foundation
import CryptoKit

/// One resumable upload per account and purpose. The movie is app-owned so
/// temporary Photos/File Provider URLs are not required after relaunch.
public struct UploadDraftStore: Sendable {
    public struct Draft: Codable, Sendable {
        public let name: String
        public let folder: Resource?
        public let resource: Resource?
        public let upload: Upload?
        public let allowChildren: Bool
        public let published: Bool
        public let reminderKind: String?
        public let autoResume: Bool?
        public init(name: String, folder: Resource?, resource: Resource?, upload: Upload?, allowChildren: Bool,
                    published: Bool, reminderKind: String?, autoResume: Bool = false) {
            self.name = name; self.folder = folder; self.resource = resource; self.upload = upload
            self.allowChildren = allowChildren; self.published = published; self.reminderKind = reminderKind; self.autoResume = autoResume
        }
    }
    private let directory: URL
    public var movieURL: URL { directory.appendingPathComponent("video.mp4") }
    private var metadataURL: URL { directory.appendingPathComponent("draft.json") }
    public init(root: URL, scope: String, purpose: String) {
        let key = SHA256.hash(data: Data("\(scope)|\(purpose)".utf8)).map { String(format: "%02x", $0) }.joined()
        directory = root.appendingPathComponent(key, isDirectory: true)
    }
    public func load() throws -> Draft? {
        guard FileManager.default.fileExists(atPath: metadataURL.path),
              FileManager.default.fileExists(atPath: movieURL.path) else { return nil }
        return try JSONDecoder().decode(Draft.self, from: Data(contentsOf: metadataURL))
    }
    public func save(_ draft: Draft) throws {
        try prepareDirectory()
        try JSONEncoder().encode(draft).write(to: metadataURL, options: .atomic)
    }
    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var url = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
    }
    public func importMovie(_ source: URL) throws -> URL {
        if source.standardizedFileURL == movieURL.standardizedFileURL { return movieURL }
        try prepareDirectory()
        let temporary = directory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: temporary)
        defer { try? output.close() }
        while true {
            try Task.checkCancellation()
            guard let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty else { break }
            try output.write(contentsOf: data)
        }
        try output.synchronize()
        if FileManager.default.fileExists(atPath: movieURL.path) {
            _ = try FileManager.default.replaceItemAt(movieURL, withItemAt: temporary)
        } else { try FileManager.default.moveItem(at: temporary, to: movieURL) }
        return movieURL
    }
    public func clear() throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
}
