import Foundation
import CryptoKit

/// Small, bounded artwork uploads use the same authenticated upload lifecycle
/// as videos; signed object-storage requests carry no parent credentials.
@MainActor
public enum ResourceArtworkUpload {
    public struct ProcessingFailure: Error { public let message: String }
    public static func send(_ data: Data, itemID: String, api: APIClient, resume: Upload? = nil,
                            progress: @escaping @MainActor (Upload) -> Void = { _ in }) async throws {
        guard !data.isEmpty, data.count <= 20 * 1024 * 1024 else { throw APIError.http(413, "封面不能超过 20 MB。") }
        struct Start: Encodable { let itemId: String; let filename = "cover.jpg"; let kind = "image"; let size: Int; let fingerprint: String }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        var upload: Upload
        if let resume { upload = try await api.request("/api/manage/uploads/\(resume.id)") }
        else { upload = try await api.send("/api/manage/uploads", body: Start(itemId: itemID, size: data.count, fingerprint: hash)) }
        let path = "/api/manage/uploads/\(upload.id)"
        progress(upload)
        if upload.status == "cancelled" { throw APIError.http(410, "上传已结束") }
        if upload.status == "failed", let taskID = upload.taskId {
            upload = try await api.send("/api/manage/tasks/\(taskID)/retry", body: [String: String]())
            progress(upload)
        }
        if upload.status == "ready" { return }
        if upload.status == "uploading", upload.transport == "local" {
            guard upload.offset >= 0 && upload.offset <= data.count else { throw APIError.invalidResponse }
            var offset = Int(upload.offset)
            while offset < data.count {
                try Task.checkCancellation()
                let end = min(offset + 4 * 1024 * 1024, data.count)
                let part = data.subdata(in: offset..<end)
                let checksum = SHA256.hash(data: part).map { String(format: "%02x", $0) }.joined()
                upload = try await api.request(path + "/chunks", method: "PUT", query: [.init(name: "offset", value: "\(offset)")], body: part,
                    headers: ["Content-Type": "application/octet-stream", "X-Chunk-SHA256": checksum])
                progress(upload)
                guard upload.offset == end else { throw APIError.invalidResponse }
                offset = end
            }
        } else if upload.status == "uploading", upload.transport == "oss" {
            struct Part: Encodable { let number: Int; let md5: String }
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false; config.httpCookieStorage = nil
            let transport = URLSession(configuration: config)
            defer { transport.invalidateAndCancel() }
            guard (1...8 * 1024 * 1024).contains(upload.partSize) else { throw APIError.invalidResponse }
            struct Parts: Decodable { struct Part: Decodable { let number: Int; let size: Int }; let parts: [Part] }
            let existing: Parts = try await api.request(path + "/parts")
            for (index, offset) in stride(from: 0, to: data.count, by: upload.partSize).enumerated() {
                try Task.checkCancellation()
                let part = data.subdata(in: offset..<min(offset + upload.partSize, data.count))
                if existing.parts.contains(where: { $0.number == index + 1 && $0.size == part.count }) { continue }
                let signed: SignedPart = try await api.send(path + "/part-url", body: Part(number: index + 1, md5: Data(Insecure.MD5.hash(data: part)).base64EncodedString()))
                var request = URLRequest(url: try api.endpoint.resolve(signed.url, authenticated: false))
                request.httpMethod = "PUT"
                for (key, value) in signed.headers { request.setValue(value, forHTTPHeaderField: key) }
                let (_, response) = try await transport.upload(for: request, from: part)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw APIError.http(502, "封面上传未完成，请重试。") }
            }
        } else if upload.status != "processing" { throw APIError.http(409, "封面上传已结束，请重新选择图片。") }
        if upload.status == "uploading" {
            upload = try await api.send(path + "/complete", body: [String: String]())
            progress(upload)
        }
        for _ in 0..<30 {
            if upload.status == "ready" { return }
            if upload.status == "failed" { throw ProcessingFailure(message: upload.error) }
            try await Task.sleep(for: .seconds(1))
            upload = try await api.request(path)
            progress(upload)
        }
        throw APIError.http(409, "封面已上传，仍在处理中，可稍后返回资料库查看。")
    }
}
