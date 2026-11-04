import Foundation

public struct ParentSession: Codable, Sendable {
    public struct User: Codable, Sendable {
        public let id: String
        public let name: String
        public let role: String
        public let accountId: String
        public let email: String?
        public let displayName: String?
        public let avatarJPEGBase64: String?
    }
    public struct Family: Codable, Sendable { public let id: String; public let name: String }
    public let user: User
    public let family: Family
    public let csrfToken: String
    public var canManage: Bool { ["admin", "superadmin"].contains(user.role) }
}

public struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    public let items: [Item]
    public let page: Int
    public let pageSize: Int
    public let total: Int
    public var hasNext: Bool { page * pageSize < total }
}

public struct Resource: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let type: String
    public let parentId: String?
    public let overview: String
    public let status: String
    public let ready: Bool
    public let runtimeMs: Int64
    public let imageUrl: String
    public var isFolder: Bool { type != "Episode" }
    public var statusLabel: String { !ready ? "处理中" : status == "published" ? "孩子可看" : "仅家长可看" }
    public init(id: String, name: String, type: String = "Series", parentId: String? = nil,
                overview: String = "", status: String = "published", ready: Bool = true,
                runtimeMs: Int64 = 0, imageUrl: String = "") {
        self.id = id; self.name = name; self.type = type; self.parentId = parentId
        self.overview = overview; self.status = status; self.ready = ready
        self.runtimeMs = runtimeMs; self.imageUrl = imageUrl
    }
}

public struct Device: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let revoked: Bool
    public let lastSeen: String
}
public struct PairingPreview: Decodable, Sendable { public let name: String; public let expiresAt: String; public let returningDevice: Bool? }
public struct FamilySettings: Decodable, Sendable {
    public struct Storage: Decodable, Sendable {
        public let usedBytes: Int64
        public let reservedBytes: Int64
        public let limitBytes: Int64
    }
    public let familyName: String
    public let storage: Storage
}
public struct Playback: Decodable, Sendable {
    public struct Subtitle: Decodable, Identifiable, Sendable {
        public let index: Int
        public let label: String
        public let url: String
        public let offsetMs: Int
        public let isDefault: Bool
        public var id: Int { index }
    }
    public let mediaId: String
    public let url: String
    public let expiresAt: String?
    public let subtitles: [Subtitle]
}
public struct Upload: Decodable, Sendable {
    public let id: String
    public let itemId: String
    public let offset: Int64
    public let size: Int64
    public let status: String
    public let transport: String
    public let partSize: Int
    public let error: String
}
public struct UploadLimits: Decodable, Sendable { public let video: Int64 }
public struct SignedPart: Decodable, Sendable { public let url: String; public let headers: [String: String] }
public struct OK: Decodable, Sendable { public let ok: Bool }
public struct WatchControls: Decodable, Sendable {
    public struct Control: Decodable, Identifiable, Sendable {
        public let deviceId: String
        public let name: String
        public let online: Bool
        public let version: Int
        public let enabled: Bool
        public let mode: String
        public let amount: Int
        public var id: String { deviceId }
    }
    public let pinSet: Bool
    public let devices: [Control]
}

public enum DisplayFormat {
    public static func duration(_ ms: Int64) -> String {
        guard ms > 0 else { return "时长待更新" }
        let seconds = ms / 1000
        return String(format: "%lld:%02lld", seconds / 60, seconds % 60)
    }
    public static func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }
}
