import SwiftUI
import MollyCore

struct LibraryView: View {
    var folder: Resource? = nil
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var items: [Resource] = []
    @State private var total = 0
    @State private var hasNextPage = false
    @State private var page = 0
    @State private var loading = false
    @State private var failure: String?
    @State private var creating = false
    @State private var newName = ""
    @State private var saving = false
    @State private var uploading = false
    @State private var pairing = false
    @State private var generation = UUID()
    @State private var managing: Resource?
    @State private var reordering = false
    @State private var editingSession = ResourceGridEditingSession()
    @State private var opening: Resource?
    @State private var drag = ResourceDragSession()
    @State private var dragScope = UUID()
    @State private var orderSaving = false
    @State private var orderReloadNeeded = false
    @State private var orderFailure = false
    @State private var deferredReload = false
    @State private var updatedFolder: Resource?
    private var currentFolder: Resource? { updatedFolder ?? folder }

    private var canReorder: Bool { store.canManage && items.count > 1 && !loading && !orderSaving && !orderReloadNeeded }
    private var editingState: ResourceGridEditingSession.State {
        .init(editing: reordering, motionAllowed: !reduceMotion && scenePhase == .active, draggedID: drag.itemID)
    }
    private var displayedItems: [Resource] {
        guard drag.itemID != nil else { return items }
        let byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        return drag.orderedIDs.compactMap { byID[$0] }
    }
    private var isEmptyLibrary: Bool { page > 0 && items.isEmpty }

