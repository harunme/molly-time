import Foundation
import Testing
@testable import MollyCore

struct ResourcePositionChangeTests {
    @Test func movingToFrontUsesTheNextVisibleSibling() throws {
        let move = try #require(ResourcePositionChange(ids: ["a", "b", "c"], source: 2, destination: 0))
        #expect(move.orderedIDs == ["c", "a", "b"])
        #expect(move.itemID == "c")
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(move.body)) as? [String: String]
        #expect(body == ["beforeId": "a"])
    }
    @Test func droppingAtPageEndNeverMeansEndOfWholeLibrary() throws {
        let move = try #require(ResourcePositionChange(ids: ["a", "b", "c"], source: 0, destination: 3))
        #expect(move.orderedIDs == ["b", "c", "a"])
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(move.body)) as? [String: String]
        #expect(body == ["afterId": "c"])
    }
    @Test func forwardMoveAccountsForRemovedSource() throws {
        let move = try #require(ResourcePositionChange(ids: ["a", "b", "c", "d"], source: 0, destination: 2))
        #expect(move.orderedIDs == ["b", "a", "c", "d"])
        #expect(move.body.beforeId == "c")
    }
    @Test func noOpAndInvalidMovesDoNotSendRequests() {
        #expect(ResourcePositionChange(ids: [], source: 0, destination: 0) == nil)
        #expect(ResourcePositionChange(ids: ["a"], source: 0, destination: 1) == nil)
        #expect(ResourcePositionChange(ids: ["a", "b"], source: 0, destination: 1) == nil)
        #expect(ResourcePositionChange(ids: ["a", "b"], source: 1, destination: 1) == nil)
        #expect(ResourcePositionChange(ids: ["a", "b"], source: 0, destination: 3) == nil)
        #expect(ResourcePositionChange(ids: ["a", "a"], source: 0, destination: 2) == nil)
    }
}
