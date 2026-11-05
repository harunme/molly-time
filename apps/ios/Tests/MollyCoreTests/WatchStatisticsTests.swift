import Foundation
import Testing
@testable import MollyCore

struct WatchStatisticsTests {
    @Test func backfillStatusIsOptionalForOlderServers() throws {
        for (field, expected) in [("", nil), (",\"summaryUpdating\":true", true), (",\"summaryUpdating\":false", false)] as [(String, Bool?)] {
            let json = """
            {"timezone":"Asia/Shanghai","todayPlayedMs":1000,"weekPlayedMs":1000,"weekStart":"2026-11-02","days":[]\(field)}
            """
            let stats = try JSONDecoder().decode(WatchStatistics.self, from: Data(json.utf8))
            #expect(stats.summaryUpdating == expected)
            #expect(stats.todayPlayedMs == 1000)
        }
    }
    private func decode(_ days: String) throws -> WatchStatistics {
        let json = """
        {"watch":{"timezone":"Asia/Shanghai","todayPlayedMs":1260000,"weekPlayedMs":5160000,"weekStart":"2026-11-02","days":\(days)},"media":{"folders":9}}
        """
        return try JSONDecoder().decode(WatchOverview.self, from: Data(json.utf8)).watch
    }
    @Test func serverTotalsAndHeatLevelsArePreserved() throws {
        let stats = try decode(#"[{"date":"2026-11-01","playedMs":0},{"date":"2026-11-02","playedMs":899999},{"date":"2026-11-03","playedMs":900000},{"date":"2026-11-04","playedMs":1800000},{"date":"2026-10-31","playedMs":3600000}]"#)
        #expect(stats.todayPlayedMs == 1260000)
        #expect(stats.weekPlayedMs == 5160000)
        #expect(stats.activeDays == 4)
        #expect(stats.totalPlayedMs == 7199999)
        #expect(stats.orderedDays.map(\.level) == [4, 0, 1, 2, 3])
        #expect(stats.months == ["2026-11", "2026-10"])
    }
    @Test func calendarUsesServerDateKeysAndMondayColumns() throws {
        let stats = try decode(#"[{"date":"2026-11-01","playedMs":1000},{"date":"2026-11-02","playedMs":2000},{"date":"2026-11-04","playedMs":3000}]"#)
        let cells = stats.monthCells("2026-11")
        #expect(cells.count == 10) // No empty future weeks below November 4.
        #expect(cells.prefix(6).allSatisfy { $0 == nil })
        #expect(cells[6]?.date == "2026-11-01") // Sunday
        #expect(cells[7]?.date == "2026-11-02") // Monday
        let weeks = stats.recentWeeks
        #expect(weeks.count == 12)
        #expect(weeks[10][6]?.date == "2026-11-01")
        #expect(weeks[11][0]?.date == "2026-11-02")
        #expect(weeks[11][2]?.date == "2026-11-04")
        #expect(weeks[11][3] == nil) // Future day is blank, not zero watching.
    }
    @Test func leapDaysInvalidDatesAndEmptyHistory() throws {
        #expect(WatchStatistics.parseDate("2024-02-29") != nil)
        #expect(WatchStatistics.parseDate("2026-02-29") == nil)
        #expect(WatchStatistics.parseDate("2026-13-01") == nil)
        #expect(WatchStatistics.parseDate("bad") == nil)
        let stats = try decode("[]")
        #expect(stats.recentWeeks.isEmpty)
        #expect(stats.activeDays == 0)
        #expect(stats.totalPlayedMs == 0)
    }
    @Test func emptyStateKeepsHistoryEvenWithoutCurrentWeekActivity() throws {
        func history(today: Int = 0, week: Int = 0, days: String = "[]") throws -> WatchStatistics {
            let json = """
            {"timezone":"Asia/Shanghai","todayPlayedMs":\(today),"weekPlayedMs":\(week),"weekStart":"2026-11-02","days":\(days)}
            """
            return try JSONDecoder().decode(WatchStatistics.self, from: Data(json.utf8))
        }
        #expect(try !history().hasViewingHistory)
        #expect(try !history(days: #"[{"date":"2026-11-04","playedMs":0}]"#).hasViewingHistory)
        #expect(try history(days: #"[{"date":"2026-09-01","playedMs":1000}]"#).hasViewingHistory)
        #expect(try history(today: 1000).hasViewingHistory)
        #expect(try history(week: 1000).hasViewingHistory)
    }

    @Test func durationDoesNotMisrepresentShortWatchingAsZero() {
        #expect(WatchStatistics.duration(0) == "0 分钟")
        #expect(WatchStatistics.duration(600) == "1 秒")
        #expect(WatchStatistics.duration(1260000) == "21 分钟")
        #expect(WatchStatistics.duration(5160000) == "1 小时 26 分钟")
        #expect(WatchStatistics.duration(3600000) == "1 小时")
    }
}
