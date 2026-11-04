import Foundation

public struct WatchOverview: Decodable, Sendable {
    public let watch: WatchStatistics
}

public struct WatchStatistics: Decodable, Sendable {
    public struct Day: Decodable, Identifiable, Sendable {
        public let date: String
        public let playedMs: Int64
        public var id: String { date }
        public var calendarDate: Date? { WatchStatistics.parseDate(date) }
        public var level: Int {
            switch playedMs {
            case ...0: return 0
            case ..<900_000: return 1
            case ..<1_800_000: return 2
            case ..<3_600_000: return 3
            default: return 4
            }
        }
    }
    public let timezone: String
    public let todayPlayedMs: Int64
    public let weekPlayedMs: Int64
    public let weekStart: String
    public let days: [Day]
    public var hasViewingHistory: Bool {
        todayPlayedMs > 0 || weekPlayedMs > 0 || days.contains { $0.playedMs > 0 }
    }
    public var orderedDays: [Day] { days.filter { $0.calendarDate != nil }.sorted { $0.date < $1.date } }
    public var recentWeekStart: String? {
        guard let latest = orderedDays.last?.calendarDate,
              let start = Self.calendar.date(byAdding: .day, value: -6, to: latest) else { return nil }
        let components = Self.calendar.dateComponents([.year, .month, .day], from: start)
        return String(format: "%04d-%02d-%02d", components.year!, components.month!, components.day!)
    }
    public var recentWeekPlayedMs: Int64 {
        guard let start = recentWeekStart else { return 0 }
        return orderedDays.filter { $0.date >= start }.reduce(0) { $0 + max(0, $1.playedMs) }
    }
    public var totalPlayedMs: Int64 { orderedDays.reduce(0) { $0 + max(0, $1.playedMs) } }
    public var activeDays: Int { orderedDays.filter { $0.playedMs > 0 }.count }
    public var months: [String] { Array(Set(orderedDays.map { String($0.date.prefix(7)) })).sorted(by: >) }

    // Date-only keys already represent the family's timezone. Never reinterpret
    // them in the phone's timezone (which may be on a different calendar day).
    public static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.firstWeekday = 2
        return calendar
    }
    public static func parseDate(_ key: String) -> Date? {
        let parts = key.split(separator: "-")
        guard key.count == 10, parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
              calendar.component(.year, from: date) == year,
              calendar.component(.month, from: date) == month,
              calendar.component(.day, from: date) == day else { return nil }
        return date
    }
    public static func mondayOffset(_ date: Date) -> Int { (calendar.component(.weekday, from: date) + 5) % 7 }

    public func monthCells(_ month: String) -> [Day?] {
        guard let first = Self.parseDate(month + "-01"),
              let count = Self.calendar.range(of: .day, in: .month, for: first)?.count else { return [] }
        let lookup = Dictionary(orderedDays.map { ($0.date, $0) }, uniquingKeysWith: { _, last in last })
        var cells: [Day?] = Array(repeating: nil, count: Self.mondayOffset(first)) + (1...count).map {
            lookup[String(format: "%@-%02d", month, $0)]
        }
        // The current month stops at the server's latest day. Do not reserve
        // empty future weeks, which would become a large blank area on phones.
        while !cells.isEmpty && cells.last! == nil { cells.removeLast() }
        return cells
    }
    public var recentWeeks: [[Day?]] {
        let ordered = orderedDays
        guard let last = ordered.last?.calendarDate,
              let monday = Self.calendar.date(byAdding: .day, value: -Self.mondayOffset(last) - 77, to: last) else { return [] }
        let lookup = Dictionary(ordered.compactMap { day in day.calendarDate.map { ($0, day) } }, uniquingKeysWith: { _, last in last })
        return (0..<12).map { week in
            (0..<7).map { day in
                Self.calendar.date(byAdding: .day, value: week * 7 + day, to: monday).flatMap { lookup[$0] }
            }
        }
    }
    public static func duration(_ ms: Int64) -> String {
        guard ms > 0 else { return "0 分钟" }
        if ms < 60_000 { return "\(max(1, Int((Double(ms) / 1000).rounded()))) 秒" }
        let minutes = ms / 60_000
        if minutes < 60 { return "\(minutes) 分钟" }
        return minutes % 60 == 0 ? "\(minutes / 60) 小时" : "\(minutes / 60) 小时 \(minutes % 60) 分钟"
    }
}

public enum WatchReportPeriod: String, Identifiable, Sendable {
    case today, recentWeek
    public var id: String { rawValue }
    public var title: String { self == .today ? "今日观看" : "近一周观看" }
    public func dates(for watch: WatchStatistics) -> (start: String, end: String)? {
        guard let today = watch.orderedDays.last?.date else { return nil }
        guard let start = watch.recentWeekStart else { return nil }
        return (self == .today ? today : start, today)
    }
}

public struct WatchReport: Decodable, Sendable {
    public struct Segment: Decodable, Sendable { public let deviceId: String?; public let playedMs: Int64 }
    public struct Device: Decodable, Sendable { public let id: String?; public let name: String }
    public struct Day: Decodable, Sendable { public let date: String; public let playedMs: Int64; public let devices: [Segment] }
    public struct Hour: Decodable, Sendable { public let hour: Int; public let playedMs: Int64 }
    public struct Content: Decodable, Identifiable, Sendable { public let id: String; public let name: String; public let playedMs: Int64 }
    public struct Session: Decodable, Identifiable, Sendable {
        public let id: String; public let name: String; public let deviceName: String
        public let startedAt: String; public let playedMs: Int64; public let ended: Bool
    }
    public let timezone: String
    public let totalPlayedMs: Int64
    public let episodeCount: Int
    public let lastSync: String?
    public let days: [Day]
    public let hours: [Hour]
    public let devices: [Device]
    public let contents: [Content]
    public let sessions: [Session]
    public let sessionTotal: Int
    public let contentTotal: Int
    public let pageSize: Int
    public func duration(for device: Device) -> Int64 {
        days.flatMap(\.devices).filter { $0.deviceId == device.id }.reduce(0) { $0 + $1.playedMs }
    }
}
