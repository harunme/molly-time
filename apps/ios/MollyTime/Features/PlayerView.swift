import SwiftUI
import AVKit
import MollyCore

@MainActor @Observable
final class PlaybackModel {
    let player = AVPlayer()
    var failure: String?
    var loading = true
    var caption = ""
    var position = 0.0
    var duration = 0.0
    var isPlaying = false
    var isWaiting = false
    var speed: Float = 1
    private var playbackStatus: NSKeyValueObservation?
    var tracks: [Playback.Subtitle] = []
    var selectedTrack: Int? = nil
    private var cues: [SubtitleCue] = []
    private var offset = 0
    private var observer: Any?
    private var status: NSKeyValueObservation?
    private var progressKey = ""
    private var lastSaved = Date.distantPast
    private var subtitleGeneration = UUID()
    private var loadTask: Task<Void, Never>?
    private var loadID: UUID?
    private var previousIdleTimer: Bool?

    // Loading belongs to the playback session, not to a view appearance task.
    // Layout, zoom and rotation must keep the same player item alive.
    func prepare(resource: Resource, store: SessionStore, playbackPath: String?, id: UUID) {
        guard loadID != id else { return }
        if previousIdleTimer == nil { previousIdleTimer = UIApplication.shared.isIdleTimerDisabled }
        UIApplication.shared.isIdleTimerDisabled = true
        loadTask?.cancel()
        subtitleGeneration = UUID()
        loadID = id
        loadTask = Task { [weak self] in
            await self?.load(resource: resource, store: store, playbackPath: playbackPath)
        }
    }

