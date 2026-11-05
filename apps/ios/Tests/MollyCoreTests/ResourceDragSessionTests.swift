import Testing
@testable import MollyCore

@MainActor struct ResourceDragSessionTests {
    @Test func cancelledDragRestoresOrderWithoutMutation() throws {
        let drag = ResourceDragSession()
        #expect(drag.begin(itemID: "a", ids: ["a", "b", "c"]))
        drag.hover(over: "c")
        #expect(drag.orderedIDs == ["b", "c", "a"])
        let result = try #require(drag.finish(commit: false))
        #expect(result.ids == ["a", "b", "c"])
        #expect(result.change == nil)
        #expect(drag.itemID == nil)
        #expect(drag.finish(commit: true) == nil)
    }
    @Test func repeatedHoverProducesOneFinalAnchoredMove() throws {
        let drag = ResourceDragSession()
        drag.begin(itemID: "a", ids: ["a", "b", "c", "d"])
        drag.hover(over: "b"); drag.hover(over: "c"); drag.hover(over: "d")
        let result = try #require(drag.finish(commit: true))
        #expect(result.ids == ["b", "c", "d", "a"])
        #expect(result.change?.body.afterId == "d")
        #expect(result.change?.body.beforeId == nil)
    }
    @Test func returningToOriginalSlotDoesNotSave() throws {
        let drag = ResourceDragSession()
        drag.begin(itemID: "a", ids: ["a", "b", "c"])
        drag.hover(over: "c"); drag.hover(over: "b")
        #expect(try #require(drag.finish(commit: true)).change == nil)
    }
    @Test func unknownTargetsAndSecondDragCannotCorruptActiveDrag() throws {
        let drag = ResourceDragSession()
        #expect(!drag.begin(itemID: "missing", ids: ["a", "b"]))
        #expect(drag.begin(itemID: "a", ids: ["a", "b"]))
        #expect(!drag.begin(itemID: "b", ids: ["a", "b"]))
        drag.hover(over: "foreign")
        #expect(drag.orderedIDs == ["a", "b"])
        #expect(try #require(drag.finish(commit: true)).change == nil)
    }
}
