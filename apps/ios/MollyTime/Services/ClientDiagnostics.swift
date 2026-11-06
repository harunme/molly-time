import Foundation
import UIKit
import MetricKit
import CryptoKit
import MollyCore

/// MetricKit owns signal/crash collection; this queue never installs unsafe signal handlers.
final class ClientDiagnostics: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = ClientDiagnostics()
    private struct Crumb: Codable { var name: String; var at: String }
    private struct Report: Codable {
        var id: String; var installationId: String; var source = "ios-parent"
        var code: String; var fatal: Bool; var errorType: String; var stack: [String]
        var breadcrumbs: [Crumb]; var screen: String; var appVersion: String
        var osVersion: String; var deviceModel: String; var occurredAt: String
    }
    private struct Row: Codable { var owner: String; var body: Report }
    private struct Binding: Codable { var owner: String; var at: Date }
    private let lock = NSRecursiveLock()
    private let file: URL
    private let installation: String
    private let version: String
    private let os: String
    private let model: String
    private var rows: [Row] = []
    private var history: [Binding] = []
    private var owner: String
    private var screenName = "startup"
    private var crumbs: [Crumb] = []
    private var started = false
    private var lastError = ""
    private var lastErrorAt = Date.distantPast
    private var previousExceptionHandler: (@convention(c) (NSException) -> Void)?
    @MainActor private var api: APIClient?
    @MainActor private var flushing = false
    @MainActor private var retryTask: Task<Void, Never>?
    @MainActor private var retryAt = Date.distantPast

    private override init() {
        let defaults = UserDefaults.standard
        installation = defaults.string(forKey: "diagnostics.installation") ?? UUID().uuidString
        defaults.set(installation, forKey: "diagnostics.installation")
        owner = defaults.string(forKey: "diagnostics.owner") ?? ""
        version = "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"))"
        os = ProcessInfo.processInfo.operatingSystemVersionString
        var system = utsname(); uname(&system)
        let capacity = MemoryLayout.size(ofValue: system.machine)
        model = withUnsafePointer(to: &system.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { String(cString: $0) }
        }
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ClientDiagnostics", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var excluded = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        file = directory.appendingPathComponent("pending-v1.json")
        if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 1_024_000,
           let data = try? Data(contentsOf: file) {
            rows = (try? JSONDecoder().decode([Row].self, from: data)) ?? []
        }
        if let data = defaults.data(forKey: "diagnostics.bindings") {
            history = (try? JSONDecoder().decode([Binding].self, from: data)) ?? []
        }
        super.init()
    }

    @MainActor func start() {
        guard !started else { return }; started = true
        previousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exception in
            let reporter = ClientDiagnostics.shared
            reporter.record(type: exception.name.rawValue, code: "IOS_OBJC_EXCEPTION", fatal: true,
                            stack: exception.callStackSymbols)
            reporter.previousExceptionHandler?(exception)
        }
        MXMetricManager.shared.add(self)
        // Replayed system reports have deterministic IDs and are idempotent on the server.
        didReceive(MXMetricManager.shared.pastDiagnosticPayloads)
        retryTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.flush()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
    }

    @MainActor func bind(api: APIClient?, account: String = "") {
        let next = api.map { client in
            account.isEmpty ? "" : SHA256.hash(data: Data("\(client.endpoint.origin.absoluteString)|\(account)".utf8))
                .map { String(format: "%02x", $0) }.joined()
        } ?? ""
        lock.lock()
        if next != owner {
            crumbs = []; screenName = "startup"; lastError = ""
            history.append(Binding(owner: next, at: Date()))
            // Preserve the predecessor so a report interval has a known starting owner.
            let cutoff = Date().addingTimeInterval(-30 * 86400)
            while history.count > 1 && history[1].at < cutoff { history.removeFirst() }
            UserDefaults.standard.set(try? JSONEncoder().encode(history), forKey: "diagnostics.bindings")
        }
        owner = next
        UserDefaults.standard.set(next, forKey: "diagnostics.owner")
        lock.unlock()
        self.api = api
        retryAt = .distantPast
        Task { await flush() }
    }

    func breadcrumb(_ name: String) {
        guard name.range(of: "^[A-Za-z0-9_.:/-]{1,80}$", options: .regularExpression) != nil else { return }
        lock.lock(); defer { lock.unlock() }
        crumbs = Array(crumbs.suffix(19)) + [Crumb(name: name, at: Date().ISO8601Format())]
    }
    func screen(_ name: String) {
        guard name.range(of: "^[A-Za-z0-9_.:/-]{1,80}$", options: .regularExpression) != nil else { return }
        lock.lock(); screenName = name; breadcrumb("screen:\(name)"); lock.unlock()
    }
    func capture(_ error: Error, code: String) {
        guard !(error is CancellationError), (error as NSError).code != NSURLErrorCancelled else { return }
        let ns = error as NSError
        record(type: ns.domain, code: code, fatal: false,
               stack: ["errorCode=\(ns.code)"] + Thread.callStackSymbols)
        Task { @MainActor in await self.flush() }
    }

    private func record(type: String, code: String, fatal: Bool, stack: [String],
                        eventOwner: String? = nil, id: String = UUID().uuidString,
                        date: Date = Date(), appVersion: String? = nil) {
        lock.lock(); defer { lock.unlock() }
        let scope = eventOwner ?? owner
        guard !scope.isEmpty else { return }
        let safeType = String(type.replacingOccurrences(of: "[^A-Za-z0-9_.$:-]", with: "_", options: .regularExpression).prefix(128))
        let frames = stack.prefix(64).map { String($0.prefix(300)) }
        let signature = "\(code)|\(safeType)|\(frames.prefix(3))"
        if !fatal, signature == lastError, Date().timeIntervalSince(lastErrorAt) < 30 { return }
        lastError = signature; lastErrorAt = Date()
        let body = Report(id: id, installationId: installation, code: code, fatal: fatal,
            errorType: safeType.first?.isLetter == true ? safeType : "NativeError", stack: frames,
            breadcrumbs: eventOwner == nil ? crumbs : [], screen: eventOwner == nil ? screenName : "system.diagnostic",
            appVersion: String((appVersion ?? version).prefix(80)), osVersion: String(os.prefix(128)),
            deviceModel: String(model.prefix(128)), occurredAt: date.ISO8601Format())
        rows.removeAll { ISO8601DateFormatter().date(from: $0.body.occurredAt).map { $0 < Date().addingTimeInterval(-30 * 86400) } ?? true }
        guard !rows.contains(where: { $0.body.id == id }) else { return }
        if rows.count >= 32 { rows.remove(at: rows.firstIndex(where: { !$0.body.fatal }) ?? 0) }
        rows.append(Row(owner: scope, body: body)); save()
    }
    private func save() { if let data = try? JSONEncoder().encode(rows) { try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) } }

    @MainActor func flush() async {
        guard !flushing, Date() >= retryAt, let client = api, !client.csrf.isEmpty else { return }
        flushing = true; defer { flushing = false }
        let pending: [Row] = lock.withLock { Array(rows.filter { $0.owner == owner }.prefix(10)) }
        for row in pending {
            guard self.api === client, lock.withLock({ owner == row.owner }) else { return }
            do {
                let _ = try await client.raw("/api/client/error-logs", method: "POST", body: JSONEncoder().encode(row.body), timeout: 12)
            } catch {
                if case APIError.http(let status, _) = error, [400, 409, 413, 422].contains(status) { }
                else { retryAt = Date().addingTimeInterval(60); return }
            }
            lock.withLock { rows.removeAll { $0.body.id == row.body.id }; save() }
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            // Never attribute an earlier account's system report to the current account.
            let scope: String? = lock.withLock {
                guard let prior = history.last(where: { $0.at <= payload.timeStampBegin }) else { return nil }
                let owners = Set([prior.owner] + history.filter { $0.at > payload.timeStampBegin && $0.at <= payload.timeStampEnd }.map(\.owner))
                return owners.count == 1 && !prior.owner.isEmpty ? prior.owner : nil
            }
            guard let scope else { continue }
            for crash in payload.crashDiagnostics ?? [] {
                let data = crash.callStackTree.jsonRepresentation()
                let hash = SHA256.hash(data: data + Data(payload.timeStampEnd.ISO8601Format().utf8)).map { String(format: "%02x", $0) }.joined()
                let id = "\(hash.prefix(8))-\(hash.dropFirst(8).prefix(4))-\(hash.dropFirst(12).prefix(4))-\(hash.dropFirst(16).prefix(4))-\(hash.dropFirst(20).prefix(12))"
                record(type: "Signal_\(crash.signal?.intValue ?? 0)", code: "IOS_METRICKIT_CRASH", fatal: true,
                       stack: Self.metricFrames(data), eventOwner: scope, id: id, date: payload.timeStampEnd,
                       appVersion: crash.applicationVersion)
            }
        }
        Task { @MainActor in await self.flush() }
    }

    private static func metricFrames(_ data: Data) -> [String] {
        guard data.count <= 512_000, let tree = try? JSONSerialization.jsonObject(with: data) else { return [] }
        var frames: [String] = []
        func walk(_ object: Any, depth: Int) {
            guard depth < 40, frames.count < 64 else { return }
            if let object = object as? [String: Any] {
                if let name = object["binaryName"] as? String {
                    // Only binary identity and numeric addresses; no diagnostic reason/messages.
                    let safe = name.replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
                    let uuid = (object["binaryUUID"] as? String ?? "").filter { $0.isHexDigit || $0 == "-" }
                    frames.append("\(safe) uuid=\(uuid) offset=\((object["offsetIntoBinaryTextSegment"] as? NSNumber)?.stringValue ?? "0") address=\((object["address"] as? NSNumber)?.stringValue ?? "0")")
                }
                for key in object.keys.sorted() { if let value = object[key] { walk(value, depth: depth + 1) } }
            } else if let array = object as? [Any] { for value in array.prefix(64) { walk(value, depth: depth + 1) } }
        }
        walk(tree, depth: 0); return frames
    }
}
