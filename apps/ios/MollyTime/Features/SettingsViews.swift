import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import MollyCore

enum SettingsDestination: Hashable { case playback, reminder, parentPIN, viewingInfo, disclaimer, recentlyDeleted }

struct SettingsRow: View {
    let title: String
    let icon: String
    var detail = ""
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 20)).frame(width: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold))
                if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }.fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
        }.foregroundStyle(Palette.ink).padding(20).frame(minHeight: 64).contentShape(Rectangle())
    }
}

private struct SettingsPage<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) { content }
                .padding(24).frame(maxWidth: 600)
        }.frame(maxWidth: .infinity).mollyPageBackground()
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .scrollDismissesKeyboard(.interactively)
    }
}

struct ViewingInfoView: View {
    var body: some View {
        SettingsPage(title: "观看说明") {
            VStack(alignment: .leading, spacing: 24) {
                explanation("手机上，放心挑选", icon: "iphone", text: "家长在手机上播放，不占孩子的观看额度。观看进度也会单独保存。")
                Divider()
                explanation("电视上，按约定观看", icon: "tv", text: "孩子的观看时间和集数，在「电视」里的「调整观看安排」设置。允许孩子观看的视频，才会显示在电视上。")
            }.padding(24).background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
        }
    }
    private func explanation(_ title: String, icon: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: icon).font(.headline)
            Text(text).font(.subheadline).foregroundStyle(.secondary).lineSpacing(4)
        }
    }
}

struct DisclaimerView: View {
    var body: some View {
        SettingsPage(title: "免责条款") {
            Text("使用 MollyTime 前，请了解以下说明。")
                .font(.subheadline).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 24) {
                clause("内容与版权", text: "请仅上传、存储和使用你依法有权使用的视频、图片、字幕等内容，并遵守授权范围。仅供自己或家庭观看，不代表自动获得相关权利；请勿未经授权传播他人作品。")
                Divider()
                clause("家长的选择与陪伴", text: "请由家长判断内容是否适合孩子，并合理安排观看时间。观看额度、休息提醒等功能用于辅助管理，不能替代家长的陪伴和监护。")
                Divider()
                clause("播放与存储", text: "网络、设备、视频格式及存储服务的状态可能影响上传和播放，服务无法保证始终不中断或完全无误。请为重要内容保留独立备份。")
                Divider()
                clause("责任范围", text: "用户与服务提供方应依据适用法律及各自过错承担相应责任。本说明不免除或限制法律规定不得免除或限制的责任，也不影响用户依法享有的权利。")
            }.padding(24).background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
        }
    }
    private func clause(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            Text(text).font(.subheadline).foregroundStyle(.secondary).lineSpacing(5)
        }
    }
}

struct ChangePasswordView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var saved = false
    private enum Field: Hashable { case current, password, confirmation }
    @FocusState private var focus: Field?
    private var validation: String? { SettingsValidation.passwordError(password, confirmation: confirmation) }
    var body: some View {
        SettingsPage(title: "修改登录密码") {
            Text("这是登录账号使用的密码，与电视上的四位家长密码不同。")
                .font(.subheadline).foregroundStyle(.secondary)
            field("当前密码", value: $current, kind: .current)
            field("新密码", value: $password, kind: .password)
            Text("至少 8 个字符，最多 72 字节。支持粘贴或使用密码管理器。")
                .font(.footnote).foregroundStyle(.secondary)
            field("再次输入新密码", value: $confirmation, kind: .confirmation)
            if !confirmation.isEmpty, let validation { Text(validation).font(.footnote).foregroundStyle(.secondary) }
            if let failure { InlineFailure(message: failure) }
            Button(busy ? "正在保存…" : "保存新密码") { Task { await save() } }
                .buttonStyle(PrimaryButtonStyle()).disabled(busy || current.isEmpty || validation != nil)
        }.interactiveDismissDisabled(busy)
            .alert("登录密码已修改", isPresented: $saved) { Button("完成") { dismiss() } }
            .onDisappear { current = ""; password = ""; confirmation = "" }
    }
    private func field(_ label: String, value: Binding<String>, kind: Field) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label).font(.subheadline.weight(.semibold))
            SecureField(label, text: value).textContentType(kind == .current ? .password : .newPassword)
                .textFieldStyle(MollyInputStyle()).focused($focus, equals: kind)
                .submitLabel(kind == .confirmation ? .done : .next).disabled(busy)
                .onSubmit {
                    switch kind {
                    case .current: focus = .password
                    case .password: focus = .confirmation
                    case .confirmation: focus = nil
                    }
                }
        }
    }
    private func save() async {
        guard validation == nil, !current.isEmpty, !busy else { return }
        busy = true; failure = nil; focus = nil
        defer { busy = false }
        do {
            try await store.api.command("/api/manage/password", body: ["currentPassword": current, "newPassword": password])
            current = ""; password = ""; confirmation = ""; saved = true
        } catch { failure = error.localizedDescription }
    }
}

