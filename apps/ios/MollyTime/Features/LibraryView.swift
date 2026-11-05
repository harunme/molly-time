import SwiftUI
import MollyCore

struct LibraryView: View {
    var folder: Resource? = nil
    @Environment(SessionStore.self) private var store
    @State private var items: [Resource] = []
    @State private var total = 0
    @State private var page = 0
    @State private var loading = false
    @State private var failure: String?
    @State private var creating = false
    @State private var newName = ""
    @State private var saving = false
    @State private var uploading = false
    @State private var pairing = false
    @State private var generation = UUID()

    private var isEmptyLibrary: Bool { page > 0 && items.isEmpty }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if folder == nil {
                    if store.canManage && page > 0 && !items.isEmpty {
                        Button { openUpload() } label: {
                            HStack {
                                Label("添加视频", systemImage: "plus")
                                Spacer()
                                Text("相册或文件").font(.subheadline).foregroundStyle(.black.opacity(0.6))
                                Image(systemName: "arrow.up.right")
                            }.padding(.horizontal, 18)
                        }.buttonStyle(PrimaryButtonStyle())
                    }
                }
                if store.upload.selectedURL != nil && (!store.upload.completed || store.upload.failure != nil) {
                    Button { uploading = true } label: { UploadStatusRow(model: store.upload) }.buttonStyle(.plain)
                }
                if page == 0 && failure == nil {
                    LibraryLoadingPlaceholder(featured: folder == nil, showsAddButton: folder == nil && store.canManage)
                }
                if !items.isEmpty {
                    HStack {
                        Text(folder == nil ? "\(total) 个合集" : "合集里的视频").font(.headline)
                        Spacer()
                        if folder != nil { Text("\(total) 项").font(.caption).foregroundStyle(.secondary) }
                        if folder == nil && store.canManage {
                            Menu {
                                Button("新建合集", systemImage: "folder.badge.plus") { creating = true }
                            } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                                .accessibilityLabel("管理合集")
                        }
                    }
                    if folder == nil, let first = items.first {
                        NavigationLink(value: first) { FeaturedCollection(resource: first) }.buttonStyle(.plain)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)], spacing: 22) {
                        ForEach(folder == nil ? Array(items.dropFirst()) : items) { resource in
                            NavigationLink(value: resource) { ResourceCard(resource: resource) }.buttonStyle(.plain)
                        }
                    }
                }
                if let failure { InlineFailure(message: failure, retry: { Task { await load(reset: page == 0) } }) }
                if isEmptyLibrary {
                    VStack(alignment: .leading, spacing: 24) {
                        FirstStepsHeader(icon: "play.rectangle", title: folder == nil ? "从一段喜欢的视频开始" : "把喜欢的视频放进来",
                            detail: store.canManage ? "从相册或文件添加，手机随时看。\n选好适合孩子的内容，再交给电视。" : "片库准备好后，就能在这里一起看。")
                        if store.canManage {
                            Button { openUpload() } label: {
                                Label("添加视频", systemImage: "plus")
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
                if items.count < total {
                    Button("加载更多") { Task { await load(reset: false) } }.disabled(loading).frame(maxWidth: .infinity).padding()
                }

            }.padding(.horizontal, 20).padding(.top, folder == nil ? 0 : 16).padding(.bottom, 24).frame(maxWidth: 700)
        }
        .frame(maxWidth: .infinity).background(Palette.canvas)
        .safeAreaInset(edge: .top, spacing: 0) {
            if folder == nil {
                RootPageHeader(title: "一起看点好内容。", subtitle: "你来挑选，孩子慢慢发现。")
                    .modifier(RootPageHeaderLayout())
            }
        }
        .navigationTitle(folder?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .toolbar(folder == nil ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            if folder != nil && store.canManage {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("添加视频", systemImage: "plus") { openUpload() }
                        Button("新建合集", systemImage: "folder.badge.plus") { creating = true }
                    } label: { Image(systemName: "plus") }.accessibilityLabel("添加内容")
                }
            }
        }
        .task { if page == 0 { await load(reset: true) } }
        .refreshable { await load(reset: true) }
        .sheet(isPresented: $pairing) { PairingView() }
        .onChange(of: store.upload.completed) { _, ready in if ready { Task { await load(reset: true) } } }
        .sheet(isPresented: $uploading, onDismiss: { Task { await load(reset: true) } }) {
            UploadView(folder: folder)
        }
        .sheet(isPresented: $creating) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: "folder.badge.plus").font(.system(size: 44)).foregroundStyle(Palette.yellow)
                    Text("给喜欢的内容一个家").font(.title2.bold())
                    Text("创建于：\(folder?.name ?? "片库")").font(.subheadline).foregroundStyle(.secondary)
                    Text("合集名称").font(.headline)
                    TextField("例如：第一季、睡前故事", text: $newName).textFieldStyle(MollyInputStyle())
                    if let failure { Text(failure).foregroundStyle(.red) }
                    Text("按主题整理视频，例如「睡前故事」或「一起看自然」。").font(.footnote).foregroundStyle(.secondary)
                    }.padding(24)
                }.background(Palette.canvas).navigationTitle("新建合集").navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("取消") { creating = false }.disabled(saving) }
                        ToolbarItem(placement: .confirmationAction) { Button("创建") { Task { await createFolder() } }
                            .disabled(saving || newName.trimmingCharacters(in: .whitespaces).isEmpty) }
                    }
            }.presentationDetents([.large]).interactiveDismissDisabled(saving)
        }
    }
    private func openUpload() {
        if store.upload.completed && !store.upload.busy && store.upload.failure == nil {
            store.upload = UploadModel()
        }
        uploading = true
    }
    private func load(reset: Bool) async {
        if !reset && loading { return }
        let requestID = UUID(); generation = requestID
        let next = reset ? 1 : page + 1
        loading = true; failure = nil
        defer { if generation == requestID { loading = false } }
        do {
            var params = [URLQueryItem(name: "page", value: "\(next)"), URLQueryItem(name: "pageSize", value: "30")]
            if let folder { params.append(URLQueryItem(name: "parentId", value: folder.id)) }
            let result: Page<Resource> = try await store.api.request("/api/manage/resources", query: params)
            guard generation == requestID, !Task.isCancelled else { return }
            items = reset ? result.items : items + result.items.filter { value in !items.contains(where: { $0.id == value.id }) }
            page = next; total = result.total
        } catch {
            guard generation == requestID, !Task.isCancelled else { return }
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
            newName = ""; creating = false; await load(reset: true)
        } catch { failure = error.localizedDescription }
    }
}

