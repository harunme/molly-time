import Foundation

/// A drag uses a visible neighbour as its server anchor. In a paginated list,
/// dropping below the last loaded row must not jump past unloaded siblings.
public struct ResourcePositionChange: Sendable {
    public struct Body: Encodable, Sendable {
        public let beforeId: String?
        public let afterId: String?
    }
    public let itemID: String
    public let orderedIDs: [String]
    public let body: Body

    public init?(ids: [String], source: Int, destination: Int) {
        guard ids.indices.contains(source), (0...ids.count).contains(destination),
              Set(ids).count == ids.count else { return nil }
        let target = destination > source ? destination - 1 : destination
        guard target != source else { return nil }
        var result = ids
        itemID = result.remove(at: source)
        result.insert(itemID, at: target)
        orderedIDs = result
        if target + 1 < result.count {
            body = Body(beforeId: result[target + 1], afterId: nil)
        } else {
            body = Body(beforeId: nil, afterId: result[target - 1])
        }
    }
}
