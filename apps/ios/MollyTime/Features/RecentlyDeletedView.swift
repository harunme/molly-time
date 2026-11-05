import SwiftUI
import MollyCore

private struct DeletedResource: Decodable, Identifiable {
    let id: String
    let name: String
    let type: String
    let deleteAt: String?
    let deleting: Bool
    let error: String
    let videoCount: Int
}
private struct DeletedPage: Decodable {
    let items: [DeletedResource]
    let total: Int
    let page: Int
    let pageSize: Int
    let retentionDays: Int
}

struct RecentlyDeletedView: View {
    @Environment(SessionStore.self) private var store
    @State private var items: [DeletedResource] = []
    @State private var page = 0
    @State private var total = 0
    @State private var retentionDays = 7
    @State private var loading = false
    @State private var busy: String?
    @State private var failure: String?
    @State private var generation = UUID()
    @State private var deleting: DeletedResource?
    var body: some View {
        MollyList {
            Section {
                if page == 0 && failure == nil { ProgressView("正在读取…") }
                else if items.isEmpty { Text("最近没有删除内容").foregroundStyle(.secondary) }
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 12) {
                        Label(item.name, systemImage: item.type == "Episode" ? "film" : "folder").font(.headline)
                        Text(item.deleting ? "正在彻底删除…" : item.deleteAt.map { "计划于 \($0.prefix(10)) 自动删除" } ?? "保留至手动删除")
                            .font(.caption).foregroundStyle(.secondary)
                        if item.type != "Episode" { Text("包含 \(item.videoCount) 个视频").font(.caption).foregroundStyle(.secondary) }
                        if !item.error.isEmpty { Text(item.error).font(.caption).foregroundStyle(.red) }
                        if store.canManage {
                            HStack {
                                Button("恢复") { Task { await restore(item) } }.buttonStyle(.bordered).frame(minHeight: 44)
                                Spacer()
                                Button("彻底删除", role: .destructive) { deleting = item }.buttonStyle(.borderless).frame(minHeight: 44)
                            }.frame(minHeight: 44).disabled(item.deleting || busy != nil)
                        }
                    }.padding(.vertical, 8)
                }
                if items.count < total { Button("加载更多") { Task { await load(reset: false) } }.disabled(loading) }
            } footer: {
                Text((retentionDays == 0 ? "已删除的内容保留至手动清理。" : "删除后保留 \(retentionDays) 天，到期自动清理。") + "恢复后沿用删除前的观看设置。")
            }
            if let failure { Section { InlineFailure(message: failure, retry: { Task { await load(reset: true) } }) } }
        }
        .navigationTitle("最近删除").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task { await load(reset: true) }.refreshable { await load(reset: true) }
        .alert("彻底删除「\(deleting?.name ?? "")」？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { item in
            Button("取消", role: .cancel) {}
            Button("彻底删除", role: .destructive) { Task { await remove(item) } }
        } message: { _ in Text("内容及其中的文件将永久移除，无法恢复。") }
    }
    private func load(reset: Bool) async {
        guard reset || !loading else { return }
        let request = UUID(); generation = request
        loading = true; failure = nil; defer { if generation == request { loading = false } }
        do {
            let result: DeletedPage = try await store.api.request("/api/manage/trash", query: [.init(name: "page", value: "\(reset ? 1 : page + 1)")])
            try Task.checkCancellation()
            guard generation == request else { return }
            items = reset ? result.items : items + result.items.filter { row in !items.contains(where: { $0.id == row.id }) }
            total = result.total; page = result.page; retentionDays = result.retentionDays
        } catch { if !Task.isCancelled, generation == request { failure = error.localizedDescription } }
    }
    private func restore(_ item: DeletedResource) async {
        guard busy == nil else { return }
        busy = item.id; failure = nil; defer { busy = nil }
        do { try await store.api.command("/api/manage/trash/\(item.id)/restore"); await load(reset: true) }
        catch { failure = error.localizedDescription }
    }
    private func remove(_ item: DeletedResource) async {
        guard busy == nil else { return }
        busy = item.id; failure = nil; defer { busy = nil }
        do {
            let _: OK = try await store.api.request("/api/manage/trash/\(item.id)", method: "DELETE")
            await load(reset: true)
        } catch { failure = error.localizedDescription }
    }
}