    var body: some View {
        GeometryReader { viewport in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: LibraryGridLayout.sectionSpacing) {
                    if folder == nil {
                        HStack {
                            Text("资料库").font(.largeTitle.bold())
                            Spacer()
                            if store.canManage {
                                Menu {
                                    Button("添加内容", systemImage: "plus") { openUpload() }
                                    Button("新建合集", systemImage: "folder.badge.plus") { creating = true }
                                } label: {
                                    Image(systemName: "plus").font(.title3.weight(.medium))
                                        .frame(width: 44, height: 44)
                                }.accessibilityLabel("添加内容")
                                    .opacity(reordering ? 0 : 1).allowsHitTesting(!reordering).accessibilityHidden(reordering)
                            }
                        }.padding(.top, 16)
                    }
                    if store.upload.selectedURL != nil && (!store.upload.completed || store.upload.failure != nil) {
                        Button { uploading = true } label: { UploadStatusRow(model: store.upload) }.buttonStyle(.plain)
                    }
                    if page == 0 && failure == nil {
                        LibraryLoadingPlaceholder()
                    }
                    if !items.isEmpty {
                        HStack {
                            Text(folder == nil ? "\(total) 个合集" : "合集内容").font(.subheadline).foregroundStyle(.secondary)
                            Spacer()
                            if folder != nil { Text("\(total) 项").font(.caption).foregroundStyle(.secondary) }
                        }
                        LazyVGrid(columns: LibraryGridLayout.columns, spacing: LibraryGridLayout.rowSpacing) {
                            ForEach(displayedItems) { resource in
                                DraggableResourceCard(resource: resource, store: store, scope: dragScope, enabled: canReorder,
                                    editingSession: editingSession,
                                    open: { if !reordering { opening = resource } },
                                    manage: { managing = resource },
                                    enterEditing: beginReordering,
                                    begin: { beginDrag(resource) }, hover: { hover(over: resource) }, finish: finishDrag)
                                    .opacity(drag.itemID == resource.id ? 0.35 : 1)
                                    .accessibilityElement(children: .ignore)
                                    .accessibilityLabel(resource.name)
                                    .accessibilityAddTraits(.isButton)
                                    .accessibilityHint(reordering ? "拖动调整顺序" : store.canManage ? "轻点打开，长按显示操作" : "轻点打开")
                                    .accessibilityAction { if !reordering { opening = resource } }
                                    .accessibilityActions {
                                        if store.canManage {
                                            if reordering {
                                                Button("上移") { moveOne(resource, by: -1) }
                                                Button("下移") { moveOne(resource, by: 1) }
                                            } else {
                                                Button("编辑排列", action: beginReordering)
                                                Button(resource.isFolder ? "合集设置" : "视频设置") { managing = resource }
                                            }
                                        }
                                    }
                            }
                        }
                        .background(ResourceDropBackground(scope: dragScope, enabled: reordering && canReorder,
                            onBlankTap: reordering && drag.itemID == nil ? finishReordering : nil))
                    }
                    if let failure { InlineFailure(message: failure, retry: { Task { await load(reset: true, force: true) } }) }
                    if isEmptyLibrary {
                        VStack(alignment: .leading, spacing: 24) {
                            FirstStepsHeader(icon: "rectangle.stack", title: folder == nil ? "从喜欢的内容开始" : "把喜欢的视频放进来",
                                detail: store.canManage ? "从相册或文件添加，随时在手机查看。\n选好适合孩子的内容，再交给电视。" : "资料库准备好后，就能在这里一起看。")
                            if store.canManage {
                                Button { openUpload() } label: {
                                    Label("添加内容", systemImage: "plus")
                                }.buttonStyle(PrimaryButtonStyle())
                                Button { creating = true } label: {
                                    HStack {
                                        Label("先建一个合集", systemImage: "folder.badge.plus")
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                                    }.font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                        }.padding(24).background(Palette.paper, in: RoundedRectangle(cornerRadius: 28))
                        if folder == nil && store.canManage {
                            Button { pairing = true } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: "tv").font(.title3).frame(width: 28)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("想在大屏上看？").font(.subheadline.weight(.semibold))
                                        Text("连接电视，选好的内容一起看").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                }.padding(.horizontal, 8).padding(.vertical, 8).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityLabel("连接电视，选好的内容一起看")
                        }
                    }
                    if hasNextPage && failure == nil && !reordering && !orderSaving {
                        ProgressView().tint(Palette.ink)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .accessibilityLabel("正在加载更多内容")
                            .task(id: page) { await load(reset: false) }
                    }

                }.padding(.horizontal, 20).padding(.top, folder == nil ? 0 : 8).padding(.bottom, 24).frame(maxWidth: 700)
                    .frame(maxWidth: .infinity, minHeight: viewport.size.height, alignment: .top)
                    .background {
                        // A background gesture only receives empty-space taps. It
                        // stays inside the scroll content so pans still scroll, and
                        // cards/buttons above it retain their own touch handling.
                        if reordering {
                            Color.clear.contentShape(Rectangle())
                                .onTapGesture { finishReordering() }
                                .allowsHitTesting(drag.itemID == nil)
                                .accessibilityHidden(true)
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity).mollyPageBackground()
        .navigationTitle(currentFolder?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .toolbar(folder == nil ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            if folder != nil && store.canManage {
                if #available(iOS 26.0, *) {
                    folderToolbar.sharedBackgroundVisibility(reordering ? .hidden : .automatic)
                } else {
                    folderToolbar
                }
            }
        }
        .task(id: store.libraryRevision) {
            if reordering || orderSaving { deferredReload = true }
            else { await load(reset: true, preserveLoadedPages: true) }
        }
        .overlay(alignment: .topTrailing) {
            if reordering && folder == nil {
                reorderDone.padding(.trailing, 20).padding(.top, 16)
            }
        }
        .navigationDestination(item: $opening) { resource in
            if resource.isFolder { LibraryView(folder: resource) }
            else { VideoDetailView(resource: resource) }
        }
        .alert("未能确认排序", isPresented: $orderFailure) {
            Button("知道了", role: .cancel) {}
        } message: {
            Text(orderReloadNeeded ? "网络暂时不可用，请稍后重新读取资料库再调整。" : "已重新读取资料库的实际顺序，请检查后再试。")
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { finishDrag(false) } }
        .onChange(of: editingState, initial: true) { _, state in editingSession.update(state) }
        .onDisappear { finishDrag(false); reordering = false; editingSession.stop() }
        .sheet(item: $managing) { ResourceActionsView(item: $0) }
        .refreshable { if !reordering && !orderSaving { await load(reset: true, preserveLoadedPages: true, force: true) } }
        .sheet(isPresented: $pairing) { PairingView() }
        .sheet(isPresented: $uploading) {
            UploadView(folder: folder)
        }
        .sheet(isPresented: $creating) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: "folder.badge.plus").font(.system(size: 44)).foregroundStyle(Palette.yellow)
                    Text("给喜欢的内容一个家").font(.title2.bold())
                    Text("创建于：\(folder?.name ?? "资料库")").font(.subheadline).foregroundStyle(.secondary)
                    Text("合集名称").font(.headline)
                    TextField("例如：第一季、睡前故事", text: $newName).textFieldStyle(MollyInputStyle())
                    if let failure { Text(failure).foregroundStyle(.red) }
                    Text("按主题整理内容，例如「睡前故事」或「一起看自然」。").font(.footnote).foregroundStyle(.secondary)
                    }.padding(24)
                }.mollyPageBackground().navigationTitle("新建合集").navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("取消") { creating = false }.disabled(saving) }
                        ToolbarItem(placement: .confirmationAction) { Button("创建") { Task { await createFolder() } }
                            .disabled(saving || newName.trimmingCharacters(in: .whitespaces).isEmpty) }
                    }
            }.presentationDetents([.large]).interactiveDismissDisabled(saving)
        }
    }
    // The same Done button is used by the root overlay and the folder toolbar.
    // iOS 26 adds a second glass capsule to toolbar items unless hidden above.
    private var folderToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if reordering {
                reorderDone
            } else {
                Menu {
                    Button("添加内容", systemImage: "plus") { openUpload() }
                    Button("新建合集", systemImage: "folder.badge.plus") { creating = true }
                    if let currentFolder {
                        Button("整理这个合集", systemImage: "folder.badge.gearshape") { managing = currentFolder }
                    }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 44, height: 44)
                }.accessibilityLabel("合集操作")
            }
        }
    }
    private var reorderDone: some View {
        Button { finishReordering() } label: {
            HStack(spacing: 6) {
                Image(systemName: "checkmark").imageScale(.medium).accessibilityHidden(true)
                Text("完成").fixedSize()
            }
                .font(.headline).foregroundStyle(Palette.startup)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .frame(minHeight: 44)
                .background(Palette.yellow, in: Capsule())
        }
            .buttonStyle(.plain)
            .accessibilityLabel("完成")
            .accessibilityHint("退出整理，保留当前排列")
            .disabled(drag.itemID != nil)
            .opacity(drag.itemID == nil ? 1 : 0.55)
    }
    private func beginReordering() {
        guard canReorder else { return }
        reordering = true
        editingSession.update(editingState)
    }
    private func beginDrag(_ resource: Resource) {
        guard reordering, canReorder, drag.begin(itemID: resource.id, ids: items.map(\.id)) else { return }
        reordering = true
    }
    private func hover(over resource: Resource) {
        guard reordering, canReorder else { return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { drag.hover(over: resource.id) }
    }
    private func finishDrag(_ accepted: Bool) {
        guard drag.itemID != nil else { return }
        let byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        var transaction = Transaction(animation: !accepted && !reduceMotion ? .easeInOut(duration: 0.2) : nil)
        transaction.disablesAnimations = accepted || reduceMotion
        let result: ResourceDragSession.Result? = withTransaction(transaction) {
            // Promote the visible order BEFORE clearing the preview. Otherwise
            // SwiftUI briefly sees the old items and animates the same move again.
            if accepted { items = displayedItems }
            let result = drag.finish(commit: accepted)
            if !accepted, let result { items = result.ids.compactMap { byID[$0] } }
            return result
        }
        guard let change = result?.change else { return }
        orderSaving = true; failure = nil
        let client = store.api, account = store.sessionGeneration
        Task {
            defer {
                orderSaving = false
                if !reordering { finishReordering() }
            }
            do {
                let _: OK = try await client.send("/api/manage/resources/\(change.itemID)/position", method: "PUT", body: change.body)
            } catch {
                guard account == store.sessionGeneration else { return }
                orderReloadNeeded = true
                await load(reset: true, preserveLoadedPages: true, force: true)
                failure = "未能确认保存结果，请检查当前顺序后重试。\n\(error.localizedDescription)"
                orderFailure = true
            }
        }
    }
    private func finishReordering() {
        guard drag.itemID == nil else { return }
        reordering = false
        editingSession.stop()
        if deferredReload && !orderSaving {
            deferredReload = false
            Task { await load(reset: true, preserveLoadedPages: true) }
        }
    }
    private func moveOne(_ resource: Resource, by delta: Int) {
        guard reordering, canReorder, let index = items.firstIndex(where: { $0.id == resource.id }), items.indices.contains(index + delta) else { return }
        let target = items[index + delta]
        beginDrag(resource); hover(over: target); finishDrag(true)
    }
    private func openUpload() {
        if store.upload.completed && !store.upload.busy && store.upload.failure == nil {
            store.resetLibraryUpload()
        }
        uploading = true
    }
    private func apply(_ snapshot: LibrarySnapshot) {
        items = snapshot.items; total = snapshot.total
        page = snapshot.page; hasNextPage = snapshot.hasNextPage
        updatedFolder = snapshot.folder
    }
    private func load(reset: Bool, preserveLoadedPages: Bool = false, force: Bool = false) async {
        guard drag.itemID == nil else { deferredReload = true; return }
        if !reset && (loading || reordering || orderSaving || !hasNextPage) { return }
        if reset, page == 0, let cached = store.library.cached(folderID: folder?.id) { apply(cached) }
        let requestID = UUID(); generation = requestID
        let account = store.sessionGeneration
        let target = reset ? (preserveLoadedPages ? max(1, page) : 1) : page + 1
        loading = true; failure = nil
        defer { if generation == requestID { loading = false } }
        do {
            let snapshot = try await store.loadLibrary(folderID: folder?.id, throughPage: target, force: force)
            guard generation == requestID, account == store.sessionGeneration, !Task.isCancelled else { return }
            apply(snapshot); orderReloadNeeded = false
        } catch {
            guard generation == requestID, account == store.sessionGeneration, !Task.isCancelled,
                  !(error is CancellationError) else { return }
            if folder != nil, case APIError.http(404, _) = error {
                items = []; page = 0; dismiss(); return
            }
            failure = error.localizedDescription
        }
    }
    private func createFolder() async {
        saving = true; failure = nil
        defer { saving = false }
        do {
            var body = ["name": newName.trimmingCharacters(in: .whitespaces), "type": "Series"]
            if let folder { body["parentId"] = folder.id }
            let _: Resource = try await store.api.send("/api/manage/resources", body: body)
            newName = ""; creating = false
        } catch { failure = error.localizedDescription }
    }
}

