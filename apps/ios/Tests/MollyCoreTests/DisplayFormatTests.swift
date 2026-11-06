import Foundation
import Testing
@testable import MollyCore

struct DisplayFormatTests {
    @Test func storageSizesMatchTheSharedWebAndAndroidContract() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixture = root.appendingPathComponent("tools/fixtures/storage-byte-format.tsv")
        for row in try String(contentsOf: fixture, encoding: .utf8).split(separator: "\n").dropFirst() {
            let fields = row.split(separator: "\t")
            let value = try #require(Int64(fields[0]))
            #expect(DisplayFormat.bytes(value) == String(fields[1]), "\(value) bytes")
        }
    }
}
