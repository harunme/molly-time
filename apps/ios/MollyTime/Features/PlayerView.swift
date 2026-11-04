import SwiftUI
import AVKit
import MollyCore

@MainActor @Observable
final class PlaybackModel {
    let player = AVPlayer()
    var failure: String?
    var loading = true
    var caption = ""
    var tracks: [Playback.Subtitle] = []
    var selectedTrack: Int? = nil
    private var cues: [SubtitleCue] = []
    private var offset = 0
    private var observer: Any?
    private var status: NSKeyValueObservation?
    private var progressKey = ""
    private var lastSaved = Date.distantPast
    private var subtitleGeneration = UUID()

    func load(resource: Resource, store: SessionStore, playbackPath: String? = nil) async {
        loading = true; failure = nil
        defer { loading = false }
        do {
            let info: Playback = try await store.api.request(playbackPath ?? "/api/episodes/\(resource.id)/playback")
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
                    if failed { self?.failure = "视频暂时无法播放。可能是链接已过期、网络中断或格式不受支持，请重新加载。" }
                }
            }
            player.replaceCurrentItem(with: item)
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            progressKey = playbackPath == nil ? "resume|\(store.scope)|\(resource.id)" : ""
            let resume = progressKey.isEmpty ? 0 : (savedPosition.isFinite && savedPosition > 0 ? savedPosition : UserDefaults.standard.double(forKey: progressKey))
            if resume > 0 {
                await player.seek(to: CMTime(seconds: resume, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            }
            tracks = info.subtitles
            selectedTrack = info.subtitles.first(where: \.isDefault)?.index
            await selectSubtitle(selectedTrack, api: store.api)
            if observer == nil {
                observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
                    Task { @MainActor [weak self] in self?.tick(time.seconds) }
                }
            }
            guard !Task.isCancelled else { stop(); return }
            player.play()
        } catch { failure = error.localizedDescription }
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
    func stop() {
        pause()
        if let observer { player.removeTimeObserver(observer); self.observer = nil }
        status = nil; player.replaceCurrentItem(with: nil)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

struct PlayerView: View {
    let resource: Resource
    var playbackPath: String? = nil
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = PlaybackModel()
    @State private var reload = UUID()
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("关闭播放器")
                Text(resource.name).font(.headline).lineLimit(1)
                Spacer()
                Menu {
                    Button("关闭字幕") { Task { await model.selectSubtitle(nil, api: store.api) } }
                    ForEach(model.tracks) { track in
                        Button { Task { await model.selectSubtitle(track.index, api: store.api) } } label: {
                            Label(track.label, systemImage: model.selectedTrack == track.index ? "checkmark" : "captions.bubble")
                        }
                    }
                } label: { Image(systemName: "captions.bubble").frame(width: 44, height: 44) }.accessibilityLabel("字幕")
            }.padding(.horizontal, 8).foregroundStyle(.white)
            ZStack {
                NativePlayer(player: model.player, caption: model.caption)
                if model.loading { ProgressView("正在准备视频…").tint(.white).foregroundStyle(.white) }
                if let failure = model.failure {
                    VStack(spacing: 20) {
                        Image(systemName: "play.slash").font(.largeTitle)
                        Text(failure).multilineTextAlignment(.center)
                        Button("重新加载") { model.pause(); reload = UUID() }.buttonStyle(.borderedProminent).tint(Palette.yellow).foregroundStyle(.black)
                        if model.player.currentItem != nil { Button("继续观看") { model.failure = nil; model.player.play() } }
                    }.padding(28).foregroundStyle(.white).background(.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 20)).padding()
                }
            }
        }.background(.black).preferredColorScheme(.dark)
            .task(id: reload) { await model.load(resource: resource, store: store, playbackPath: playbackPath) }
            .onDisappear { model.stop() }
            .onChange(of: scenePhase) { _, phase in if phase != .active { model.pause() } }
    }
}

private struct NativePlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    let caption: String
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = false // External captions must remain visible.
        let label = context.coordinator.label
        label.numberOfLines = 0; label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .white; label.backgroundColor = UIColor.black.withAlphaComponent(0.65)
        label.layer.cornerRadius = 8; label.clipsToBounds = true
        label.translatesAutoresizingMaskIntoConstraints = false
        if let overlay = controller.contentOverlayView {
            overlay.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
                label.widthAnchor.constraint(lessThanOrEqualTo: overlay.widthAnchor, multiplier: 0.86),
                label.bottomAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.bottomAnchor, constant: -85)
            ])
        }
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        context.coordinator.label.text = caption.isEmpty ? nil : "  \(caption)  "
        context.coordinator.label.isHidden = caption.isEmpty
    }
    final class Coordinator { let label = UILabel() }
}
