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
    public struct HiddenFolder: Codable, Hashable, Sendable {
        public let id: String
        public let name: String
    }
    public let id: String
    public let name: String
    public let type: String
    public let parentId: String?
    public let overview: String
    public let status: String
    public let ready: Bool
    public let runtimeMs: Int64
    public let imageUrl: String
    public let hiddenByFolder: HiddenFolder?
    public var isFolder: Bool { type != "Episode" }
    public var childrenCanWatch: Bool { ready && status == "published" && hiddenByFolder == nil }
    public var statusLabel: String {
        if !ready { return "处理中" }
        if status != "published" { return "仅家长可看" }
        if hiddenByFolder != nil { return "所在合集未开放" }
        return "孩子可看"
    }
    public init(id: String, name: String, type: String = "Series", parentId: String? = nil,
                overview: String = "", status: String = "published", ready: Bool = true,
                runtimeMs: Int64 = 0, imageUrl: String = "", hiddenByFolder: HiddenFolder? = nil) {
        self.id = id; self.name = name; self.type = type; self.parentId = parentId
        self.overview = overview; self.status = status; self.ready = ready
        self.runtimeMs = runtimeMs; self.imageUrl = imageUrl
        self.hiddenByFolder = hiddenByFolder
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
public struct Upload: Codable, Sendable {
    public let id: String
    public let itemId: String
    public let offset: Int64
    public let size: Int64
    public let status: String
    public let transport: String
    public let partSize: Int
    public let error: String
    public let taskId: String?
}
public struct UploadLimits: Decodable, Sendable { public let video: Int64 }
public struct SignedPart: Decodable, Sendable { public let url: String; public let headers: [String: String] }
public struct OK: Decodable, Sendable { public let ok: Bool }
public struct WatchControls: Decodable, Sendable {
    public struct Round: Decodable, Sendable {
        public let mode: String
        public let remainingMs: Int64?
        public let remainingEpisodes: Int?
        public let episodeId: String?
        public let episodeName: String?
    }
    public struct Control: Decodable, Identifiable, Sendable {
        public let deviceId: String
        public let name: String
        public let online: Bool
        public let version: Int
        public let enabled: Bool
        public let mode: String
        public let amount: Int
        public let status: String?
        public let supported: Bool?
        public let acknowledged: Int?
        public let round: Round?
        public var id: String { deviceId }
        public var awaitingConfirmation: Bool { acknowledged.map { version > $0 } ?? false }
        public var addLabel: String { (round?.mode ?? mode) == "episodes" ? "加看 1 集" : "加看 10 分钟" }
        public var remainingLabel: String {
            guard enabled else { return "未限制观看" }
            guard let status else { return "每天 \(amount) \(mode == "episodes" ? "集" : "分钟")" }
            guard status == "allowed", let round else { return "今日观看已结束" }
            if round.mode == "minutes", let remaining = round.remainingMs {
                if remaining <= 0 { return "今日观看已结束" }
                return remaining < 60000 ? "今天还能看不到 1 分钟" : "今天还能看 \((remaining + 59999) / 60000) 分钟"
            }
            guard let count = round.remainingEpisodes else { return "正在同步观看额度" }
            if round.episodeId != nil { return count > 0 ? "这一集之后，还能看 \(count) 集" : "这是今天最后一集" }
            return "今天还能看 \(count) 集"
        }
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
