import SwiftUI
import MollyCore

struct WatchStatisticsCard: View {
    let watch: WatchStatistics
    @State private var selectedPeriod: WatchReportPeriod?
    private var today: String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: watch.timezone) ?? TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 24) { metrics }
                VStack(alignment: .leading, spacing: 14) { metrics }
            }
            Divider().opacity(0.5)
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("最近 12 周")
                    Spacer()
                    Circle().fill(Palette.yellow).frame(width: 8, height: 8)
                        .shadow(color: Palette.yellow.opacity(0.7), radius: 4)
                    Text("今天")
                }.font(.caption).foregroundStyle(.secondary)
                HStack(alignment: .top, spacing: 5) {
                    VStack(spacing: 4) {
                        ForEach(0..<7) { day in
                            Text(["一", "", "三", "", "五", "", "日"][day])
                                .font(.system(size: 10)).foregroundStyle(.tertiary)
                                .frame(width: 12, height: 16)
                        }
                    }.accessibilityHidden(true)
                    ForEach(Array(watch.recentWeeks.enumerated()), id: \.offset) { _, week in
                        VStack(spacing: 4) {
                            ForEach(0..<7) { row in
                                WatchDayDot(color: week[row].map { color($0.level) } ?? .clear,
                                            isToday: week[row]?.date == today)
                                    .frame(height: 16)
                            }
                        }.frame(maxWidth: .infinity)
                    }
                }.padding(.vertical, 3)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("最近十二周的每日观看记录，光晕圆点为今天")
                    .accessibilityValue(watch.orderedDays.suffix(84).filter { $0.playedMs > 0 }
                        .map { "\($0.date)，\(WatchStatistics.duration($0.playedMs))" }.joined(separator: "；"))
                HStack(spacing: 4) {
                    Text("少")
                    ForEach(0..<5) { level in Circle().fill(color(level)).frame(width: 6, height: 6) }
                    Text("多")
                    Spacer()
                }.font(.caption2).foregroundStyle(.secondary)
                    .accessibilityLabel("颜色越深，观看时长越长")
            }
            Text(watch.activeDays == 0 ? "电视开始播放后，好时光会留在这里。" : "近一年观看 \(watch.activeDays) 天 · 共 \(WatchStatistics.duration(watch.totalPlayedMs))")
                .font(.caption).foregroundStyle(.secondary)
        }.padding(20).background(Palette.paper, in: RoundedRectangle(cornerRadius: 28))
            .sheet(item: $selectedPeriod) { period in
                WatchHistorySheet(period: period, watch: watch)
            }
            .accessibilityHint("全部电视的观看时长，不含家长手机播放，按 \(watch.timezone) 统计")
    }
    @ViewBuilder private var metrics: some View {
        metric("今日观看", value: watch.todayPlayedMs, period: .today)
        metric("近一周观看", value: watch.recentWeekPlayedMs, period: .recentWeek)
    }
    private func metric(_ title: String, value: Int64, period: WatchReportPeriod) -> some View {
        Button { selectedPeriod = period } label: {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text(title)
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
            }.font(.caption).foregroundStyle(.secondary)
            Text(WatchStatistics.duration(value)).font(.system(.title3, design: .rounded, weight: .semibold)).monospacedDigit()
                .fixedSize(horizontal: true, vertical: false)
        }.frame(maxWidth: .infinity, minHeight: 52, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityHint("打开观看记录")
    }
    private func color(_ level: Int) -> Color {
        level == 0 ? Color.primary.opacity(0.07) : Palette.yellow.opacity([0, 0.35, 0.55, 0.8, 1][level])
    }
}

private struct WatchDayDot: View {
    let color: Color
    let isToday: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        ZStack {
            if isToday {
                if !reduceMotion && scenePhase == .active {
                    Circle().fill(Palette.yellow).frame(width: 20, height: 20).blur(radius: 5)
                        .phaseAnimator([false, true]) { content, expanded in
                            content.scaleEffect(expanded ? 1.25 : 0.85).opacity(expanded ? 0.8 : 0.3)
                        } animation: { _ in .easeInOut(duration: 1.6) }
                } else {
                    Circle().fill(Palette.yellow.opacity(0.45)).frame(width: 20, height: 20).blur(radius: 5)
                }
            }
            Circle().fill(color).frame(width: 13, height: 13)
        }.frame(maxWidth: .infinity)
    }
}
