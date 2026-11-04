import SwiftUI
import UniformTypeIdentifiers
import PhotosUI
import CoreTransferable
import AVFoundation
import MollyCore

// Transfer files rather than loading an entire movie into memory.
struct ImportedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("MollyImports", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let target = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: target)
            return ImportedMovie(url: target)
        }
    }
    static func prepare(_ item: PhotosPickerItem) async throws -> URL {
        var imported: URL?
        defer { if let imported { try? FileManager.default.removeItem(at: imported) } }
        do {
            guard let movie = try await item.loadTransferable(type: ImportedMovie.self) else { throw APIError.http(422, "无法读取这个视频，请重新选择。") }
            imported = movie.url
            try Task.checkCancellation()
            let asset = AVURLAsset(url: movie.url)
            guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality), export.supportedFileTypes.contains(.mp4) else {
                throw APIError.http(422, "无法将这个视频转换为 MP4，请从「文件」选择 MP4 视频。")
            }
            let output = movie.url.deletingLastPathComponent().appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
            export.outputURL = output; export.outputFileType = .mp4; export.shouldOptimizeForNetworkUse = true
            await withTaskCancellationHandler(operation: { await export.export() }, onCancel: { export.cancelExport() })
            guard export.status == .completed, !Task.isCancelled else {
                try? FileManager.default.removeItem(at: output)
                throw export.error ?? APIError.http(422, "视频准备未完成，请重新选择。")
            }
            return output
        } catch { throw error }
    }

}

