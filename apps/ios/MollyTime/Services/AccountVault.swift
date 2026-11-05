import Foundation
import Security
import MollyCore

/// One device-only Keychain record holds the account list and their session tokens.
enum AccountVault {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.mollytime.parent.accounts",
        kSecAttrAccount as String: "saved-accounts-v1"
    ]
    static func read() throws -> [SavedAccount] {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else { throw failure }
        return try JSONDecoder().decode([SavedAccount].self, from: data)
    }
    static func save(_ accounts: [SavedAccount]) throws {
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(accounts),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw failure }
    }
    private static var failure: APIError { .http(0, "无法安全保存登录信息，请解锁手机后重试。") }
}
