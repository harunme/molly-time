import Foundation
import Observation
import AVFoundation
import CryptoKit
import UIKit
import MollyCore

@MainActor @Observable
final class UploadModel {
    var selectedURL: URL?
    var selectedName = ""
    var selectedFolder: Resource?
    var allowChildren = false
    var published = false
    var progress = 0.0
    var phase = "等待添加内容"
    var failure: String?
    var busy = false
    var completed = false
    var processing = false
    var resource: Resource?
    private var upload: Upload?
    private var sourceURL: URL?
    private var operation: Task<Void, Never>?
    private var restReminder = false
    private(set) var reminderKind = "farewell"
    private var draftStore: UploadDraftStore?
    var canRetryProcessing: Bool { upload?.status == "failed" && upload?.taskId != nil }
    private var transport: BackgroundUploadTransport?
    private var autoResume = false
    var hasUpload: Bool { upload != nil }

    func configureDraft(scope: String, purpose: String) {
        guard draftStore == nil else { return }
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("UploadDrafts", isDirectory: true)
        let drafts = UploadDraftStore(root: root, scope: scope, purpose: purpose)
        draftStore = drafts
        transport = .shared(identifier: BackgroundUploadTransport.identifier(scope: scope, purpose: purpose))
        do {
            guard let draft = try drafts.load() else { return }
            selectedURL = drafts.movieURL; sourceURL = selectedURL; selectedName = draft.name
            selectedFolder = draft.folder; resource = draft.resource; upload = draft.upload
            allowChildren = draft.allowChildren; published = draft.published
            restReminder = draft.reminderKind != nil; reminderKind = draft.reminderKind ?? "farewell"
            autoResume = draft.autoResume ?? false
            processing = upload?.status == "processing"
            if let upload, upload.size > 0 { progress = Double(upload.offset) / Double(upload.size) }
            phase = processing ? "已上传，可检查处理进度" : "上次上传尚未完成，可继续上传"
        } catch { failure = "无法恢复上次上传：\(error.localizedDescription)" }
    }
    private func saveDraft() throws {
        guard let draftStore, selectedURL == draftStore.movieURL else { return }
        try draftStore.save(.init(name: selectedName, folder: selectedFolder, resource: resource, upload: upload,
            allowChildren: allowChildren, published: published, reminderKind: restReminder ? reminderKind : nil, autoResume: autoResume))
    }
    func resumeAutomatically(api: APIClient) {
        guard autoResume, !busy, !completed, let url = selectedURL else { return }
        start(url: url, name: selectedName, folder: selectedFolder, restReminder: restReminder, reminderKind: reminderKind, api: api)
    }
    func discardDraft() { try? draftStore?.clear() }