    func load(resource: Resource, store: SessionStore, playbackPath: String? = nil) async {
        let generation = loadID
        loading = true; failure = nil
        defer { if loadID == generation { loading = false } }
        do {
            let info: Playback = try await store.api.request(playbackPath ?? "/api/episodes/\(resource.id)/playback")
            try Task.checkCancellation()
            let url = try store.api.endpoint.resolve(info.url, authenticated: false)
            let savedPosition = player.currentTime().seconds
            var options: [String: Any] = [:]
            if store.api.endpoint.isSameOrigin(url), !store.api.cookie.isEmpty {
                // AVFoundation scopes this cookie to the API host; OSS gets no app credentials.
                if let cookie = HTTPCookie(properties: [.domain: url.host!, .path: "/", .name: "molly_parent",
                    .value: store.api.cookie, .secure: "TRUE"]) { options[AVURLAssetHTTPCookiesKey] = [cookie] }
            }
            let item = AVPlayerItem(asset: AVURLAsset(url: url, options: options))
            status = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                let failed = item.status == .failed
                Task { @MainActor [weak self] in
                    if failed, self?.player.currentItem === item { self?.failure = "视频暂时无法播放。可能是链接已过期、网络中断或格式不受支持，请重新加载。" }
                }
            }
            player.replaceCurrentItem(with: item)
            playbackStatus = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
                Task { @MainActor [weak self] in
                    self?.isPlaying = player.timeControlStatus != .paused
                    self?.isWaiting = player.timeControlStatus == .waitingToPlayAtSpecifiedRate
                    if let previous = self?.previousIdleTimer {
                        UIApplication.shared.isIdleTimerDisabled = previous || player.timeControlStatus != .paused
                    }
                }
            }
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            progressKey = playbackPath == nil ? "resume|\(store.scope)|\(resource.id)" : ""
            let resume = progressKey.isEmpty ? 0 : (savedPosition.isFinite && savedPosition > 0 ? savedPosition : UserDefaults.standard.double(forKey: progressKey))
            if resume > 0 {
                await player.seek(to: CMTime(seconds: resume, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            }
            try Task.checkCancellation()
            tracks = info.subtitles
            selectedTrack = info.subtitles.first(where: \.isDefault)?.index
            await selectSubtitle(selectedTrack, api: store.api)
            try Task.checkCancellation()
            if observer == nil {
                observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
                    Task { @MainActor [weak self] in self?.tick(time.seconds) }
                }
            }
            player.playImmediately(atRate: speed)
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
    func selectSubtitle(_ index: Int?, api: APIClient) async {
        let generation = UUID(); subtitleGeneration = generation
        cues = []; caption = ""; selectedTrack = index; offset = 0
        guard let track = tracks.first(where: { $0.index == index }) else { return }
        do {
            let data = try await api.raw(track.url)
            guard subtitleGeneration == generation else { return }
            guard let text = String(data: data, encoding: .utf8) else { throw APIError.invalidResponse }
            cues = WebVTT.parse(text)
            // The API's VTT endpoint already applies the configured timing offset.
            offset = 0
        } catch { if subtitleGeneration == generation { failure = "字幕加载失败，可关闭字幕继续观看。" } }
    }
    private func tick(_ seconds: Double) {
        guard seconds.isFinite else { return }
        position = max(0, seconds)
        let length = player.currentItem?.duration.seconds ?? 0
        duration = length.isFinite ? max(0, length) : 0
        caption = WebVTT.caption(at: seconds, offsetMs: offset, cues: cues)
        if Date().timeIntervalSince(lastSaved) > 5 { savePosition(); lastSaved = Date() }
    }
    func savePosition() {
        guard !progressKey.isEmpty else { return }
        let seconds = player.currentTime().seconds
        guard seconds.isFinite, seconds >= 0 else { return }
        let duration = player.currentItem?.duration.seconds ?? .nan
        UserDefaults.standard.set(duration.isFinite && duration - seconds < 5 ? 0 : seconds, forKey: progressKey)
    }
    func pause() { player.pause(); savePosition() }
    func togglePlayback() {
        if isPlaying { pause() }
        else {
            if duration > 0, position >= duration - 0.2 { seek(to: 0) }
            player.playImmediately(atRate: speed)
        }
    }
    func changeSpeed(_ value: Float) {
        speed = value
        if isPlaying { player.rate = value }
    }
    func seek(to seconds: Double) {
        let target = max(0, min(seconds, duration > 0 ? duration : seconds))
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    func stop() {
        loadTask?.cancel(); loadTask = nil; loadID = nil
        if let previousIdleTimer { UIApplication.shared.isIdleTimerDisabled = previousIdleTimer }
        previousIdleTimer = nil
        subtitleGeneration = UUID()
        pause()
        if let observer { player.removeTimeObserver(observer); self.observer = nil }
        status = nil; playbackStatus = nil; isPlaying = false; isWaiting = false
        player.replaceCurrentItem(with: nil)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

struct PlayerView: View {
    let resource: Resource
    var playbackPath: String? = nil
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var model = PlaybackModel()
    @State private var reload = UUID()
    @State private var fillsScreen = false
    @State private var controlsVisible = true
    @State private var interaction = 0
    @State private var scrubbing = false
    @State private var scrubPosition = 0.0
    @State private var resumeAfterScrubbing = false
    @State private var subtitleOptions = false
    @State private var speedOptions = false
    var body: some View {
        ZStack {
            NativePlayer(player: model.player, caption: model.caption, fillsScreen: fillsScreen,
                         controlsVisible: controlsVisible, onDispose: model.stop)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { controlsVisible.toggle(); interaction += 1 }
                .accessibilityAction(named: "显示播放控制") { showControls() }
            if controlsVisible {
                VStack(spacing: 0) {
                    playerHeader
                    Spacer(minLength: 0)
                    transportBar
                }
                if !model.loading && model.failure == nil {
                    HStack(spacing: 48) {
                        Button { model.seek(to: model.position - 10); showControls() } label: {
                            Image(systemName: "gobackward.10").font(.title).frame(width: 52, height: 52).contentShape(Rectangle())
                        }.accessibilityLabel("后退 10 秒")
                        Button { model.togglePlayback(); showControls() } label: {
                            Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 36, weight: .semibold)).frame(width: 76, height: 76).contentShape(Rectangle())
                        }.accessibilityLabel(model.isPlaying ? "暂停" : "播放")
                        Button { model.seek(to: model.position + 10); showControls() } label: {
                            Image(systemName: "goforward.10").font(.title).frame(width: 52, height: 52).contentShape(Rectangle())
                        }.accessibilityLabel("前进 10 秒")
                    }.buttonStyle(.plain).foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.65), radius: 8, y: 2)
                }
            }
            if model.loading || (model.isWaiting && !controlsVisible) {
                ProgressView().tint(.white).accessibilityLabel("正在准备视频")
            }
            if let failure = model.failure {
                VStack(spacing: 20) {
                    Image(systemName: "play.slash").font(.largeTitle)
                    Text(failure).multilineTextAlignment(.center)
                    Button("重新加载") { model.pause(); reload = UUID(); showControls() }
                        .buttonStyle(.borderedProminent).tint(Palette.yellow).foregroundStyle(.black)
                    if model.player.currentItem != nil {
                        Button("继续观看") { model.failure = nil; model.player.playImmediately(atRate: model.speed) }
                    }
                }.padding(28).foregroundStyle(.white).background(.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 20)).padding()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black).preferredColorScheme(.dark)
        .statusBarHidden()
        .task(id: reload) { model.prepare(resource: resource, store: store, playbackPath: playbackPath, id: reload) }
        .task(id: "\(interaction)-\(model.isPlaying)-\(controlsVisible)-\(scrubbing)-\(voiceOver)-\(subtitleOptions)-\(speedOptions)") {
            guard controlsVisible, model.isPlaying, !scrubbing, !voiceOver, !subtitleOptions, !speedOptions else { return }
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            controlsVisible = false
        }
        .confirmationDialog("字幕", isPresented: $subtitleOptions, titleVisibility: .visible) {
            Button("关闭字幕") { Task { await model.selectSubtitle(nil, api: store.api) }; showControls() }
            ForEach(model.tracks) { track in
                Button(track.label) { Task { await model.selectSubtitle(track.index, api: store.api) }; showControls() }
            }
        }
        .confirmationDialog("播放速度", isPresented: $speedOptions, titleVisibility: .visible) {
            ForEach([Float(0.75), 1, 1.25, 1.5, 2], id: \.self) { speed in
                Button("\(speed.formatted())×") { model.changeSpeed(speed); showControls() }
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { model.pause(); showControls() } }
        .onChange(of: model.isPlaying) { _, playing in if !playing { showControls() } }
    }
    private func showControls() { controlsVisible = true; interaction += 1 }
    private var playerHeader: some View {
        HStack(spacing: 8) {
            Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("关闭播放器")
            Text(resource.name).font(.headline).lineLimit(1)
            Spacer(minLength: 0)
            Button { fillsScreen.toggle(); showControls() } label: {
                Image(systemName: fillsScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }.accessibilityLabel(fillsScreen ? "完整画面" : "铺满屏幕")
            Button { subtitleOptions = true; showControls() } label: {
                Image(systemName: "captions.bubble").frame(width: 44, height: 44).contentShape(Rectangle())
            }.accessibilityLabel("字幕")
        }.buttonStyle(.plain).padding(.horizontal, 8).foregroundStyle(.white)
            .background(alignment: .top) {
                LinearGradient(colors: [.black.opacity(0.75), .clear], startPoint: .top, endPoint: .bottom)
                    .padding(.bottom, -24).ignoresSafeArea(edges: .top).allowsHitTesting(false)
            }
    }
    private var transportBar: some View {
        HStack(spacing: 12) {
            Text(time(scrubbing ? scrubPosition : model.position)).font(.caption.monospacedDigit())
            Slider(value: Binding(get: { scrubbing ? scrubPosition : min(model.position, max(1, model.duration)) },
                                  set: { scrubPosition = $0 }), in: 0...max(1, model.duration)) { editing in
                if editing && !scrubbing {
                    scrubPosition = model.position
                    resumeAfterScrubbing = model.isPlaying
                    model.pause()
                } else if !editing && scrubbing {
                    model.seek(to: scrubPosition)
                    if resumeAfterScrubbing { model.player.playImmediately(atRate: model.speed) }
                }
                scrubbing = editing; showControls()
            }.tint(.white).disabled(model.duration <= 0)
                .accessibilityLabel("播放进度")
                .accessibilityValue("\(time(model.position))，总时长 \(time(model.duration))")
            Text(time(model.duration)).font(.caption.monospacedDigit())
            Button { speedOptions = true; showControls() } label: {
                Text("\(model.speed.formatted())×").font(.caption.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("播放速度")
            PlayerRoutePicker().frame(width: 44, height: 44).contentShape(Rectangle()).accessibilityLabel("AirPlay")
        }.foregroundStyle(.white).frame(height: 52).padding(.horizontal, 20)
            .background(alignment: .bottom) {
                LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom)
                    .padding(.top, -24).ignoresSafeArea(edges: .bottom).allowsHitTesting(false)
            }
    }
    private func time(_ seconds: Double) -> String {
        let value = Int(max(0, seconds.isFinite ? seconds : 0))
        return value >= 3600 ? String(format: "%d:%02d:%02d", value / 3600, value / 60 % 60, value % 60)
                            : String(format: "%d:%02d", value / 60, value % 60)
    }
}

private struct PlayerRoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = .white; view.activeTintColor = .systemYellow
        view.prioritizesVideoDevices = true
        return view
    }
    func updateUIView(_ view: AVRoutePickerView, context: Context) { }
}

private struct NativePlayer: UIViewRepresentable {
    let player: AVPlayer
    let caption: String
    let fillsScreen: Bool
    let controlsVisible: Bool
    let onDispose: () -> Void
    func makeUIView(context: Context) -> VideoSurface {
        let view = VideoSurface()
        view.playerLayer.player = player
        view.onDispose = onDispose
        return view
    }
    func updateUIView(_ view: VideoSurface, context: Context) {
        let gravity: AVLayerVideoGravity = fillsScreen ? .resizeAspectFill : .resizeAspect
        if view.playerLayer.videoGravity != gravity {
            view.playerLayer.videoGravity = gravity
            view.captions.setNeedsLayout()
        }
        view.captions.controlsVisible = controlsVisible
        view.captions.setCaption(caption)
    }
    static func dismantleUIView(_ view: VideoSurface, coordinator: ()) {
        view.onDispose?()
        view.playerLayer.player = nil
    }
}

/// One AVPlayerLayer remains mounted through zoom and rotation. There is no
/// second fullscreen controller whose presentation can tear down playback.
private final class VideoSurface: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    let captions = VideoCaptionsView()
    var onDispose: (() -> Void)?
    private var boundsObservation: NSKeyValueObservation?
    override init(frame: CGRect) {
        super.init(frame: frame)
        captions.surface = self
        addSubview(captions)
        boundsObservation = playerLayer.observe(\.videoRect, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.captions.setNeedsLayout() }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        captions.frame = bounds
        captions.setNeedsLayout()
    }
    override func safeAreaInsetsDidChange() { super.safeAreaInsetsDidChange(); captions.setNeedsLayout() }
}