struct ParentPINView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var pin = ""
    @State private var confirmation = ""
    @State private var busy = false
    @State private var saved = false
    @State private var failure: String?
    @FocusState private var focused: Int?
    private var valid: Bool { SettingsValidation.validPIN(pin) && pin == confirmation }
    var body: some View {
        SettingsPage(title: "重设家长密码") {
            Text("设置四位数字密码，用于电视上的家长操作。所有已绑定电视共用，登录密码不会改变。")
                .font(.subheadline).foregroundStyle(.secondary)
            pinField("新的家长密码", text: $pin, index: 0)
            pinField("再次输入", text: $confirmation, index: 1)
            if !confirmation.isEmpty && pin != confirmation {
                Text("两次输入的密码不一致。").font(.footnote).foregroundStyle(.secondary)
            }
            if let failure { InlineFailure(message: failure) }
            Button(busy ? "正在保存…" : "保存家长密码") { Task { await save() } }
                .buttonStyle(PrimaryButtonStyle()).disabled(!valid || busy || !store.canManage)
        }.interactiveDismissDisabled(busy)
            .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("完成") { focused = nil } } }
            .alert("家长密码已更新", isPresented: $saved) { Button("完成") { dismiss() } }
            .onDisappear { pin = ""; confirmation = "" }
    }
    private func pinField(_ title: String, text: Binding<String>, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.subheadline.weight(.semibold))
            SecureField("四位数字", text: text).keyboardType(.numberPad)
                .textFieldStyle(MollyInputStyle()).focused($focused, equals: index).disabled(busy)
                .onChange(of: text.wrappedValue) { _, value in
                    text.wrappedValue = String(value.filter { $0.isASCII && $0.isNumber }.prefix(4))
                }
        }
    }
    private func save() async {
        guard valid, !busy, store.canManage else { return }
        busy = true; failure = nil; focused = nil
        defer { busy = false }
        do {
            let _: OK = try await store.api.send("/api/manage/watch-control/pin", method: "PUT", body: ["pin": pin])
            store.parentPINConfigured = true
            pin = ""; confirmation = ""; saved = true
        } catch { failure = error.localizedDescription }
    }
}