struct FeaturedCollection: View {
    let resource: Resource
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Artwork(resource: resource).aspectRatio(16 / 9, contentMode: .fit)
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(resource.name).font(.system(.title2, design: .rounded, weight: .bold))
                    Text("打开合集，挑一部一起看。").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").font(.title2)
                    .frame(width: 44, height: 44).background(Palette.canvas, in: Circle())
            }.padding(20)
        }.background(Palette.paper).clipShape(RoundedRectangle(cornerRadius: 26))
            .accessibilityElement(children: .combine)
    }
}

struct ResourceCard: View {
    let resource: Resource
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Artwork(resource: resource).aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .overlay(alignment: .topTrailing) {
                    Image(systemName: resource.isFolder ? "rectangle.stack.fill" : "play.fill")
                        .font(.caption).padding(9).foregroundStyle(.white).background(.black.opacity(0.3), in: Circle()).padding(10)
                }
            Text(resource.name).font(.system(.headline, design: .rounded))
                .lineLimit(2, reservesSpace: true).multilineTextAlignment(.leading)
            if !resource.isFolder {
                HStack(spacing: 5) {
                    Image(systemName: "play.circle").font(.caption2).accessibilityHidden(true)
                    Text("\(DisplayFormat.duration(resource.runtimeMs)) · \(resource.statusLabel)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }.accessibilityElement(children: .combine)
    }
}

struct VideoDetailView: View {
    let resource: Resource
    @Environment(SessionStore.self) private var store
    @State private var detail: Resource?
    @State private var playing = false
    @State private var publishing = false
    @State private var busy = false
    @State private var failure: String?
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
        }.frame(maxWidth: .infinity).background(Palette.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .task { await refresh() }.refreshable { await refresh() }
            .fullScreenCover(isPresented: $playing) { PlayerView(resource: item) }
            .alert(item.status == "published" ? "改为仅家长可看？" : "允许孩子观看？", isPresented: $publishing) {
                Button("取消", role: .cancel) {}
                Button(item.status == "published" ? "仅家长可看" : "允许观看") { Task { await publish() } }
            } message: {
                Text(item.status == "published"
                     ? "「\(item.name)」将从孩子的电视片库中隐藏，你仍可在手机上观看。"
                     : "孩子可在已绑定的电视上观看「\(item.name)」。所在合集也需要允许孩子观看。")
            }
    }
    private func refresh() async {
        do { detail = try await store.api.request("/api/manage/resources/\(resource.id)"); failure = nil }
        catch { failure = error.localizedDescription }
    }
    private func publish() async {
        busy = true; defer { busy = false }
        do { detail = try await store.api.send("/api/manage/resources/\(resource.id)/\(item.status == "published" ? "unpublish" : "publish")", body: [String: String]()) }
        catch { failure = error.localizedDescription }
    }
}
