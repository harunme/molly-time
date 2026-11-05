import Foundation

public struct PlaybackPreferences: Decodable, Sendable {
    public let defaultSubtitle: String
}

public struct ReminderSettings: Decodable, Sendable {
    public struct Clip: Decodable, Sendable {
        public let itemId: String?
        public let ready: Bool
        public let source: String?
    }
    public let warning: Clip?
    public let farewell: Clip
}

public enum SettingsValidation {
    public static func validPIN(_ value: String) -> Bool {
        value.utf8.count == 4 && value.utf8.allSatisfy { (48...57).contains($0) }
    }
    public static func passwordError(_ value: String, confirmation: String) -> String? {
        if value.unicodeScalars.count < 8 { return "新密码至少需要 8 个字符。" }
        if value.utf8.count > 72 { return "新密码过长，请控制在 72 字节以内。" }
        if value != confirmation { return "两次输入的新密码不一致。" }
        return nil
    }
}

public struct ParentReminderState: Decodable, Sendable {
    public let requestId: String?
    public let phase: String
    public let episodeId: String?
}

public struct ParentReminderDevice: Decodable, Identifiable, Sendable {
    public struct Watching: Decodable, Sendable { public let name: String }
    public let id: String
    public let online: Bool
    public let requestId: String?
    public let currentWatch: Watching?
}