struct UploadView: View {
    var folder: Resource? = nil
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var selecting = false
    @State private var photo: PhotosPickerItem?
    @State private var preparing = false
    @State private var folders: [Resource] = []
    @State private var folderID = ""
    @State private var confirmingCancel = false
    @State private var choosingFolder = false
    private var model: UploadModel { store.upload }
    private var locked: Bool { model.resource != nil || model.hasUpload || model.busy }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: model.completed ? "checkmark.circle.fill" : "plus.rectangle.on.rectangle")
                            .font(.system(size: 38, weight: .light)).foregroundStyle(Palette.yellow)
                        Text(model.completed ? "好内容，已收好。" : "下一段好时光，\n从这里开始。")
                            .font(.system(.largeTitle, design: .rounded, weight: .bold)).tracking(-1)
                        Text(model.completed ? (model.published ? "已允许孩子观看。所在合集也需对孩子开放。" : "你可以先看看，再决定是否给孩子看。") : "添加你有权使用的视频，上传后随时观看。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }.padding(.top, 12)

                    if model.selectedURL == nil {
                        VStack(spacing: 0) {
                            PhotosPicker(selection: $photo, matching: .videos, preferredItemEncoding: .current) {
                                sourceRow("从相册选择", detail: "选择手机中的视频", icon: "photo.on.rectangle")
                            }.disabled(preparing)
                            Divider().padding(.leading, 68)
                            Button { selecting = true } label: {
                                sourceRow("从文件选择", detail: "支持 MP4 视频", icon: "folder")
                            }.disabled(preparing)
                        }.background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
                    } else {
                        VStack(alignment: .leading, spacing: 18) {
                            Label("视频名称", systemImage: "film").font(.caption).foregroundStyle(.secondary)
                            TextField("给视频起个名字", text: Binding(get: { model.selectedName }, set: { model.selectedName = $0 }))
                                .textFieldStyle(MollyInputStyle()).font(.body).disabled(locked)
                            if !locked {
                                Button("重新选择") { model.selectedURL = nil; photo = nil }.font(.subheadline)
                            }
                            Divider()
                            HStack {
                                Text("放入合集").foregroundStyle(.secondary)
                                Spacer()
                                if locked {
                                    Text(model.selectedFolder?.name ?? folder?.name ?? "手机添加").lineLimit(1)
                                } else {
                                    Picker("合集", selection: $folderID) {
                                        Text(folder?.name ?? "手机添加").tag("")
                                        ForEach(folders.filter { $0.id != folder?.id }) { Text($0.name).tag($0.id) }
                                    }.labelsHidden()
                                }
                            }.font(.subheadline)
                        }.padding(20).background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))

                        if !model.completed {
                            VStack(alignment: .leading, spacing: 10) {
                                Toggle("上传后允许孩子观看", isOn: Binding(get: { model.allowChildren }, set: { model.allowChildren = $0 }))
                                    .font(.subheadline.weight(.semibold)).tint(Palette.yellow).disabled(locked)
                                Text(model.allowChildren ? "处理完成后，会自动出现在已绑定的电视上。" : "先仅供家长预览，之后可在视频详情中开放。")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }.padding(20).background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
                        }
                        if model.hasUpload || model.resource != nil {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack { Text(model.phase); Spacer(); Text(model.progress, format: .percent.precision(.fractionLength(0))) }
                                    .font(.caption).foregroundStyle(.secondary)
                                ProgressView(value: model.progress).tint(Palette.yellow)
                            }
                        }
                    }
                    if preparing { HStack(spacing: 12) { ProgressView(); Text("正在准备视频，请稍候…").font(.subheadline) } }
                    if let failure = model.failure { InlineFailure(message: failure) }
                    actions
                    if !model.completed {
                        Label("上传时保持 App 在前台。你可以切换页面；锁屏或切到其他 App 后，上传可能暂停。", systemImage: "info.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }.padding(24).frame(maxWidth: 600)
            }.frame(maxWidth: .infinity).background(Palette.canvas)
                .navigationTitle("添加视频").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("收起") { dismiss() }.disabled(preparing || choosingFolder) } }
                .interactiveDismissDisabled(preparing || choosingFolder)
                .fileImporter(isPresented: $selecting, allowedContentTypes: [.mpeg4Movie]) { result in
                    switch result {
                    case .success(let url): model.selectedURL = url; model.selectedName = url.deletingPathExtension().lastPathComponent; model.failure = nil
                    case .failure(let error): model.failure = error.localizedDescription
                    }
                }
                .task(id: photo) { if let photo { await importPhoto(photo) } }
                .task { await loadFolders() }
                .confirmationDialog("取消这次上传？已创建的待完善视频仍会保留在片库。", isPresented: $confirmingCancel, titleVisibility: .visible) {
                    Button("取消上传", role: .destructive) {
                        Task {
                            do { try await model.cancel(api: store.api); store.upload = UploadModel(); dismiss() }
                            catch { model.failure = error.localizedDescription }
                        }
                    }
                }
        }
    }
    private func sourceRow(_ title: String, detail: String, icon: String) -> some View {
        HStack(spacing: 16) {
            Image(systemName: icon).font(.title2).foregroundStyle(Palette.yellow).frame(width: 32)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.headline).foregroundStyle(.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.tertiary)
        }.padding(20).contentShape(Rectangle())
    }
    @ViewBuilder private var actions: some View {
        if model.completed {
            if model.allowChildren && !model.published {
                Button("重试开放给孩子") { Task { await model.refreshCompletion(api: store.api) } }.buttonStyle(PrimaryButtonStyle()).disabled(model.busy)
            }
            if let resource = model.resource {
                NavigationLink("查看视频") { VideoDetailView(resource: resource) }.buttonStyle(PrimaryButtonStyle())
            }
            Button("再添加一个") { store.upload = UploadModel(); photo = nil }.frame(maxWidth: .infinity).disabled(model.busy)
        } else if model.busy {
            Button("暂停上传") { model.pause() }.buttonStyle(PrimaryButtonStyle())
        } else if model.processing {
            Button("检查处理进度") { Task { await model.refreshCompletion(api: store.api) } }.buttonStyle(PrimaryButtonStyle())
        } else if model.selectedURL != nil {
            Button(choosingFolder ? "正在准备…" : model.hasUpload ? "继续上传" : "开始上传") { Task { await start() } }
                .buttonStyle(PrimaryButtonStyle()).disabled(preparing || choosingFolder || model.selectedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if model.hasUpload { Button("取消这次上传", role: .destructive) { confirmingCancel = true }.frame(maxWidth: .infinity) }
        }
    }
    private func loadFolders() async {
        do {
            var page = 1; var all: [Resource] = []
            while true {
                let result: Page<Resource> = try await store.api.request("/api/manage/resources", query: [.init(name: "page", value: String(page)), .init(name: "pageSize", value: "100")])
                all += result.items.filter(\.isFolder)
                if !result.hasNext { break }; page += 1
            }
            folders = all
        } catch { model.failure = error.localizedDescription }
    }
    private func start() async {
        guard let url = model.selectedURL else { return }
        guard !store.reminderUpload.busy else { model.failure = "休息提醒视频正在上传，请完成后再添加片库视频。"; return }
        choosingFolder = true; defer { choosingFolder = false }
        do {
            let destination: Resource
            if let existing = model.selectedFolder { destination = existing }
            else if let choice = folders.first(where: { $0.id == folderID }) { destination = choice }
            else if let folder { destination = folder }
            else if let existing = folders.first(where: { $0.name == "手机添加" }) { destination = existing }
            else {
                destination = try await store.api.send("/api/manage/resources", body: ["name": "手机添加", "type": "Series"])
                folders.append(destination)
            }
            model.selectedFolder = destination
            model.start(url: url, name: model.selectedName.trimmingCharacters(in: .whitespacesAndNewlines), folder: destination, api: store.api)
        } catch { model.failure = error.localizedDescription }
    }
    private func importPhoto(_ item: PhotosPickerItem) async {
        preparing = true; model.failure = nil
        defer { preparing = false }
        do {
            model.selectedURL = try await ImportedMovie.prepare(item)
            model.selectedName = "新视频"
        } catch { if !Task.isCancelled { model.failure = error.localizedDescription } }
    }
}
