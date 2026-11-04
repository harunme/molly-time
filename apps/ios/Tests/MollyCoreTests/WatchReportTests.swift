import Foundation
import Testing
@testable import MollyCore

struct WatchReportTests {
    @Test func recentWeekUsesSevenCalendarDaysAcrossMonthBoundary() throws {
        let watch = try JSONDecoder().decode(WatchStatistics.self, from: Data(#"{"timezone":"Asia/Shanghai","todayPlayedMs":0,"weekPlayedMs":0,"weekStart":"2026-10-26","days":[{"date":"2026-11-04","playedMs":0}]}"#.utf8))
        #expect(WatchReportPeriod.today.dates(for: watch)?.start == "2026-11-04")
        #expect(WatchReportPeriod.recentWeek.dates(for: watch)?.start == "2026-10-29")
        #expect(WatchReportPeriod.recentWeek.dates(for: watch)?.end == "2026-11-04")
    }
    @Test func rollingTotalExcludesEighthDayEvenWhenDaysAreMissing() throws {
        let watch = try JSONDecoder().decode(WatchStatistics.self, from: Data(#"{"timezone":"Asia/Shanghai","todayPlayedMs":30,"weekPlayedMs":999,"weekStart":"2026-11-02","days":[{"date":"2026-10-28","playedMs":10000},{"date":"2026-10-29","playedMs":60},{"date":"2026-11-04","playedMs":30}]}"#.utf8))
        #expect(watch.recentWeekPlayedMs == 90)
        #expect(watch.recentWeekStart == "2026-10-29")
    }
    @Test func reportDecodesLegacyDeviceAndKeepsTotalsIndependentOfPages() throws {
        let report = try JSONDecoder().decode(WatchReport.self, from: Data(#"{"timezone":"Asia/Shanghai","totalPlayedMs":90000,"episodeCount":3,"lastSync":null,"days":[{"date":"2026-11-04","playedMs":90000,"devices":[{"deviceId":null,"playedMs":30000},{"deviceId":"tv","playedMs":60000}]}],"hours":[],"devices":[{"id":null,"name":"旧设备"},{"id":"tv","name":"客厅"}],"contents":[{"id":"series","name":"故事","playedMs":90000}],"sessions":[{"id":"s1","name":"第一集","deviceName":"客厅","startedAt":"2026-11-04T01:00:00+00:00","playedMs":10000,"ended":true}],"sessionTotal":9,"contentTotal":1,"pageSize":1}"#.utf8))
        #expect(report.duration(for: report.devices[0]) == 30000)
        #expect(report.duration(for: report.devices[1]) == 60000)
        #expect(report.totalPlayedMs == 90000)
        #expect(report.sessions.count == 1 && report.sessionTotal == 9)
        #expect(report.lastSync == nil)
    }
}
