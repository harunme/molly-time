import SwiftUI
import MollyCore

private struct DeletedResource: Decodable, Identifiable {
    let id: String
    let name: String
    let type: String
    let deleteAt: String?
    var deleting: Bool
    var error: String
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var items: [DeletedResource] = []
    @State private var page = 0
    @State private var total = 0
    @State private var retentionDays = 7
    @State private var loading = false
    @State private var busy: Set<String> = []
    @State private var failure: String?
    @State private var generation = UUID()
    @State private var deleting: DeletedResource?
    var body: some View {
        MollyList {
            Section {
                if page == 0 && failure == nil { ProgressView("正在读取…") }
                else if items.isEmpty { Text("最近没有删除内容").foregroundStyle(.secondary) }
                ForEach(items) { item in
                    let job = store.trashDeletions.jobs[item.id]
                    let pending = job?.pending ?? (item.deleting && item.error.isEmpty)
                    let error = job?.error ?? item.error
                    VStack(alignment: .leading, spacing: 12) {
                        Label(item.name, systemImage: item.type == "Episode" ? "film" : "folder").font(.headline)
                        if pending {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.mini)
                                Text("正在删除，可离开此页面")
                            }.font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text(item.deleting ? "删除未完成，可重试" : item.deleteAt.map { "计划于 \($0.prefix(10)) 自动删除" } ?? "保留至手动删除")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if item.type != "Episode" { Text("包含 \(item.videoCount) 个视频").font(.caption).foregroundStyle(.secondary) }
                        if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
                        if store.canManage {
                            HStack {
                                Button("恢复") { Task { await restore(item) } }
                                    .buttonStyle(.bordered).frame(minHeight: 44)
                                    .disabled(item.deleting || job != nil || busy.contains(item.id))
                                Spacer()
                                Button(error.isEmpty ? "彻底删除" : "重试删除", role: .destructive) { deleting = item }
                                    .buttonStyle(.borderless).frame(minHeight: 44)
                                    .disabled(pending || busy.contains(item.id))
                            }.frame(minHeight: 44)
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
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await load(reset: true)
            await store.refreshTrashDeletions()
        }
        .refreshable { await load(reset: true) }
        .onChange(of: store.trashDeletions.settlementRevision) { _, _ in
            Task { await load(reset: true) }
        }
        .alert("彻底删除「\(deleting?.name ?? "")」？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { item in
            Button("取消", role: .cancel) {}
            Button("彻底删除", role: .destructive) { Task { await remove(item) } }
        } message: { _ in Text("内容及其中的文件将永久移除，无法恢复。") }
    }
    private func load(reset: Bool) async {
        guard reset || !loading else { return }
        let request = UUID(); generation = request
        let client = store.api, account = store.sessionGeneration
        let lastPage = reset ? max(page, 1) : page + 1
        loading = true; failure = nil; defer { if generation == request { loading = false } }
        do {
            var collected = reset ? [] : items
            for number in (reset ? 1 : lastPage)...lastPage {
                let result: DeletedPage = try await client.request("/api/manage/trash", query: [.init(name: "page", value: "\(number)")])
                try Task.checkCancellation()
                guard generation == request, account == store.sessionGeneration else { return }
                collected += result.items.filter { row in !collected.contains(where: { $0.id == row.id }) }
                // Keep all loaded pages visible while refreshing after a completed job.
                if number == lastPage || number * result.pageSize >= result.total {
                    items = collected; total = result.total; page = result.page; retentionDays = result.retentionDays
                    break
                }
            }
        } catch { if !Task.isCancelled, generation == request, account == store.sessionGeneration { failure = error.localizedDescription } }
    }
    private func restore(_ item: DeletedResource) async {
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id); failure = nil; defer { busy.remove(item.id) }
        let client = store.api, account = store.sessionGeneration
        do {
            try await client.command("/api/manage/trash/\(item.id)/restore")
            guard account == store.sessionGeneration else { return }
            await load(reset: true)
        } catch { if account == store.sessionGeneration { failure = error.localizedDescription } }
    }
    private func remove(_ item: DeletedResource) async {
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id); failure = nil; defer { busy.remove(item.id) }
        let client = store.api, account = store.sessionGeneration
        do {
            let result: TrashDeletionReceipt = try await client.request("/api/manage/trash/\(item.id)", method: "DELETE")
            guard account == store.sessionGeneration else { return }
            if result.deleting == true {
                store.trashDeletions.track(item.id)
                if let index = items.firstIndex(where: { $0.id == item.id }) {
                    items[index].deleting = true; items[index].error = ""
                }
            } else {
                // Also supports a server running the previous synchronous API.
                items.removeAll { $0.id == item.id }; total = max(items.count, total - 1)
                store.storage.invalidate()
                await store.refreshStorage()
            }
        } catch { if account == store.sessionGeneration { failure = error.localizedDescription } }
    }
}
