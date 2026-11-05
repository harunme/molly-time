import SwiftUI
import MollyCore

/// A page owns editing, including cards retained by LazyVGrid that do not receive
/// a representable update when editing ends. Keep registrations weak.
@MainActor final class ResourceGridEditingSession {
    struct State: Equatable {
        var editing = false
        var motionAllowed = false
        var draggedID: String?
    }
    private(set) var state = State()
    private let coordinators = NSHashTable<DraggableResourceCard.Coordinator>.weakObjects()

    func register(_ coordinator: DraggableResourceCard.Coordinator) {
        coordinators.add(coordinator)
        coordinator.updateEditingState()
    }
    func unregister(_ coordinator: DraggableResourceCard.Coordinator) {
        coordinators.remove(coordinator)
    }
    func update(_ state: State) {
        self.state = state
        for coordinator in coordinators.allObjects { coordinator.updateEditingState() }
    }
    func stop() { update(State()) }
}

/// UIKit supplies the native long-press lift, drag preview, and cancellation
/// callback. Only a drag from this library scope can rearrange its cards.
struct DraggableResourceCard: UIViewControllerRepresentable {
    let resource: Resource
    let store: SessionStore
    let scope: UUID
    let enabled: Bool
    let editingSession: ResourceGridEditingSession
    let open: () -> Void
    let manage: () -> Void
    let enterEditing: () -> Void
    let begin: () -> Void
    let hover: () -> Void
    let finish: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIHostingController<AnyView> {
        let controller = UIHostingController(rootView: card)
        controller.view.backgroundColor = .clear
        controller.view.isOpaque = false
        let drag = UIDragInteraction(delegate: context.coordinator)
        drag.isEnabled = enabled && editingSession.state.editing
        context.coordinator.dragInteraction = drag
        controller.view.addInteraction(drag)
        controller.view.addInteraction(UIDropInteraction(delegate: context.coordinator))
        controller.view.addInteraction(UIContextMenuInteraction(delegate: context.coordinator))
        controller.view.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap)))
        context.coordinator.view = controller.view
        editingSession.register(context.coordinator)
        return controller
    }
    private var card: AnyView { AnyView(ResourceCard(resource: resource).environment(store)) }
    func updateUIViewController(_ controller: UIHostingController<AnyView>, context: Context) {
        let previous = context.coordinator.parent
        if previous.editingSession !== editingSession {
            previous.editingSession.unregister(context.coordinator)
        }
        context.coordinator.parent = self
        if previous.editingSession !== editingSession { editingSession.register(context.coordinator) }
        // Reordering changes gesture callbacks and positions, not the artwork.
        // Replacing the hosting root on every animation update can repeatedly
        // measure/decode the entire grid and starve touch handling on device.
        if previous.resource != resource || previous.store !== store || previous.scope != scope {
            controller.rootView = card
        }
        context.coordinator.updateEditingState()
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiViewController: UIHostingController<AnyView>, context: Context) -> CGSize? {
        uiViewController.sizeThatFits(in: CGSize(width: proposal.width ?? 160, height: .greatestFiniteMagnitude))
    }
    static func dismantleUIViewController(_ controller: UIHostingController<AnyView>, coordinator: Coordinator) {
        coordinator.dismantle()
    }
    final class Coordinator: NSObject, UIDragInteractionDelegate, UIDropInteractionDelegate, UIContextMenuInteractionDelegate {
        var parent: DraggableResourceCard
        weak var view: UIView?
        weak var dragInteraction: UIDragInteraction?
        private weak var scrollView: UIScrollView?
        private weak var session: (any UIDragSession)?
        private var displayLink: CADisplayLink?
        private static let wiggleKey = "library.editWiggle"
        private enum MenuAction { case open, manage, edit }
        private var pendingMenuAction: MenuAction?
        private var menuPresented = false
        init(_ parent: DraggableResourceCard) { self.parent = parent }
        func updateEditingState() {
            let state = parent.editingSession.state
            dragInteraction?.isEnabled = parent.enabled && state.editing
            guard let layer = view?.layer else { return }
            guard state.editing, state.motionAllowed, state.draggedID != parent.resource.id else {
                layer.removeAnimation(forKey: Self.wiggleKey)
                return
            }
            guard layer.animation(forKey: Self.wiggleKey) == nil else { return }
            let seed = parent.resource.id.utf8.reduce(0) { ($0 &* 31 &+ Int($1)) & 0xFFFF }
            let angle = (1.1 + Double(seed % 3) * 0.15) * .pi / 180
            let direction = seed.isMultiple(of: 2) ? 1.0 : -1.0
            let animation = CAKeyframeAnimation(keyPath: "transform.rotation.z")
            animation.values = [-angle * direction, angle * direction, -angle * direction]
            animation.keyTimes = [0, 0.5, 1]
            animation.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeInEaseOut)]
            animation.duration = 0.26 + Double(seed % 5) * 0.016
            animation.repeatCount = .infinity
            // Run on the compositor; do not invalidate SwiftUI layout every beat.
            layer.add(animation, forKey: Self.wiggleKey)
        }
        @objc func tap() { parent.open() }
        func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
            guard parent.store.canManage, !parent.editingSession.state.editing else { return nil }
            return UIContextMenuConfiguration(identifier: parent.resource.id as NSString, previewProvider: nil) { [weak self] _ in
                guard let self else { return nil }
                let open = UIAction(title: self.parent.resource.isFolder ? "打开合集" : "查看视频", image: UIImage(systemName: self.parent.resource.isFolder ? "folder" : "play.rectangle")) { [weak self] _ in self?.select(.open) }
                let manage = UIAction(title: self.parent.resource.isFolder ? "合集设置" : "视频设置", image: UIImage(systemName: "slider.horizontal.3")) { [weak self] _ in self?.select(.manage) }
                let edit = UIAction(title: "编辑排列", image: UIImage(systemName: "square.grid.3x3"), attributes: self.parent.enabled ? [] : [.disabled]) { [weak self] _ in self?.select(.edit) }
                return UIMenu(children: [open, manage, UIMenu(options: .displayInline, children: [edit])])
            }
        }
        private func select(_ action: MenuAction) {
            pendingMenuAction = action
            if !menuPresented { performMenuAction() }
        }
        private func performMenuAction() {
            let action = pendingMenuAction
            pendingMenuAction = nil
            switch action {
            case .open: parent.open()
            case .manage: parent.manage()
            case .edit: if parent.enabled { parent.enterEditing() }
            case nil: break
            }
        }
        func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
            menuPresented = true
            pendingMenuAction = nil
        }
        func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
            let finish: () -> Void = { [weak self] in
                self?.menuPresented = false
                self?.performMenuAction()
            }
            if let animator { animator.addCompletion(finish) } else { finish() }
        }
        func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, highlightPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
            coverPreview()
        }
        func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, dismissalPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
            coverPreview()
        }
        func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: any UIContextMenuInteractionCommitAnimating) {
            animator.addCompletion { [weak self] in self?.parent.open() }
        }
        func dragInteraction(_ interaction: UIDragInteraction, itemsForBeginning session: any UIDragSession) -> [UIDragItem] {
            guard parent.editingSession.state.editing, parent.enabled else { return [] }
            let item = UIDragItem(itemProvider: NSItemProvider(object: parent.resource.id as NSString))
            item.localObject = ResourceDragToken(scope: parent.scope, finish: parent.finish)
            return [item]
        }
        // The system's default snapshot fills transparent SwiftUI space with white,
        // turning the cover and caption into a rectangular card. Lift just the cover.
        private func coverPreview() -> UITargetedDragPreview? {
            guard let view, view.window != nil else { return nil }
            let parameters = UIDragPreviewParameters()
            parameters.backgroundColor = .clear
            parameters.visiblePath = UIBezierPath(roundedRect: CGRect(origin: .zero, size: CGSize(width: view.bounds.width, height: view.bounds.width / LibraryGridLayout.coverAspectRatio)), cornerRadius: LibraryGridLayout.coverCornerRadius)
            parameters.shadowPath = UIBezierPath()
            return UITargetedDragPreview(view: view, parameters: parameters)
        }
        func dragInteraction(_ interaction: UIDragInteraction, previewForLifting item: UIDragItem, session: any UIDragSession) -> UITargetedDragPreview? {
            coverPreview()
        }
        func dragInteraction(_ interaction: UIDragInteraction, previewForCancelling item: UIDragItem, withDefault defaultPreview: UITargetedDragPreview) -> UITargetedDragPreview? {
            coverPreview() ?? defaultPreview
        }
        func dragInteraction(_ interaction: UIDragInteraction, prefersFullSizePreviewsFor session: any UIDragSession) -> Bool { true }
        func dragInteraction(_ interaction: UIDragInteraction, sessionWillBegin session: any UIDragSession) {
            parent.begin()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            self.session = session
            session.localContext = self
            var ancestor = view?.superview
            while let current = ancestor, !(current is UIScrollView) { ancestor = current.superview }
            scrollView = ancestor as? UIScrollView
            let link = CADisplayLink(target: self, selector: #selector(scrollAtEdge))
            link.add(to: .main, forMode: .common); displayLink = link
        }
        func dragInteraction(_ interaction: UIDragInteraction, sessionAllowsMoveOperation session: any UIDragSession) -> Bool { true }
        func dragInteraction(_ interaction: UIDragInteraction, sessionIsRestrictedToDraggingApplication session: any UIDragSession) -> Bool { true }
        func dragInteraction(_ interaction: UIDragInteraction, session: any UIDragSession, willEndWith operation: UIDropOperation) {
            if operation == .cancel || operation == .forbidden {
                (session.items.first?.localObject as? ResourceDragToken)?.complete(accepted: false)
            }
        }
        func dragInteraction(_ interaction: UIDragInteraction, session: any UIDragSession, didEndWith operation: UIDropOperation) {
            stopScrolling()
            // performDrop owns acceptance. A late source callback must never undo
            // an accepted move, even when SwiftUI has moved/recycled its source view.
            (session.items.first?.localObject as? ResourceDragToken)?.complete(accepted: false)
            session.localContext = nil
        }
        func dismantle() {
            parent.editingSession.unregister(self)
            dragInteraction?.isEnabled = false
            view?.layer.removeAnimation(forKey: Self.wiggleKey)
            if session == nil { stopScrolling() }
        }
        func stopScrolling() { displayLink?.invalidate(); displayLink = nil; session = nil; scrollView = nil }
        @objc private func scrollAtEdge() {
            guard let session, let scroll = scrollView else { return }
            let point = session.location(in: scroll)
            let y = point.y - scroll.bounds.minY
            let top = scroll.adjustedContentInset.top + 64
            let bottom = scroll.bounds.height - scroll.adjustedContentInset.bottom - 64
            let delta: CGFloat = y < top ? -6 : y > bottom ? 6 : 0
            guard delta != 0 else { return }
            let minimum = -scroll.adjustedContentInset.top
            let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            scroll.contentOffset.y = min(maximum, max(minimum, scroll.contentOffset.y + delta))
        }
        func dropInteraction(_ interaction: UIDropInteraction, canHandle session: any UIDropSession) -> Bool {
            guard parent.editingSession.state.editing, parent.enabled, session.items.count == 1,
                  let token = session.items.first?.localObject as? ResourceDragToken else { return false }
            return token.scope == parent.scope
        }
        func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnter session: any UIDropSession) {
            if dropInteraction(interaction, canHandle: session) { parent.hover() }
        }
        func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: any UIDropSession) -> UIDropProposal {
            UIDropProposal(operation: dropInteraction(interaction, canHandle: session) ? .move : .forbidden)
        }
        func dropInteraction(_ interaction: UIDropInteraction, performDrop session: any UIDropSession) {
            guard dropInteraction(interaction, canHandle: session) else { return }
            (session.items.first?.localObject as? ResourceDragToken)?.complete(accepted: true)
        }
        func dropInteraction(_ interaction: UIDropInteraction, previewForDropping item: UIDragItem, withDefault defaultPreview: UITargetedDragPreview) -> UITargetedDragPreview? {
            // The grid already displays the committed slot; fade the floating
            // snapshot instead of animating it back toward a stale source frame.
            nil
        }
    }
}