private final class VideoCaptionsView: UIView {
    weak var surface: VideoSurface?
    var controlsVisible = true { didSet { if oldValue != controlsVisible { setNeedsLayout() } } }
    private let bubble = UIView()
    private let label = UILabel()
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        label.numberOfLines = 0; label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .white
        label.accessibilityIdentifier = "player-caption"
        bubble.backgroundColor = UIColor.black.withAlphaComponent(0.65)
        bubble.layer.cornerRadius = 8
        addSubview(bubble); bubble.addSubview(label)
        bubble.isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func setCaption(_ value: String) {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard label.text != text else { return }
        label.text = text; bubble.isHidden = text.isEmpty
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard let surface, !surface.playerLayer.videoRect.isEmpty else { bubble.isHidden = true; return }
        let picture = convert(surface.playerLayer.videoRect, from: surface).intersection(bounds)
        guard !picture.isNull, picture.width > 0, picture.height > 0 else { bubble.isHidden = true; return }
        bubble.isHidden = label.text?.isEmpty != false
        let safe = window.map { convert($0.safeAreaLayoutGuide.layoutFrame, from: $0) } ?? bounds
        let available = picture.intersection(safe)
        guard !available.isNull, available.width > 24 else { bubble.isHidden = true; return }
        let width = min(picture.width * 0.86, available.width - 24)
        let size = label.sizeThatFits(CGSize(width: max(1, width - 24), height: .greatestFiniteMagnitude))
        let bubbleSize = CGSize(width: min(width, ceil(size.width) + 24), height: ceil(size.height) + 8)
        // Only reserve transport-bar space while it is visible. In portrait,
        // the bar is outside the picture, so captions stay on the image edge.
        let bottom = min(picture.maxY - max(12, min(24, picture.height * 0.035)),
                         safe.maxY - (controlsVisible ? 64 : 8))
        bubble.frame = CGRect(x: available.midX - bubbleSize.width / 2, y: bottom - bubbleSize.height,
                              width: bubbleSize.width, height: bubbleSize.height).integral
        label.frame = bubble.bounds.insetBy(dx: 12, dy: 4)
    }
}
