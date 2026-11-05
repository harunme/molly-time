import Foundation
import UIKit
import CryptoKit

/// File-backed transfers survive suspension. One stable session per account/purpose
/// reconnects to tasks after an OS relaunch; the server remains the offset authority.
@MainActor
final class BackgroundUploadTransport: NSObject, @preconcurrency URLSessionDataDelegate {
    static let prefix = "app.mollytime.upload."
    private static var instances: [String: BackgroundUploadTransport] = [:]
    static func shared(identifier: String) -> BackgroundUploadTransport {
        if let existing = instances[identifier] { return existing }
        let value = BackgroundUploadTransport(identifier: identifier)
        instances[identifier] = value
        return value
    }
    static func identifier(scope: String, purpose: String) -> String {
        prefix + SHA256.hash(data: Data("\(scope)|\(purpose)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func handleEvents(identifier: String, completion: @escaping () -> Void,
                             restore: @escaping @MainActor () async -> Void) {
        let transport = shared(identifier: identifier)
        transport.restoring = true
        transport.completions.append(completion)
        Task {
            await restore()
            transport.restoring = false
            transport.finishEventsIfPossible()
        }
    }
    private let identifier: String
    private let directory: URL
    private var session: URLSession!
    private var waiters: [String: CheckedContinuation<(Data, HTTPURLResponse), Error>] = [:]
    private var receipts: [String: Result<(Data, HTTPURLResponse), Error>] = [:]
    private var bodies: [Int: Data] = [:]
    private var activeTaskIDs: [String: Int] = [:]
    private var progressHandlers: [String: (Int64, Int64) -> Void] = [:]
    private var completions: [() -> Void] = []
    private var eventsDelivered = false
    private var restoring = false
    private var pipelineActive = false
    private var waitingForTransfer = false
    private var grace: UIBackgroundTaskIdentifier = .invalid

    private init(identifier: String) {
        self.identifier = identifier
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BackgroundUploads", isDirectory: true).appendingPathComponent(identifier, isDirectory: true)
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.waitsForConnectivity = true
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.httpMaximumConnectionsPerHost = 1
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 24 * 60 * 60
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }
    func beginPipeline() {
        pipelineActive = true
        beginGrace()
    }
    func endPipeline() {
        pipelineActive = false; waitingForTransfer = false
        endGrace(); finishEventsIfPossible()
    }
    private func beginGrace() {
        guard grace == .invalid else { return }
        grace = UIApplication.shared.beginBackgroundTask(withName: "准备下一段上传") { [weak self] in
            Task { @MainActor in
                self?.endGrace()
                self?.releaseEvents()
            }
        }
    }
    private func endGrace() {
        if grace != .invalid { UIApplication.shared.endBackgroundTask(grace); grace = .invalid }
    }
    private func fileURL(_ key: String) -> URL {
        let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name)
    }
    func send(_ request: URLRequest, data: Data, key: String,
              progress: @escaping (Int64, Int64) -> Void = { _, _ in }) async throws -> (Data, HTTPURLResponse) {
        try Task.checkCancellation()
        // An existing daemon task owns its original request and file. Do not
        // overwrite that file or create another PUT while reconnecting.
        let tasks = await session.allTasks
        try Task.checkCancellation()
        if let receipt = receipts.removeValue(forKey: key) { return try receipt.get() }
        guard waiters[key] == nil else { throw URLError(.resourceUnavailable) }
        let existing = tasks.first { $0.taskDescription == key }
        if existing == nil {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            var folder = directory; try folder.setResourceValues(values)
            try data.write(to: fileURL(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        let task = existing ?? session.uploadTask(with: request, fromFile: fileURL(key))
        task.taskDescription = key
        activeTaskIDs[key] = task.taskIdentifier
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters[key] = continuation; progressHandlers[key] = progress
                waitingForTransfer = true
                task.resume()
                endGrace(); finishEventsIfPossible()
            }
        } onCancel: {
            task.cancel()
        }
    }
    func cancelAll() async {
        let tasks = await session.allTasks
        for task in tasks { task.cancel() }
        // Completion callbacks own the continuations. Waiting for cancellation
        // acknowledgement prevents a late callback cancelling a resumed part.
        receipts.removeAll()
    }
    private func finishEventsIfPossible() {
        guard eventsDelivered, !completions.isEmpty, !restoring, !pipelineActive || waitingForTransfer else { return }
        releaseEvents()
    }
    private func releaseEvents() {
        guard eventsDelivered else { return }
        eventsDelivered = false
        let handlers = completions; completions.removeAll()
        for handler in handlers { handler() }
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        eventsDelivered = true
        finishEventsIfPossible()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // API responses and storage error bodies are small; bound retained data.
        if (bodies[dataTask.taskIdentifier]?.count ?? 0) < 1024 * 1024 {
            bodies[dataTask.taskIdentifier, default: Data()].append(data)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if let key = task.taskDescription { progressHandlers[key]?(totalBytesSent, totalBytesExpectedToSend) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let key = task.taskDescription else { return }
        let data = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
        if let active = activeTaskIDs[key], active != task.taskIdentifier { return }
        activeTaskIDs.removeValue(forKey: key)
        let result: Result<(Data, HTTPURLResponse), Error>
        if let error { result = .failure(error) }
        else if let response = task.response as? HTTPURLResponse { result = .success((data, response)) }
        else { result = .failure(URLError(.badServerResponse)) }
        try? FileManager.default.removeItem(at: fileURL(key))
        progressHandlers.removeValue(forKey: key)
        if pipelineActive { beginGrace() }
        if let waiter = waiters.removeValue(forKey: key) { waiter.resume(with: result) }
        else if (error as? URLError)?.code != .cancelled { receipts[key] = result }
        waitingForTransfer = !waiters.isEmpty
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward a parent cookie, CSRF token or signed storage headers.
        completionHandler(nil)
    }
}

@MainActor
final class UploadAppDelegate: NSObject, UIApplicationDelegate {
    let store = SessionStore()
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier.hasPrefix(BackgroundUploadTransport.prefix) else { completionHandler(); return }
        BackgroundUploadTransport.handleEvents(identifier: identifier, completion: completionHandler) {
            await self.store.restoreIfNeeded()
            self.store.resumeUploads()
        }
    }
}