struct PlaybackPreferencesView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var subtitle = "zh"
    @State private var loaded = false
    @State private var busy = false
    @State private var failure: String?
    init(subtitle: String? = nil) {
        _subtitle = State(initialValue: subtitle ?? "zh")
        _loaded = State(initialValue: subtitle != nil)
    }
    private let choices = [("zh", "中文"), ("en", "英文"), ("zh-en", "中英文"), ("off", "关闭字幕")]
    var body: some View {
        SettingsPage(title: "播放偏好") {
            VStack(alignment: .leading, spacing: 8) {
                Text("默认字幕").font(.title3.bold())
                Text("选一种习惯的字幕，手机和电视一起记住。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if loaded {
                VStack(spacing: 0) {
                    ForEach(choices, id: \.0) { value, label in
                        Button { subtitle = value } label: {
                            HStack(spacing: 16) {
                                Text(label).font(.body)
                                Spacer()
                                ZStack {
                                    if subtitle == value {
                                        Circle().fill(Palette.yellow)
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundStyle(Color.black.opacity(0.85))
                                    } else {
                                        Circle().strokeBorder(Color.secondary.opacity(0.3), lineWidth: 1.5)
                                    }
                                }.frame(width: 24, height: 24).accessibilityHidden(true)
                            }.padding(.horizontal, 20).padding(.vertical, 18)
                                .frame(minHeight: 60).contentShape(Rectangle())
                                .foregroundStyle(Palette.ink)
                        }.buttonStyle(.plain).disabled(busy || !store.canManage)
                            .accessibilityAddTraits(subtitle == value ? [.isSelected] : [])
                        if value != "off" { Divider().padding(.horizontal, 20) }
                    }
                }.background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
                Text("下次播放生效。没有匹配的字幕时不显示；中英文需要视频提供双语字幕。")
                    .font(.footnote).foregroundStyle(.secondary)
                if store.canManage {
                    Button(busy ? "正在保存…" : "保存偏好") { Task { await save() } }
                        .buttonStyle(PrimaryButtonStyle()).disabled(busy)
                } else { Text("由家庭管理员调整播放偏好。").font(.footnote).foregroundStyle(.secondary) }
            } else if failure == nil { PlaybackLoadingPlaceholder() }
            if let failure { InlineFailure(message: failure, retry: loaded ? nil : { Task { await load() } }) }
        }.task { await load() }.interactiveDismissDisabled(busy)
    }
    private func load() async {
        guard !loaded else { return }
        failure = nil
        let account = store.sessionGeneration
        if store.storage.settings?.defaultSubtitle == nil { await store.refreshStorage() }
        guard account == store.sessionGeneration, !Task.isCancelled else { return }
        guard let cached = store.storage.settings?.defaultSubtitle else {
            failure = store.storage.failure ?? "暂时无法读取播放偏好，请重试。"
            return
        }
        subtitle = cached; loaded = true
    }
    private func save() async {
        guard store.canManage, !busy else { return }
        busy = true; failure = nil; defer { busy = false }
        do {
            let account = store.sessionGeneration
            let saved: PlaybackPreferences = try await store.api.send("/api/manage/settings", method: "PUT", body: ["defaultSubtitle": subtitle])
            guard account == store.sessionGeneration else { return }
            store.storage.applyPlaybackPreferences(saved)
            dismiss()
        } catch { failure = error.localizedDescription }
    }
}

