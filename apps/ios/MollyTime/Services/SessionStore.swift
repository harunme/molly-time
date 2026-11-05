import Foundation
import Observation
import Security
import UIKit
import MollyCore

private enum SecureSession {
    static let service = "app.mollytime.parent.session"
    static func read(server: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: server,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func write(_ value: String?, server: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: server]
        SecItemDelete(query as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}

@MainActor @Observable
final class SessionStore {
    private(set) var session: ParentSession?
    private(set) var api: APIClient
    private(set) var accounts: [SavedAccount] = []
    private(set) var switchingAccount = false
    private(set) var activeAccountID: String?
    private var epoch = UUID()
    private var pausedUploads: [String: (library: UploadModel, reminder: UploadModel)] = [:]
    var sessionGeneration: UUID { epoch }
    var upload = UploadModel()
    var reminderUpload = UploadModel()
    var parentPINConfigured = false
    private(set) var libraryRevision = 0
    let deviceRefresh = DeviceRefreshTrigger()
    let storage = FamilyStorageStore()
    let artwork = ResourceCache<UIImage>()
    let artworkDisk = ArtworkDiskCache()
    let library = LibraryStore()
    private var restoreTask: Task<Void, Never>?
    var restoring = true
    var message: String?
    var serverAddress: String
    var canManage: Bool { session?.canManage == true }
    var scope: String { "\(api.endpoint.origin.absoluteString)|\(session?.user.id ?? "signed-out")" }
    var hasPendingUpload: Bool {
        (upload.selectedURL != nil && !upload.completed) || (reminderUpload.selectedURL != nil && !reminderUpload.completed)
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: "serverAddress") ?? "https://mollytime.app"
        let records = (try? AccountVault.read()) ?? []
        let selectedID = UserDefaults.standard.string(forKey: "activeAccountID")
        let selected = records.first { $0.id == selectedID }
        let endpoint = (try? Endpoint(selected?.server ?? saved)) ?? (try! Endpoint("https://mollytime.app"))
        accounts = records
        activeAccountID = selected?.id
        serverAddress = endpoint.origin.absoluteString
        api = APIClient(endpoint: endpoint)
        api.cookie = selected?.cookie ?? SecureSession.read(server: serverAddress) ?? ""
        configureCallbacks()
    }
    private func configureCallbacks() {
        let client = api
        client.onCookie = { [weak self, weak client] value in
            guard let self, let client, self.api === client else { return }
            guard let current = self.session else { return }
            let record = SavedAccount(server: self.serverAddress, session: current, cookie: value)
            do { try self.remember(record) }
            catch { self.message = error.localizedDescription }
        }
        client.onUnauthorized = { [weak self, weak client] in
            guard let self, let client, self.api === client else { return }
            self.clearSession()
            self.message = "登录已过期，请重新登录。"
        }
        client.onStorageChange = { [weak self, weak client] in
            guard let self, let client, self.api === client, self.session != nil else { return }
            self.storage.invalidate()
            Task { await self.refreshStorage() }
        }
        client.onLibraryChange = { [weak self, weak client] in
            guard let self, let client, self.api === client else { return }
            self.library.invalidate()
            self.libraryRevision += 1
        }
    }
    func loadLibrary(folderID: String?, throughPage: Int, force: Bool = false) async throws -> LibrarySnapshot {
        let client = api
        return try await library.load(folderID: folderID, throughPage: throughPage, force: force, fetchPage: { folderID, page in
            var query = [URLQueryItem(name: "page", value: "\(page)"), URLQueryItem(name: "pageSize", value: "30"), URLQueryItem(name: "sort", value: "manual")]
            if let folderID { query.append(URLQueryItem(name: "parentId", value: folderID)) }
            return try await client.request("/api/manage/resources", query: query)
        }, fetchFolder: { id in
            try await client.request("/api/manage/resources/\(id)")
        })
    }
    func resetLibraryUpload() {
        if upload.completed { upload.discardDraft() }
        upload = UploadModel(); upload.configureDraft(scope: scope, purpose: "library")
    }
    func resetReminderUpload() {
        reminderUpload = UploadModel(); reminderUpload.configureDraft(scope: scope, purpose: "reminder")
    }
    private func configureUploadDrafts() {
        upload.configureDraft(scope: scope, purpose: "library")
        reminderUpload.configureDraft(scope: scope, purpose: "reminder")
    }
    func refreshStorage() async {
        guard session != nil else { return }
        let client = api
        await storage.refresh { try await client.request("/api/manage/settings") }
    }
    private func remember(_ record: SavedAccount) throws {
        // Re-read to avoid overwriting records if Keychain was locked at app launch.
        let latest = try AccountVault.read()
        let updated = SavedAccount.replacing(record, in: latest)
        try AccountVault.save(updated)
        accounts = updated
    }
    func restoreIfNeeded() async {
        if let restoreTask { await restoreTask.value; return }
        let task = Task { await restore() }
        restoreTask = task
        await task.value
    }
    func resumeUploads() {
        guard session != nil, canManage else { return }
        upload.resumeAutomatically(api: api)
        reminderUpload.resumeAutomatically(api: api)
    }
    func restore() async {
        defer { restoring = false }
        guard !api.cookie.isEmpty else { return }
        let client = api; let requestEpoch = epoch
        do {
            let value: ParentSession = try await client.request("/api/manage/auth/session")
            guard api === client, epoch == requestEpoch else { return }
            let record = SavedAccount(server: serverAddress, session: value, cookie: client.cookie)
            try remember(record)
            session = value; client.csrf = value.csrfToken; activeAccountID = record.id
            configureUploadDrafts()
            resumeUploads()
            UserDefaults.standard.set(record.id, forKey: "activeAccountID")
            SecureSession.write(nil, server: serverAddress)
        } catch { if epoch == requestEpoch { message = error.localizedDescription } }
    }
    func login(username: String, password: String, server: String) async throws {
        guard !switchingAccount else { throw APIError.http(409, "正在切换账号，请稍候。") }
        switchingAccount = true; defer { switchingAccount = false }
        let requestEpoch = epoch
        let candidate = APIClient(endpoint: try Endpoint(server))
        let value = try await AccountAuthentication.login(username: username, password: password, client: candidate)
        try await activate(value, client: candidate, expectedEpoch: requestEpoch)
    }
    func switchAccount(_ account: SavedAccount) async throws {
        guard !switchingAccount else { throw APIError.http(409, "正在切换账号，请稍候。") }
        guard activeAccountID != account.id || session == nil else { return }
        switchingAccount = true; defer { switchingAccount = false }
        let requestEpoch = epoch
        let candidate = APIClient(endpoint: try Endpoint(account.server))
        do {
            let value = try await AccountAuthentication.restore(account, client: candidate)
            try await activate(value, client: candidate, expectedEpoch: requestEpoch)
        } catch APIError.unauthorized {
            var expired = account; expired.cookie = ""
            try remember(expired)
            throw APIError.unauthorized
        }
    }
    private func activate(_ value: ParentSession, client: APIClient, expectedEpoch: UUID) async throws {
        guard epoch == expectedEpoch else { throw CancellationError() }
        try Task.checkCancellation()
        // Cancel and await the old upload tasks before replacing their model/API.
        await upload.pauseAndWait()
        await reminderUpload.pauseAndWait()
        guard epoch == expectedEpoch else { throw CancellationError() }
        let record = SavedAccount(server: client.endpoint.origin.absoluteString, session: value, cookie: client.cookie)
        try remember(record)
        if session != nil, let activeAccountID {
            pausedUploads[activeAccountID] = (upload, reminderUpload)
        }
        retireClient()
        resetAccountState()
        api = client; session = value; serverAddress = record.server; activeAccountID = record.id
        if let paused = pausedUploads.removeValue(forKey: record.id) {
            upload = paused.library; reminderUpload = paused.reminder
        }
        configureUploadDrafts()
        epoch = UUID(); message = nil
        UserDefaults.standard.set(serverAddress, forKey: "serverAddress")
        UserDefaults.standard.set(record.id, forKey: "activeAccountID")
        SecureSession.write(nil, server: record.server)
        configureCallbacks()
    }
    private func retireClient() {
        api.onCookie = nil; api.onUnauthorized = nil
        api.onStorageChange = nil
        api.onLibraryChange = nil
        api.cookie = ""; api.csrf = ""
    }
    private func resetAccountState() {
        deviceRefresh.reset()
        storage.reset()
        artwork.removeAll()
        library.reset()
        upload.pause(); upload = UploadModel()
        reminderUpload.pause(); reminderUpload = UploadModel()
        parentPINConfigured = false
        URLCache.shared.removeAllCachedResponses()
    }
    func updateProfile(name: String, avatar: Data?) async throws {
        struct Update: Encodable { let displayName: String; let avatarJPEGBase64: String? }
        let requestEpoch = epoch
        let value: ParentSession = try await api.send("/api/manage/auth/profile", method: "PUT",
            body: Update(displayName: name, avatarJPEGBase64: avatar?.base64EncodedString()))
        guard epoch == requestEpoch, session != nil else { throw CancellationError() }
        try remember(SavedAccount(server: serverAddress, session: value, cookie: api.cookie))
        session = value; api.csrf = value.csrfToken
    }
    func forgetAccount(_ account: SavedAccount) throws {
        guard account.id != activeAccountID || session == nil else { return }
        let updated = try AccountVault.read().filter { $0.id != account.id }
        try AccountVault.save(updated); accounts = updated
        pausedUploads.removeValue(forKey: account.id)
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("UploadDrafts", isDirectory: true)
        let accountScope = "\((try? Endpoint(account.server).origin.absoluteString) ?? account.server)|\(account.session.user.id)"
        for purpose in ["library", "reminder"] {
            try UploadDraftStore(root: root, scope: accountScope, purpose: purpose).clear()
        }
    }
    func logout() async throws {
        guard !switchingAccount else { throw APIError.http(409, "正在切换账号，请稍候。") }
        await upload.pauseAndWait(); await reminderUpload.pauseAndWait()
        try await api.command("/api/manage/auth/logout")
        upload.discardDraft(); reminderUpload.discardDraft()
        clearSession(forget: true)
    }
    func clearSession(forget: Bool = false) {
        if let activeAccountID {
            do {
                var updated = try AccountVault.read()
                if forget { updated.removeAll { $0.id == activeAccountID } }
                else if let index = updated.firstIndex(where: { $0.id == activeAccountID }) { updated[index].cookie = "" }
                try AccountVault.save(updated); accounts = updated
            } catch { message = error.localizedDescription }
        }
        SecureSession.write(nil, server: api.endpoint.origin.absoluteString)
        retireClient(); resetAccountState()
        // A fresh API ensures late responses from the old session cannot affect a new login.
        api = APIClient(endpoint: api.endpoint)
        session = nil; activeAccountID = nil; epoch = UUID()
        UserDefaults.standard.removeObject(forKey: "activeAccountID")
        configureCallbacks()
    }
}
