import Foundation

/// Display names are independent of UUID staging paths and resumable upload files.
public enum UploadResourceNaming {
    public static func defaultTitle(filename: String?, date: Date = Date()) -> String {
        let stem = ((filename ?? "") as NSString).lastPathComponent as NSString
        let name = stem.deletingPathExtension.trimmingCharacters(in: .whitespacesAndNewlines)
        let temporary = ["video", "movie", "fullsizerender", "tmp", "temp"].contains(name.lowercased())
            || UUID(uuidString: name) != nil
            || (name.count == 32 && name.allSatisfy(\.isHexDigit))
        if !name.isEmpty && !temporary { return clipped(name, limit: 256) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return "视频 " + formatter.string(from: date)
    }

    public static func availableTitle(_ requested: String, existing: Set<String>) -> String {
        let base = clipped(requested.trimmingCharacters(in: .whitespacesAndNewlines), limit: 256)
        let occupied = Set(existing.map(comparisonKey))
        if !occupied.contains(comparisonKey(base)) { return base }
        // At most existing.count candidates can be occupied. Avoid parsing user
        // names: a title containing parentheses may be intentional.
        for number in 2...(existing.count + 2) {
            let suffix = " (\(number))"
            let candidate = clipped(base, limit: 256 - suffix.unicodeScalars.count) + suffix
            if !occupied.contains(comparisonKey(candidate)) { return candidate }
        }
        preconditionFailure("A finite name set must leave a free suffix")
    }

    private static func comparisonKey(_ name: String) -> String {
        name.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }

    private static func clipped(_ value: String, limit: Int) -> String {
        var result = "", count = 0
        for character in value {
            let size = character.unicodeScalars.count
            guard count + size <= limit else { break }
            result.append(character); count += size
        }
        return result
    }

    @MainActor
    public static func createVideo(name: String, folderID: String, api: APIClient) async throws -> Resource {
        struct ExistingName: Decodable { let name: String }
        let base = clipped(name.trimmingCharacters(in: .whitespacesAndNewlines), limit: 256)
        guard !base.isEmpty else { throw APIError.http(422, "请给视频起个名字。") }
        var candidate = base
        var occupied: Set<String> = []
        var loadedNames = false
        for attempt in 0..<5 {
            try Task.checkCancellation()
            do {
                return try await api.send("/api/manage/resources", body: ["name": candidate, "type": "Episode", "parentId": folderID])
            } catch APIError.http(409, let detail) where detail == "同一目录已有这个名称" {
                guard attempt < 4 else { throw APIError.http(409, "同名内容正在添加，请稍后重试或换个名称。") }
                occupied.insert(candidate)
                if !loadedNames {
                    // Only look up names after a confirmed conflict. Include the
                    // trash because the server reserves those names for restore.
                    for status in ["", "archived"] {
                        var page = 1
                        while true {
                            let result: Page<ExistingName> = try await api.request("/api/manage/resources", query: [
                                .init(name: "parentId", value: folderID), .init(name: "resourceType", value: "Episode"),
                                .init(name: "q", value: clipped(base, limit: 200)), .init(name: "summary", value: "true"),
                                .init(name: "status", value: status), .init(name: "page", value: String(page)), .init(name: "pageSize", value: "100")
                            ])
                            occupied.formUnion(result.items.map(\.name))
                            if !result.hasNext || result.items.isEmpty { break }
                            page += 1
                        }
                    }
                    loadedNames = true
                }
                candidate = availableTitle(base, existing: occupied)
                // The server's family lock arbitrates simultaneous devices.
                // Retry only explicit name conflicts, never ambiguous failures.
            }
        }
        throw APIError.invalidResponse
    }
}