struct RestReminderView: View {
    @Environment(SessionStore.self) private var store
    @State private var settings: ReminderSettings?
    @State private var failure: String?
    @State private var selecting = false
    @State private var photo: PhotosPickerItem?
    @State private var preparing = false
    @State private var previewing = false
    @State private var cancelling = false
    @State private var kind = "farewell"
    private var clipReady: Bool { (kind == "warning" ? settings?.warning?.ready : settings?.farewell.ready) == true }
    private var builtinClip: Bool { (kind == "warning" ? settings?.warning?.source : settings?.farewell.source) == "builtin" }
    private var model: UploadModel { store.reminderUpload }
    private var locked: Bool { preparing || model.busy || store.upload.busy }
    var body: some View {
        SettingsPage(title: "提醒视频") {
            Picker("播放时机", selection: $kind) {
                Text("最后一集").tag("warning")
                Text("该休息了").tag("farewell")
            }.pickerStyle(.segmented).disabled(locked || (model.selectedURL != nil && !model.completed))
            VStack(alignment: .leading, spacing: 10) {
                Text("好好说一声，该休息啦。")
                    .font(.system(.title2, design: .rounded, weight: .bold))
                Text(kind == "warning" ? "告诉孩子这是最后一集，让休息有个温柔的预告。" : "观看结束时播放，让孩子安心放下遥控器。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if settings != nil {
                Label(builtinClip ? "正在使用默认提醒" : (clipReady ? "正在使用你的提醒视频" : "还没有休息提醒视频"),
                      systemImage: clipReady ? "checkmark.circle" : "video")
                    .font(.headline)
                if clipReady {
                    Button { previewing = true } label: { Label("播放当前提醒", systemImage: "play.fill") }
                        .buttonStyle(PrimaryButtonStyle(background: Palette.input, foreground: Palette.ink))
                }
            } else if failure == nil { ProgressView("正在读取设置…") }
            if model.selectedURL == nil || model.completed {
                VStack(spacing: 0) {
                    PhotosPicker(selection: $photo, matching: .videos, preferredItemEncoding: .current) {
                        SettingsRow(title: "从相册选择", icon: "photo.on.rectangle")
                    }
                    Divider().padding(.horizontal, 20)
                    Button { selecting = true } label: { SettingsRow(title: "从文件选择", icon: "folder", detail: "支持 MP4 视频") }
                }.buttonStyle(.plain).background(Palette.paper, in: RoundedRectangle(cornerRadius: 24)).disabled(locked || !store.canManage)
            }
            if model.selectedURL != nil && !model.completed {
                VStack(alignment: .leading, spacing: 14) {
                    Label(model.selectedName, systemImage: "film").font(.subheadline).lineLimit(2)
                    Text(model.phase).font(.footnote).foregroundStyle(.secondary)
                    if model.hasUpload || model.busy { ProgressView(value: model.progress).tint(Palette.yellow) }
                    if model.busy {
                        Button("暂停上传") { model.pause() }.buttonStyle(PrimaryButtonStyle())
                    } else if model.canRetryProcessing {
                        Button("重试处理") { Task { await model.retryProcessing(api: store.api) } }
                            .buttonStyle(PrimaryButtonStyle()).disabled(locked)
                        Button("重新选择") { cancelling = true }.frame(maxWidth: .infinity, minHeight: 44).disabled(locked)
                    } else if model.processing {
                        Button("检查处理进度") { Task { await model.refreshCompletion(api: store.api); await load() } }
                            .buttonStyle(PrimaryButtonStyle()).disabled(locked)
                    } else {
                        Button(model.hasUpload ? "继续上传" : "上传提醒视频") { start() }
                            .buttonStyle(PrimaryButtonStyle()).disabled(locked || !store.canManage)
                        Button("重新选择") { cancelling = true }.frame(maxWidth: .infinity, minHeight: 44).disabled(locked)
                    }
                }.padding(20).background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
            }
            if preparing { ProgressView("正在准备视频…") }
            if model.completed { Label("休息提醒视频已就绪", systemImage: "checkmark.circle").font(.subheadline) }
            if let error = model.failure { InlineFailure(message: error) }
            if let failure { InlineFailure(message: failure, retry: { Task { await load() } }) }
            if store.upload.busy { Text("资料库视频正在上传，完成后可上传提醒视频。").font(.footnote).foregroundStyle(.secondary) }
            Text("默认提醒已准备好，可以直接使用「这集看完休息」。也可以录制自己的视频替换，所有电视共用，提醒不计入观看时长。")
                .font(.footnote).foregroundStyle(.secondary)
        }.task { kind = model.reminderKind; await load() }
            .task(id: photo) { if let photo { await importPhoto(photo) } }
            .onChange(of: kind) { _, _ in if model.completed { store.resetReminderUpload() } }
            .onChange(of: model.completed) { _, complete in if complete { Task { await load() } } }
            .fileImporter(isPresented: $selecting, allowedContentTypes: [.mpeg4Movie]) { result in
                switch result {
                case .success(let url): select(url)
                case .failure(let error): failure = error.localizedDescription
                }
            }
            .alert("重新选择提醒视频？", isPresented: $cancelling) {
                Button("取消", role: .cancel) {}
                Button("重新选择") {
                    Task {
                        preparing = true; defer { preparing = false }
                        do { try await model.cancel(api: store.api); store.resetReminderUpload(); photo = nil }
                        catch { failure = error.localizedDescription }
                    }
                }
            } message: { Text("这次未完成的上传会取消，已经生效的提醒视频会保留。") }
            .fullScreenCover(isPresented: $previewing) {
                PlayerView(resource: Resource(id: "rest-reminder", name: "休息提醒视频", type: "Episode"), playbackPath: "/api/reminders/\(kind)/playback")
            }
    }
    private func load() async {
        failure = nil
        do { settings = try await store.api.request("/api/manage/reminders") }
        catch { failure = error.localizedDescription }
    }
    private func select(_ url: URL) {
        store.resetReminderUpload()
        model.selectedURL = url; model.selectedName = url.lastPathComponent
        model.phase = "准备好后，点下方上传"; failure = nil
    }
    private func importPhoto(_ item: PhotosPickerItem) async {
        preparing = true; failure = nil; defer { preparing = false }
        do {
            let movie = try await ImportedMovie.prepare(item)
            try Task.checkCancellation()
            select(movie.url)
            model.selectedName = UploadResourceNaming.defaultTitle(filename: movie.originalFilename) + ".mp4"
        }
        catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
    private func start() {
        guard !locked, store.canManage, let url = model.selectedURL else { return }
        model.start(url: url, name: "休息提醒视频", restReminder: true, reminderKind: kind, api: store.api)
    }
}