@MainActor private final class ResourceDragToken {
    let scope: UUID
    private let finish: (Bool) -> Void
    private var completed = false
    init(scope: UUID, finish: @escaping (Bool) -> Void) { self.scope = scope; self.finish = finish }
    func complete(accepted: Bool) {
        guard !completed else { return }
        completed = true
        finish(accepted)
    }
}

/// Accept drops into the spacing between cards as well as directly on a card.
struct ResourceDropBackground: UIViewRepresentable {
    let scope: UUID
    let enabled: Bool
    var onBlankTap: (() -> Void)?
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> ResourceDropArea {
        let view = ResourceDropArea()
        view.backgroundColor = .clear
        view.dropInteraction = UIDropInteraction(delegate: context.coordinator)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapBlankSpace))
        tap.isEnabled = onBlankTap != nil
        view.addGestureRecognizer(tap)
        view.blankTap = tap
        context.coordinator.area = view
        return view
    }
    func updateUIView(_ view: ResourceDropArea, context: Context) {
        context.coordinator.parent = self
        view.blankTap?.isEnabled = onBlankTap != nil
        view.attachToScrollView()
    }
    static func dismantleUIView(_ view: ResourceDropArea, coordinator: Coordinator) { view.detach() }
    final class Coordinator: NSObject, UIDropInteractionDelegate {
        var parent: ResourceDropBackground
        weak var area: ResourceDropArea?
        init(_ parent: ResourceDropBackground) { self.parent = parent }
        @objc func tapBlankSpace() { parent.onBlankTap?() }
        func dropInteraction(_ interaction: UIDropInteraction, canHandle session: any UIDropSession) -> Bool {
            parent.enabled && session.items.count == 1 && (session.items.first?.localObject as? ResourceDragToken)?.scope == parent.scope
        }
        func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: any UIDropSession) -> UIDropProposal {
            UIDropProposal(operation: accepts(session) ? .move : .cancel)
        }
        private func accepts(_ session: any UIDropSession) -> Bool {
            guard let area, parent.enabled, session.items.count == 1,
                  (session.items.first?.localObject as? ResourceDragToken)?.scope == parent.scope else { return false }
            return area.bounds.contains(session.location(in: area))
        }
        func dropInteraction(_ interaction: UIDropInteraction, performDrop session: any UIDropSession) {
            guard accepts(session) else { return }
            (session.items.first?.localObject as? ResourceDragToken)?.complete(accepted: true)
        }
        func dropInteraction(_ interaction: UIDropInteraction, previewForDropping item: UIDragItem, withDefault defaultPreview: UITargetedDragPreview) -> UITargetedDragPreview? { nil }
    }
}

/// The scroll view stays put while individual SwiftUI cells move around. Attach
/// the fallback drop receiver there, using this view only to bound the valid grid.
final class ResourceDropArea: UIView {
    var dropInteraction: UIDropInteraction?
    var blankTap: UITapGestureRecognizer?
    private weak var receiver: UIScrollView?
    override func didMoveToSuperview() { super.didMoveToSuperview(); attachToScrollView() }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { detach() } else { attachToScrollView() }
    }
    func attachToScrollView() {
        guard let dropInteraction else { return }
        var ancestor = superview
        while let current = ancestor, !(current is UIScrollView) { ancestor = current.superview }
        guard let scroll = ancestor as? UIScrollView, scroll !== receiver else { return }
        detach()
        receiver = scroll
        scroll.addInteraction(dropInteraction)
    }
    func detach() {
        if let dropInteraction { receiver?.removeInteraction(dropInteraction) }
        receiver = nil
    }
}