struct ResourceCard: View {
    let resource: Resource
    var body: some View {
        VStack(spacing: LibraryGridLayout.captionSpacing) {
            Artwork(resource: resource, compact: true).aspectRatio(LibraryGridLayout.coverAspectRatio, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: LibraryGridLayout.coverCornerRadius, style: .continuous))
            VStack(spacing: 4) {
                Text(resource.name).font(.subheadline.weight(.medium))
                    .lineLimit(2).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
                if !resource.isFolder {
                    Text("\(DisplayFormat.duration(resource.runtimeMs)) · \(resource.statusLabel)")
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }.accessibilityElement(children: .combine)
    }
}

struct VideoDetailView: View {
    let resource: Resource
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var detail: Resource?
    @State private var playing = false
    @State private var publishing = false
    @State private var busy = false
    @State private var failure: String?
    @State private var managing: Resource?
    var item: Resource { detail ?? resource }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Artwork(resource: item).aspectRatio(16 / 10, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 28))
                VStack(alignment: .leading, spacing: 10) {
                    Text(item.name).font(.system(.largeTitle, design: .rounded, weight: .bold))
                    Text("\(DisplayFormat.duration(item.runtimeMs)) · \(item.statusLabel)").font(.subheadline).foregroundStyle(.secondary)
                }
                Button { playing = true } label: { Label("在手机上播放", systemImage: "play.fill") }
                    .buttonStyle(PrimaryButtonStyle()).disabled(!item.ready)
                if let hidden = item.hiddenByFolder {
                    Label("所在合集「\(hidden.name)」未开放，电视暂时看不到这个视频。", systemImage: "eye.slash")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !item.overview.isEmpty { Text(item.overview).lineSpacing(6).foregroundStyle(.secondary) }
                Label("手机观看进度单独保存，不影响孩子的电视记录。", systemImage: "heart")
                    .font(.footnote).foregroundStyle(.secondary)
                if store.canManage {
                    Button { publishing = true } label: {
                        Label(item.status == "published" ? "改为仅家长可看" : "允许孩子观看",
                              systemImage: item.status == "published" ? "person.crop.circle" : "tv")
                    }
                    .buttonStyle(PrimaryButtonStyle(
                        background: item.status == "published" ? Palette.input : Palette.yellow,
                        foreground: item.status == "published" ? Palette.ink : Color.black.opacity(0.85)
                    ))
                    .disabled(busy || !item.ready)
                }
                if !item.ready { Text("视频还在处理中，完成后即可播放。下拉可以刷新状态。").font(.subheadline).foregroundStyle(.secondary) }
                if let failure { InlineFailure(message: failure) }
            }.padding(20).frame(maxWidth: 700)
        }.frame(maxWidth: .infinity).mollyPageBackground()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .task(id: store.libraryRevision) { await refresh() }.refreshable { await refresh() }
            .toolbar {
                if store.canManage {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { managing = item } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                            .accessibilityLabel("整理视频")
                    }
                }
            }
            .sheet(item: $managing) { ResourceActionsView(item: $0) }
            .fullScreenCover(isPresented: $playing) { PlayerView(resource: item) }
            .alert(item.status == "published" ? "改为仅家长可看？" : "允许孩子观看？", isPresented: $publishing) {
                Button("取消", role: .cancel) {}
                Button(item.status == "published" ? "仅家长可看" : "允许观看") { Task { await publish() } }
            } message: {
                Text(item.status == "published"
                     ? "「\(item.name)」将不再显示在孩子的电视上，你仍可在手机上观看。"
                     : "孩子可在已绑定的电视上观看「\(item.name)」。所在合集也需要允许孩子观看。")
            }
    }
    private func refresh() async {
        do {
            detail = try await store.api.request("/api/manage/resources/\(resource.id)")
            if detail?.status == "archived" { dismiss() }
            failure = nil
        }
        catch { failure = error.localizedDescription }
    }
    private func publish() async {
        busy = true; defer { busy = false }
        do { detail = try await store.api.send("/api/manage/resources/\(resource.id)/\(item.status == "published" ? "unpublish" : "publish")", body: [String: String]()) }
        catch { failure = error.localizedDescription }
    }
}