    func start(url: URL, name: String, folder: Resource? = nil, restReminder: Bool = false, reminderKind: String = "farewell", api: APIClient) {
        guard !busy else { return }
        guard folder != nil || restReminder else { return }
        self.restReminder = restReminder; self.reminderKind = reminderKind
        if sourceURL != url { resource = nil; upload = nil; progress = 0 }
        sourceURL = url; selectedURL = url; selectedName = name; selectedFolder = folder; busy = true; failure = nil; completed = false
        autoResume = true
        transport?.beginPipeline()
        operation = Task {
            defer { busy = false; transport?.endPipeline(); if !completed { try? saveDraft() } }
            do {
                guard url.pathExtension.lowercased() == "mp4" else { throw APIError.http(422, "请选择 MP4 视频。") }
                var durableURL = url
                if let draftStore, url != draftStore.movieURL {
                    phase = "正在保存上传进度"
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let copy = Task.detached { try draftStore.importMovie(url) }
                    durableURL = try await withTaskCancellationHandler(operation: { try await copy.value }, onCancel: { copy.cancel() })
                    selectedURL = durableURL; sourceURL = durableURL
                    try saveDraft()
                }
                try Task.checkCancellation()
                try await perform(url: durableURL, name: name, folder: folder, api: api)
            }
            catch is CancellationError { phase = "已暂停，可继续上传" }
            catch let error as URLError where error.code == .cancelled { phase = "已暂停，可继续上传" }
            catch { failure = error.localizedDescription; phase = "上传未完成" }
        }
    }
    func pause() {
        autoResume = false; try? saveDraft(); operation?.cancel()
    }
    func pauseAndWait() async {
        pause()
        await operation?.value
        await transport?.cancelAll()
    }
    func cancel(api: APIClient) async throws {
        pause()
        await operation?.value
        await transport?.cancelAll()
        if let upload, upload.status == "uploading" || upload.status == "failed" {
            try await api.command("/api/manage/uploads/\(upload.id)/cancel")
        }
        try draftStore?.clear()
        self.upload = nil; selectedURL = nil; sourceURL = nil; phase = "已取消上传"; progress = 0
    }
    private func perform(url: URL, name: String, folder: Resource?, api: APIClient) async throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard url.pathExtension.lowercased() == "mp4" else { throw APIError.http(422, "当前服务支持 MP4。请先把视频导出为 MP4，再从「文件」选择。") }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let limits: UploadLimits = try await api.request("/api/manage/uploads/options")
        guard size > 0 && size <= limits.video else { throw APIError.http(413, "视频大小需要在 0 到 \(DisplayFormat.bytes(limits.video)) 之间。") }
        phase = "正在读取视频信息"
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0, duration <= Double(Int64.max / 10000) / 1000,
              !(try await asset.loadTracks(withMediaType: .video)).isEmpty else { throw APIError.http(422, "没有读取到有效的视频轨道或时长。") }
        try Task.checkCancellation()
        if resource == nil {
            if restReminder {
                struct Target: Decodable { let itemId: String }
                let target: Target = try await api.send("/api/manage/reminders/\(reminderKind)/upload-target", body: [String: String]())
                resource = Resource(id: target.itemId, name: "休息提醒视频", type: "Episode", status: "draft", ready: false)
            } else if let folder {
                resource = try await UploadResourceNaming.createVideo(name: name, folderID: folder.id, api: api)
                selectedName = resource?.name ?? name
            }
        }
        try saveDraft()
        guard let resource else { throw APIError.invalidResponse }
        if let current = upload {
            upload = try await api.request("/api/manage/uploads/\(current.id)")
        } else {
            struct Start: Encodable { let itemId: String; let filename: String; let size: Int64; let fingerprint: String; let kind = "video" }
            let fingerprint = SHA256.hash(data: Data("\(url.lastPathComponent)|\(size)|\(attributes[.modificationDate] ?? "")".utf8))
                .map { String(format: "%02x", $0) }.joined()
            upload = try await api.send("/api/manage/uploads", body: Start(itemId: resource.id, filename: url.lastPathComponent, size: size, fingerprint: fingerprint))
        }
        try saveDraft()
        guard let initial = upload else { throw APIError.invalidResponse }
        if initial.status == "ready" { try await finish(api: api); return }
        if initial.status == "processing" { processing = true; progress = 1; phase = "已上传，服务正在处理"; return }
        guard initial.status == "uploading" else { throw APIError.http(409, "此上传已结束，可重试处理或取消后重新添加。") }
        guard let transport else { throw APIError.invalidResponse }
        phase = "正在上传，可以离开此页面"
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        if initial.transport == "oss" {
            struct Parts: Decodable { struct Part: Decodable { let number: Int; let size: Int64 }; let parts: [Part] }
            let existing: Parts = try await api.request("/api/manage/uploads/\(initial.id)/parts")
            let partSize = initial.partSize
            guard partSize > 0 && partSize <= 8 * 1024 * 1024 else { throw APIError.invalidResponse }
            var offset: Int64 = 0; var number = 1
            while offset < size {
                try Task.checkCancellation()
                let count = Int(min(Int64(partSize), size - offset))
                if !existing.parts.contains(where: { $0.number == number && $0.size == count }) {
                    try handle.seek(toOffset: UInt64(offset))
                    guard let data = try handle.read(upToCount: count), data.count == count else { throw APIError.http(422, "文件内容已变化，请重新选择原视频。") }
                    struct PartRequest: Encodable { let number: Int; let md5: String }
                    let md5 = Data(Insecure.MD5.hash(data: data)).base64EncodedString()
                    let signed: SignedPart = try await api.send("/api/manage/uploads/\(initial.id)/part-url", body: PartRequest(number: number, md5: md5))
                    var request = URLRequest(url: try api.endpoint.resolve(signed.url, authenticated: false))
                    request.httpMethod = "PUT"
                    for (key, value) in signed.headers { request.setValue(value, forHTTPHeaderField: key) }
                    // Separate credential-free session: never attach the parent session to OSS.
                    let baseOffset = offset
                    let (_, response) = try await transport.send(request, data: data, key: "\(initial.id)-oss-\(number)") { sent, _ in
                        self.progress = Double(baseOffset + min(Int64(count), sent)) / Double(size)
                    }
                    guard (200..<300).contains(response.statusCode) else { throw APIError.http(502, "分片上传失败，请点击继续上传。") }
                }
                offset += Int64(count); number += 1; progress = Double(offset) / Double(size)
            }
        } else if initial.transport == "local" {
            guard initial.offset >= 0 && initial.offset <= size else { throw APIError.invalidResponse }
            var offset = initial.offset
            while offset < size {
                try Task.checkCancellation()
                let count = Int(min(4 * 1024 * 1024, size - offset))
                try handle.seek(toOffset: UInt64(offset))
                guard let data = try handle.read(upToCount: count), data.count == count else { throw APIError.http(422, "文件无法完整读取。") }
                let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                let request = try api.authenticatedRequest("/api/manage/uploads/\(initial.id)/chunks", method: "PUT",
                    query: [URLQueryItem(name: "offset", value: "\(offset)")],
                    headers: ["Content-Type": "application/octet-stream", "X-Chunk-SHA256": hash])
                let baseOffset = offset
                let (body, response) = try await transport.send(request, data: data, key: "\(initial.id)-local-\(offset)") { sent, _ in
                    self.progress = Double(baseOffset + min(Int64(count), sent)) / Double(size)
                }
                guard (200..<300).contains(response.statusCode) else {
                    if response.statusCode == 401 { throw APIError.unauthorized }
                    throw APIError.http(response.statusCode, "上传暂未完成，可以继续上传。")
                }
                let result = try JSONDecoder().decode(Upload.self, from: body)
                guard result.offset == offset + Int64(count) else { throw APIError.invalidResponse }
                offset = result.offset; upload = result; progress = Double(offset) / Double(size)
                try saveDraft()
            }
        } else { throw APIError.invalidResponse }
        try Task.checkCancellation()
        phase = "正在完成上传"
        struct Metadata: Encodable { let runtimeMs: Int64; let cover: String? }
        let cover = await thumbnail(asset)
        upload = try await api.send("/api/manage/uploads/\(initial.id)/complete", body: Metadata(runtimeMs: Int64(duration * 1000), cover: cover))
        try saveDraft()
        progress = 1; processing = true; phase = "已上传，正在处理"
        for _ in 0..<20 {
            // Processing is server-side. Do not hold a system wake-up open to poll.
            guard UIApplication.shared.applicationState == .active else { return }
            try await Task.sleep(for: .seconds(2))
            let current: Upload = try await api.request("/api/manage/uploads/\(initial.id)")
            upload = current
            if current.status == "ready" { try await finish(api: api); return }
            if current.status == "failed" { processing = false; throw APIError.http(422, current.error.isEmpty ? "处理失败，可重试处理。" : current.error) }
        }
        phase = "已上传，稍后可检查处理结果"
    }
    func refreshCompletion(api: APIClient) async {
        guard !busy, let upload else { return }
        busy = true; failure = nil
        defer { busy = false; if !completed { try? saveDraft() } }
        do {
            let current: Upload = try await api.request("/api/manage/uploads/\(upload.id)")
            self.upload = current
            if current.status == "ready" { try await finish(api: api) }
            else if current.status == "failed" { processing = false; failure = current.error.isEmpty ? "视频处理失败，可重试处理或重新添加。" : current.error }
            else if current.status == "processing" { phase = "视频仍在处理中，稍后再看看" }
            else {
                processing = false
                phase = current.status == "uploading" ? "上传尚未完成，可继续上传" : "上传已结束，可取消后重新添加"
            }
        } catch { failure = error.localizedDescription }
    }
    func retryProcessing(api: APIClient) async {
        guard !busy, let taskID = upload?.taskId, canRetryProcessing else { return }
        busy = true; failure = nil
        defer { busy = false; if !completed { try? saveDraft() } }
        do {
            _ = try await api.raw("/api/manage/tasks/\(taskID)/retry", method: "POST", body: Data("{}".utf8))
            if let id = upload?.id { upload = try await api.request("/api/manage/uploads/\(id)") }
            processing = true; phase = "已重新开始处理，稍后可检查结果"
            if upload?.status == "ready" { try await finish(api: api) }
        } catch { failure = error.localizedDescription }
    }
    private func finish(api: APIClient) async throws {
        try Task.checkCancellation()
        autoResume = false
        progress = 1; processing = false; completed = true; phase = "可以在手机观看"
        if restReminder { phase = "提醒视频已就绪"; try draftStore?.clear(); return }
        if allowChildren, let resource, !published {
            do {
                let updated: Resource = try await api.send("/api/manage/resources/\(resource.id)/publish", body: [String: String]())
                self.resource = updated; published = true; phase = "已允许孩子观看"
            } catch {
                failure = "视频已上传，但还未开放给孩子。请重试，或在视频详情中允许孩子观看。"
            }
        }
        if failure == nil { try draftStore?.clear() } else { try saveDraft() }
    }
    private func thumbnail(_ asset: AVAsset) async -> String? {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 640, height: 360)
        do {
            let result = try await generator.image(at: CMTime(seconds: 0, preferredTimescale: 600))
            guard let data = UIImage(cgImage: result.image).jpegData(compressionQuality: 0.7), data.count < 240000 else { return nil }
            return "data:image/jpeg;base64," + data.base64EncodedString()
        } catch { return nil }
    }
}
