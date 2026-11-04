import SwiftUI
import MollyCore

struct WatchHistorySheet: View {
    let period: WatchReportPeriod
    let watch: WatchStatistics
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var report: WatchReport?
    @State private var failure: String?
    @State private var loading = false
    @State private var sessionPage = 1
    @State private var contentPage = 1
    private var requestID: String { "\(sessionPage)-\(contentPage)" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let report {
                        VStack(alignment: .leading, spacing: 24) {
                            Text(dateRange).font(.subheadline).foregroundStyle(.secondary)
                            ViewThatFits(in: .horizontal) {
                                HStack(alignment: .top, spacing: 24) { metrics(report) }
                                VStack(alignment: .leading, spacing: 16) { metrics(report) }
                            }
                            chart(report)
                            if report.totalPlayedMs == 0 {
                                Text("这段时间还没有观看记录，好时光留给下一次。")
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                        }.padding(20).background(Palette.paper, in: RoundedRectangle(cornerRadius: 26))
                        if !report.devices.isEmpty {
                            VStack(alignment: .leading, spacing: 16) {
                                Text("在哪台电视看").font(.headline)
                                ForEach(Array(report.devices.enumerated()), id: \.offset) { _, device in
                                    HStack(alignment: .top, spacing: 12) {
                                        Image(systemName: "tv").foregroundStyle(.secondary)
                                        Text(device.name).frame(maxWidth: .infinity, alignment: .leading)
                                        Text(WatchStatistics.duration(report.duration(for: device))).monospacedDigit()
                                    }.font(.subheadline)
                                }
                            }.padding(20).background(Palette.paper, in: RoundedRectangle(cornerRadius: 26))
                        }
                        VStack(spacing: 0) {
                            DisclosureGroup {
                                VStack(alignment: .leading, spacing: 18) {
                                    if report.sessions.isEmpty { Text("还没有播放明细").foregroundStyle(.secondary) }
                                    ForEach(report.sessions) { session in
                                        VStack(alignment: .leading, spacing: 8) {
                                            HStack(alignment: .top, spacing: 12) {
                                                Text(session.name).font(.subheadline.weight(.semibold))
                                                Spacer(minLength: 0)
                                                Text(WatchStatistics.duration(session.playedMs)).font(.caption).fixedSize()
                                            }
                                            Text("\(session.deviceName) · \(localTime(session.startedAt, timezone: report.timezone))")
                                                .font(.caption).foregroundStyle(.secondary)
                                            Text(session.ended ? "已结束" : "播放中或未正常结束").font(.caption2).foregroundStyle(.secondary)
                                        }
                                    }
                                    pagination(page: $sessionPage, total: report.sessionTotal, size: report.pageSize)
                                }.padding(.top, 20)
                            } label: { disclosureTitle("播放明细", total: report.sessionTotal) }.padding(20)
                            Divider().padding(.horizontal, 20)
                            DisclosureGroup {
                                VStack(alignment: .leading, spacing: 18) {
                                    if report.contents.isEmpty { Text("还没有内容记录").foregroundStyle(.secondary) }
                                    ForEach(report.contents) { content in
                                        VStack(alignment: .leading, spacing: 8) {
                                            HStack(alignment: .top) {
                                                Text(content.name).font(.subheadline)
                                                Spacer(minLength: 12)
                                                Text(WatchStatistics.duration(content.playedMs)).font(.caption).fixedSize()
                                            }
                                            GeometryReader { geometry in
                                                Capsule().fill(Palette.input)
                                                    .overlay(alignment: .leading) {
                                                        Capsule().fill(Palette.yellow).frame(width: geometry.size.width * min(1, Double(content.playedMs) / Double(max(1, report.totalPlayedMs))))
                                                    }
                                            }.frame(height: 5).accessibilityHidden(true)
                                        }
                                    }
                                    pagination(page: $contentPage, total: report.contentTotal, size: report.pageSize)
                                }.padding(.top, 20)
                            } label: { disclosureTitle("内容分布", total: report.contentTotal) }.padding(20)
                        }.background(Palette.paper, in: RoundedRectangle(cornerRadius: 26))
                        VStack(alignment: .leading, spacing: 6) {
                            if let sync = report.lastSync {
                                Text("最后同步 \(localTime(sync, timezone: report.timezone))")
                            }
                            Text("仅统计电视观看 · \(report.timezone)")
                        }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 4)
                    }
                    if loading { ProgressView(report == nil ? "正在读取观看记录…" : "正在更新…").frame(maxWidth: .infinity).padding() }
                    if let failure { InlineFailure(message: failure, retry: { Task { await load() } }) }
                }.padding(20).frame(maxWidth: 600)
            }.frame(maxWidth: .infinity).background(Palette.canvas)
                .navigationTitle(period.title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("关闭观看记录")
                } }
                .task(id: requestID) { await load() }
        }
        .presentationDetents([.fraction(0.85), .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(32)
    }

    private var dateRange: String {
        guard let dates = period.dates(for: watch) else { return "" }
        return dates.start == dates.end ? dates.start : "\(dates.start) 至 \(dates.end)"
    }
    @ViewBuilder private func metrics(_ report: WatchReport) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("观看时长").font(.caption).foregroundStyle(.secondary)
            Text(WatchStatistics.duration(report.totalPlayedMs)).font(.system(.title2, design: .rounded, weight: .bold)).fixedSize()
        }.frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 8) {
            Text("观看视频").font(.caption).foregroundStyle(.secondary)
            Text("\(report.episodeCount) 个").font(.system(.title2, design: .rounded, weight: .bold))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func chart(_ report: WatchReport) -> some View {
        let values = period == .today ? report.hours.map(\.playedMs) : report.days.map(\.playedMs)
        let peak = max(1, values.max() ?? 1)
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(period == .today ? "今天的观看时段" : "近 7 天的观看时光")
                Spacer()
                Text("最高 \(WatchStatistics.duration(peak == 1 ? 0 : peak))")
            }.font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .bottom, spacing: 0) {
                ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(value > 0 ? Palette.yellow : Palette.input)
                        .frame(width: 8, height: value > 0 ? max(5, 108 * Double(value) / Double(peak)) : 3)
                        .frame(maxWidth: .infinity, alignment: .bottom)
                        .accessibilityLabel(period == .today ? "\(report.hours[index].hour) 点" : report.days[index].date)
                        .accessibilityValue(WatchStatistics.duration(value))
                }
            }.frame(height: 112, alignment: .bottom)
            HStack {
                if period == .today {
                    ForEach(["0 点", "6 点", "12 点", "18 点", "23 点"], id: \.self) { label in
                        Text(label)
                        if label != "23 点" { Spacer(minLength: 0) }
                    }
                } else {
                    ForEach(report.days, id: \.date) { day in
                        Text(String(day.date.suffix(5)).replacingOccurrences(of: "-", with: "/"))
                            .frame(maxWidth: .infinity)
                    }
                }
            }.font(.caption2).foregroundStyle(.secondary).accessibilityHidden(true)
        }
    }
    private func disclosureTitle(_ title: String, total: Int) -> some View {
        HStack { Text(title).font(.headline); Spacer(); Text("\(total)").font(.caption).foregroundStyle(.secondary) }.frame(minHeight: 28)
    }
    @ViewBuilder private func pagination(page: Binding<Int>, total: Int, size: Int) -> some View {
        if total > size {
            HStack {
                Button("上一页") { page.wrappedValue -= 1 }.disabled(loading || page.wrappedValue <= 1)
                Spacer()
                Text("\(page.wrappedValue) / \((total + size - 1) / size)").foregroundStyle(.secondary)
                Spacer()
                Button("下一页") { page.wrappedValue += 1 }.disabled(loading || page.wrappedValue * size >= total)
            }.font(.subheadline).frame(minHeight: 44)
        }
    }
    private func localTime(_ input: String, timezone: String) -> String {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: input) ?? ISO8601DateFormatter().date(from: input)
        guard let date else { return "—" }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = TimeZone(identifier: timezone); formatter.dateFormat = "MM/dd HH:mm"
        return formatter.string(from: date)
    }
    private func load() async {
        guard let dates = period.dates(for: watch) else { failure = "暂时无法确定统计日期，请返回刷新后重试。"; return }
        loading = true; failure = nil
        defer { loading = false }
        do {
            let result: WatchReport = try await store.api.request("/api/manage/reports/watch-time", query: [
                URLQueryItem(name: "start", value: dates.start), URLQueryItem(name: "end", value: dates.end),
                URLQueryItem(name: "sessionPage", value: "\(sessionPage)"), URLQueryItem(name: "contentPage", value: "\(contentPage)"),
                URLQueryItem(name: "pageSize", value: "10")])
            guard !Task.isCancelled else { return }
            report = result
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
}
