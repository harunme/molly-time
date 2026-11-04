import Foundation
import Observation

public enum RegistrationCode {
    public static func normalize(_ input: String) -> String? {
        let value = input.filter { !$0.isWhitespace && $0 != "-" }.uppercased()
        let alphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        guard value.count == 12, value.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return value
    }
}

public enum RegistrationEmail {
    public static func normalize(_ input: String) -> String? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard value.count <= 254, parts.count == 2 else { return nil }
        let local = String(parts[0]), labels = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        guard (1...64).contains(local.count), !local.hasPrefix("."), !local.hasSuffix("."), !local.contains(".."),
              local.range(of: #"^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$"#, options: .regularExpression) != nil,
              labels.count >= 2,
              labels.allSatisfy({ String($0).range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression) != nil }) else { return nil }
        return value
    }
}

public struct InvitationPreview: Decodable, Sendable {
    public let email: String?
    public let familyName: String?
    public let expiresAt: String
}
public struct InvitationActivation: Decodable, Sendable {
    public let email: String
    public let accountId: String
    public let familyName: String
}

@MainActor @Observable
public final class InvitationRegistration {
    public var code = ""
    public var email = ""
    public var password = ""
    public private(set) var preview: InvitationPreview?
    public private(set) var created: InvitationActivation?
    public private(set) var activationUncertain = false
    public private(set) var busy = false
    public private(set) var failure: String?
    public private(set) var existingEmail = false
    private var verifiedCode = ""
    private var submittedEmail = ""
    private let api: APIClient
    public init(api: APIClient) { self.api = api }
    public var loginOnly: Bool { created != nil || activationUncertain }
    public var loginEmail: String { created?.email ?? (loginOnly ? submittedEmail : email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
    public var canSubmit: Bool {
        preview != nil && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        SettingsValidation.passwordError(password, confirmation: password) == nil && !busy
    }
    public func verify() async {
        guard !busy, created == nil else { return }
        guard let normalized = RegistrationCode.normalize(code) else {
            failure = "请输入十二位注册邀请码，例如 XXXX-XXXX-XXXX。"; return
        }
        busy = true; failure = nil; defer { busy = false }
        do {
            let value: InvitationPreview = try await api.send("/api/manage/auth/invitation/preview", body: ["code": normalized])
            preview = value; verifiedCode = normalized; activationUncertain = false; existingEmail = false
            if let bound = value.email { email = bound }
        } catch { failure = error.localizedDescription }
    }
    public func changeCode() {
        guard !busy, !loginOnly else { return }
        preview = nil; verifiedCode = ""; failure = nil; existingEmail = false; password = ""
    }
    /// The login closure activates the session only after successful authentication.
    /// Once activation succeeds (or its response is lost), retries never consume the code again.
    public func submit(login: (String, String) async throws -> Void) async -> Bool {
        guard canSubmit, let preview else { return false }
        busy = true; failure = nil; existingEmail = false; defer { busy = false }
        if !loginOnly {
            guard let address = RegistrationEmail.normalize(preview.email ?? email) else {
                failure = "请输入有效邮箱，例如 name@example.com。"; return false
            }
            submittedEmail = address
            do {
                created = try await api.send("/api/manage/auth/invitation/activate", body: [
                    "code": verifiedCode, "email": address, "password": password,
                    "familyName": preview.familyName ?? "我的片库"
                ])
            } catch {
                if case APIError.http(let status, let message) = error, status < 500 {
                    failure = message; existingEmail = status == 409
                    if status == 404 { self.preview = nil; password = "" }
                } else {
                    activationUncertain = true
                    failure = "暂时未收到注册结果，账号可能已创建。请先尝试登录，避免重复提交邀请码。"
                }
                return false
            }
        }
        do {
            try await login(loginEmail, password)
            password = ""; code = ""; verifiedCode = ""
            return true
        } catch {
            failure = created != nil
                ? "账号已创建，但登录未完成。\(error.localizedDescription)"
                : "暂时无法确认注册结果。\(error.localizedDescription)你可以重新检查邀请码。"
            return false
        }
    }
}
