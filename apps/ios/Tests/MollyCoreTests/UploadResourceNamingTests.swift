import Foundation
import Testing
@testable import MollyCore

@Suite(.serialized) @MainActor
struct UploadResourceNamingTests {
    @Test func preservesSourceNamesAndReplacesTemporaryNames() {
        #expect(UploadResourceNaming.defaultTitle(filename: "IMG_1234.MOV") == "IMG_1234")
        #expect(UploadResourceNaming.defaultTitle(filename: "春游.第一天.mp4") == "春游.第一天")
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let fallback = UploadResourceNaming.defaultTitle(filename: nil, date: date)
        #expect(fallback.hasPrefix("视频 "))
        #expect(fallback.count > 20)
        for source in ["video.mp4", "FullSizeRender.MOV", "D038A690-18B5-4A68-B9DD-775ED26C1460.mov", "e417963de257a9000112277170288208.mp4"] {
            #expect(UploadResourceNaming.defaultTitle(filename: source, date: date) == fallback)
        }
    }
    @Test func suffixesAvoidExistingNamesWithoutChangingFreeNames() {
        #expect(UploadResourceNaming.availableTitle(" 春游 ", existing: ["其他视频"]) == "春游")
        #expect(UploadResourceNaming.availableTitle("春游", existing: ["春游", "春游 (2)", "春游 (4)"]) == "春游 (3)")
        #expect(UploadResourceNaming.availableTitle("IMG_1234", existing: ["img_1234", "IMG_1234 (2)"]) == "IMG_1234 (3)")
        #expect(UploadResourceNaming.availableTitle("春游 (2)", existing: ["春游 (2)"]) == "春游 (2) (2)")
    }
    @Test func longUnicodeNamesLeaveRoomForSuffixWithoutSplittingCharacters() {
        let base = String(repeating: "👨‍👩‍👧", count: 100)
        let first = UploadResourceNaming.defaultTitle(filename: base + ".mp4")
        let next = UploadResourceNaming.availableTitle(first, existing: [first])
        #expect(first.unicodeScalars.count <= 256)
        #expect(next.unicodeScalars.count <= 256)
        #expect(next.hasSuffix(" (2)"))
        #expect(next.dropLast(4).allSatisfy { $0 == "👨‍👩‍👧" })
    }
    @Test func freeNameRequiresOnlyOneCreateRequest() async throws {
        var count = 0
        NamingProtocol.handler = { request in
            count += 1
            #expect(request.httpMethod == "POST")
            let body = try Self.body(request)
            #expect(body["name"] == "春游")
            return (200, Self.resource("春游"))
        }
        let resource = try await UploadResourceNaming.createVideo(name: "春游", folderID: "folder", api: client())
        #expect(resource.name == "春游")
        #expect(count == 1)
    }
    @Test func conflictReadsAllPagesAndTrashThenHandlesConcurrentCreation() async throws {
        var submitted: [String] = []
        var queries: [String] = []
        NamingProtocol.handler = { request in
            if request.httpMethod == "POST" {
                let body = try Self.body(request)
                #expect(body["parentId"] == "folder")
                let name = body["name"]!; submitted.append(name)
                return name == "春游 (104)" ? (200, Self.resource(name)) : (409, ["detail": "同一目录已有这个名称"])
            }
            let query = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
            #expect(query["parentId"] == "folder")
            #expect(query["summary"] == "true")
            queries.append("\(query["status"]!):\(query["page"]!)")
            let names: [String]
            let total: Int
            if query["status"] == "archived" { names = ["春游 (102)"]; total = 1 }
            else if query["page"] == "1" { names = ["春游"] + (2...100).map { "春游 (\($0))" }; total = 101 }
            else { names = ["春游 (101)"]; total = 101 }
            return (200, ["items": names.map { ["name": $0] }, "total": total, "page": Int(query["page"]!)!, "pageSize": 100])
        }
        let resource = try await UploadResourceNaming.createVideo(name: "春游", folderID: "folder", api: client())
        #expect(resource.name == "春游 (104)")
        #expect(submitted == ["春游", "春游 (103)", "春游 (104)"])
        #expect(queries == [":1", ":2", "archived:1"])
    }
    @Test func unrelatedConflictIsNotRetried() async throws {
        var count = 0
        NamingProtocol.handler = { _ in count += 1; return (409, ["detail":"合集暂不可用"]) }
        do {
            _ = try await UploadResourceNaming.createVideo(name: "视频", folderID: "folder", api: client())
            Issue.record("Expected original error")
        } catch APIError.http(let code, let detail) {
            #expect(code == 409); #expect(detail == "合集暂不可用")
        }
        #expect(count == 1)
    }
    @Test func lostResponseNeverAutomaticallyCreatesAnotherResource() async throws {
        var count = 0
        NamingProtocol.handler = { _ in count += 1; throw URLError(.networkConnectionLost) }
        do {
            _ = try await UploadResourceNaming.createVideo(name: "视频", folderID: "folder", api: client())
            Issue.record("Expected connection error")
        } catch { #expect((error as? URLError)?.code == .networkConnectionLost) }
        #expect(count == 1)
    }
    private func client() throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NamingProtocol.self]
        return APIClient(endpoint: try Endpoint("https://naming.invalid"), session: URLSession(configuration: configuration))
    }
    nonisolated private static func resource(_ name: String) -> [String: Any] {
        ["id":name,"name":name,"type":"Episode","status":"draft","overview":"","ready":false,"runtimeMs":0,"imageUrl":""]
    }
    nonisolated private static func body(_ request: URLRequest) throws -> [String: String] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try JSONDecoder().decode([String: String].self, from: data)
    }
}

private final class NamingProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, [String: Any]))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, object) = try Self.handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: object))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
