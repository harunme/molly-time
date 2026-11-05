import SwiftUI
import PhotosUI
import MollyCore

struct ResourceActionsView: View {
    let item: Resource
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var failure: String?
    @State private var renaming = false
    @State private var name = ""
    @State private var moving = false
    @State private var deleting = false
    @State private var cover: PhotosPickerItem?
    var body: some View {
        NavigationStack {
            MollyList {
                Section {
                    Button { name = item.name; renaming = true } label: { Label("重命名", systemImage: "pencil") }
                    PhotosPicker(selection: $cover, matching: .images) { Label("更换封面", systemImage: "photo") }
                    Button { moving = true } label: { Label("移动到…", systemImage: "folder") }
                }
                Section {
                    if item.status != "published" {
                        Button { Task { await perform("publish") } } label: { Label("允许孩子观看", systemImage: "tv") }
                    }
                    if item.status == "published" {
                        Button { Task { await perform("unpublish") } } label: { Label("仅家长可看", systemImage: "person.crop.circle") }
                    }
                } footer: {
                    if item.isFolder {
                        Text("调整合集只改变整个合集的可见性，里面的视频保留各自的观看设置。")
                    } else if let hidden = item.hiddenByFolder {
                        Text("所在合集「\(hidden.name)」也需允许孩子观看。")
                    }
                }
                Section {
                    Button(role: .destructive) { deleting = true } label: { Label("移到最近删除", systemImage: "trash") }
                }
                if let failure { Section { Text(failure).foregroundStyle(.red) } }
                if busy { Section { ProgressView("正在保存…") } }
            }
            .navigationTitle(item.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() }.disabled(busy) } }
            .disabled(busy || !store.canManage)
            .interactiveDismissDisabled(busy)
            .alert("重命名", isPresented: $renaming) {
                TextField("名称", text: $name)
                Button("取消", role: .cancel) {}
                Button("保存") { Task { await rename() } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .alert("移到最近删除？", isPresented: $deleting) {
                Button("取消", role: .cancel) {}
                Button("移到最近删除", role: .destructive) { Task { await perform("archive") } }
            } message: {
                Text("「\(item.name)」将从资料库移除。" + (item.isFolder ? "合集内的内容会一起移入。" : "") + "可在「我的 → 最近删除」中恢复。")
            }
            .sheet(isPresented: $moving) {
                FolderDestinationView(excluding: [item.id], allowRoot: item.type == "Series") { destination in
                    moving = false
                    await perform("move", destination: destination)
                }
            }
            .task(id: cover) { if let cover { await updateCover(cover, item: item) } }
        }
        .presentationDetents([.medium, .large])
    }
    private func rename() async {
        guard !busy, store.canManage else { return }
        busy = true; failure = nil; defer { busy = false }
        do {
            let _: Resource = try await store.api.send("/api/manage/resources/\(item.id)", method: "PATCH", body: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines)])
            dismiss()
        } catch { failure = error.localizedDescription }
    }
    private func perform(_ action: String, destination: Resource? = nil) async {
        guard !busy, store.canManage else { return }
        busy = true; failure = nil; defer { busy = false }
        let client = store.api, account = store.sessionGeneration
        do {
            if action == "move" {
                // Explicit null means moving a collection to the library root.
                let body = try JSONSerialization.data(withJSONObject: ["folderId": destination?.id as Any? ?? NSNull()])
                let _: Resource = try await client.request("/api/manage/resources/\(item.id)/move", method: "POST", body: body)
            } else {
                let _: Resource = try await client.send("/api/manage/resources/\(item.id)/\(action)", body: [String: String]())
            }
            guard !Task.isCancelled, account == store.sessionGeneration else { return }
            dismiss()
        } catch {
            if !Task.isCancelled, account == store.sessionGeneration { failure = error.localizedDescription }
        }
    }

    private func updateCover(_ photo: PhotosPickerItem, item: Resource) async {
        guard !busy else { return }
        busy = true; failure = nil; defer { busy = false }
        let client = store.api, account = store.sessionGeneration
        do {
            guard let data = try await photo.loadTransferable(type: Data.self), let image = UIImage(data: data) else { throw APIError.http(422, "无法读取图片，请重新选择。") }
            guard !Task.isCancelled, account == store.sessionGeneration else { return }
            let factor = min(1, 1200 / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * factor, height: image.size.height * factor)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = resized.jpegData(compressionQuality: 0.85) else { throw APIError.invalidResponse }
            try await ResourceArtworkUpload.send(jpeg, itemID: item.id, api: client)
            dismiss()
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
}

struct FolderDestinationView: View {
    let excluding: Set<String>
    let allowRoot: Bool
    let selected: (Resource?) async -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            FolderDestinationPage(folder: nil, excluding: excluding, allowRoot: allowRoot, selected: selected)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }
}

private struct FolderDestinationPage: View {
    let folder: Resource?
    let excluding: Set<String>
    let allowRoot: Bool
    let selected: (Resource?) async -> Void
    @Environment(SessionStore.self) private var store
    @State private var folders: [Resource] = []
    @State private var page = 0
    @State private var more = true
    @State private var loading = false
    @State private var failure: String?
    var body: some View {
        MollyList {
            Section {
                ForEach(folders) { child in
                    NavigationLink {
                        FolderDestinationPage(folder: child, excluding: excluding, allowRoot: allowRoot, selected: selected)
                    } label: { Label(child.name, systemImage: "folder") }
                }
                if more { Button(loading ? "正在读取…" : "加载更多合集") { Task { await load() } }.disabled(loading) }
                if !more && folders.isEmpty { Text("没有下级合集").foregroundStyle(.secondary) }
            }
            if let failure { Section { InlineFailure(message: failure, retry: { Task { await load() } }) } }
        }
        .navigationTitle(folder?.name ?? "选择目标合集").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if folder != nil || allowRoot {
                Button(folder == nil ? "移到资料库首页" : "移到这个合集") { Task { await selected(folder) } }
                    .buttonStyle(PrimaryButtonStyle()).padding().background(Palette.canvas)
            }
        }
        .task { if page == 0 { await load() } }
    }
    private func load() async {
        guard !loading else { return }
        loading = true; failure = nil; defer { loading = false }
        do {
            var query = [URLQueryItem(name: "page", value: "\(page + 1)"), .init(name: "pageSize", value: "100"), .init(name: "sort", value: "manual")]
            if let folder { query.append(.init(name: "parentId", value: folder.id)) }
            let result: Page<Resource> = try await store.api.request("/api/manage/resources", query: query)
            try Task.checkCancellation()
            folders += result.items.filter { $0.isFolder && !excluding.contains($0.id) }
            page = result.page; more = result.hasNext
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
}
