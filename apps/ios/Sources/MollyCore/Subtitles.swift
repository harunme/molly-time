import Foundation

public struct SubtitleCue: Equatable, Sendable {
    public let start: Double
    public let end: Double
    public let text: String
}
public enum WebVTT {
    public static func parse(_ text: String) -> [SubtitleCue] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        return normalized.components(separatedBy: "\n\n").compactMap { block in
            let lines = block.components(separatedBy: "\n")
            guard let index = lines.firstIndex(where: { $0.contains(" --> ") }) else { return nil }
            let times = lines[index].components(separatedBy: " --> ")
            guard times.count == 2, let start = timestamp(times[0]),
                  let end = timestamp(String(times[1].split(separator: " ").first ?? "")), end > start else { return nil }
            let caption = lines.dropFirst(index + 1).joined(separator: "\n")
                .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "&amp;", with: "&")
                .replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            return SubtitleCue(start: start, end: end, text: caption)
        }.sorted { $0.start < $1.start }
    }
    private static func timestamp(_ value: String) -> Double? {
        let parts = value.split(separator: ":").map { Double($0) }
        guard (2...3).contains(parts.count), parts.allSatisfy({ $0 != nil }) else { return nil }
        return parts.reduce(0) { $0 * 60 + $1! }
    }
    public static func caption(at seconds: Double, offsetMs: Int, cues: [SubtitleCue]) -> String {
        let adjusted = seconds - Double(offsetMs) / 1000
        return cues.filter { $0.start <= adjusted && adjusted < $0.end }.map(\.text).joined(separator: "\n")
    }
}
