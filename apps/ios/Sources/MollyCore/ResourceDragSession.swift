import Foundation
import Observation

/// Hovering is only a local preview. A cancelled native drag never writes an
/// order; a completed drag generates one neighbour-anchored server mutation.
@MainActor @Observable
public final class ResourceDragSession {
    public private(set) var itemID: String?
    public private(set) var orderedIDs: [String] = []
    private var originalIDs: [String] = []
    public init() {}

    @discardableResult public func begin(itemID: String, ids: [String]) -> Bool {
        guard self.itemID == nil, ids.contains(itemID), Set(ids).count == ids.count else { return false }
        self.itemID = itemID; originalIDs = ids; orderedIDs = ids
        return true
    }
    public func hover(over target: String) {
        guard let itemID, let source = orderedIDs.firstIndex(of: itemID),
              let destination = orderedIDs.firstIndex(of: target), source != destination,
              let change = ResourcePositionChange(ids: orderedIDs, source: source,
                  destination: destination > source ? destination + 1 : destination) else { return }
        orderedIDs = change.orderedIDs
    }
    public struct Result: Sendable {
        public let ids: [String]
        public let change: ResourcePositionChange?
    }
    public func finish(commit: Bool) -> Result? {
        guard let itemID else { return nil }
        defer { self.itemID = nil; orderedIDs = []; originalIDs = [] }
        guard commit, let source = originalIDs.firstIndex(of: itemID),
              let target = orderedIDs.firstIndex(of: itemID) else { return Result(ids: originalIDs, change: nil) }
        let change = ResourcePositionChange(ids: originalIDs, source: source, destination: target > source ? target + 1 : target)
        return Result(ids: orderedIDs, change: change)
    }
}
