import SwiftUI
import AVFoundation
import Observation
import OSLog

@MainActor @Observable
final class StartupExperience {
    private(set) var finished = false
    private(set) var startedAt = Date()
    private var started = false
    private var player: AVAudioPlayer?
    private var ownsAudioSession = false
    private var completion: Task<Void, Never>?
    private let logger = Logger(subsystem: "app.mollytime.parent", category: "StartupAudio")

    func start(reduceMotion: Bool) {
        guard !started && !finished else { return }
        started = true
        var duration = reduceMotion ? 0.6 : 1.8
        if let url = Bundle.main.url(forResource: "sound", withExtension: "mp3", subdirectory: "startup") {
            do {
                // Use media volume, including when the ring/silent switch is silent.
                // Mixing keeps existing music or podcasts from being interrupted.
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try AVAudioSession.sharedInstance().setActive(true)
                ownsAudioSession = true
                let sound = try AVAudioPlayer(contentsOf: url)
                sound.prepareToPlay()
                player = sound
                if sound.play() {
                    duration = max(duration, min(sound.duration, 6))
                } else {
                    logger.error("Startup audio could not begin playback")
                }
            } catch {
                logger.error("Startup audio setup failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        startedAt = Date()
        completion = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(duration)) }
            catch { return }
            self?.stop()
        }
    }
    func stop() {
        completion?.cancel(); completion = nil
        player?.stop(); player = nil
        if ownsAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsAudioSession = false
        }
        finished = true
    }
}

/// Matches SVG and TV: brisk turn and bloom, then a left-right-left wave on the /t/ attack.
/// The completed logo stays still while startup audio or loading finishes.
struct StartupView: View {
    let startedAt: Date
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.explicit(reduceMotion ? [startedAt] : (0...108).map { startedAt.addingTimeInterval(Double($0) / 60) })) { timeline in
            let elapsed = max(0, timeline.date.timeIntervalSince(startedAt))
            let time = reduceMotion ? 1.8 : min(elapsed, 1.8)
            Canvas { context, size in draw(context, size: size, time: time) }
        }.background(Palette.startup).ignoresSafeArea()
            .accessibilityElement(children: .ignore).accessibilityLabel("MollyTime 正在启动")
    }
    private func draw(_ original: GraphicsContext, size: CGSize, time: Double) {
        var context = original
        let scale = min(size.width, size.height) * 0.44 / 352
        context.translateBy(x: size.width / 2, y: size.height / 2)
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -128, y: -128)
        // Three decaying crests travel left, right, left; preserve each arch's tangents.
        let turn = easeOut(max(0, min((time - 0.24) / 0.36, 1)))
        let leftUnfold = waveUnfold(time, frames: Self.leftWave)
        let rightUnfold = waveUnfold(time, frames: Self.rightWave)
        let bloomProgress = easeOut(max(0, min((time - 0.3) / 0.82, 1)))
        pose(&context, unfold: turn)
        context.opacity = ease(min(time / 0.3, 1))
        context.fill(mark(left: leftUnfold, right: rightUnfold), with: .color(Palette.yellow))
        context.translateBy(x: 0, y: 12 * (1 - rightUnfold))
        let bloom = 0.12 + 0.88 * bloomProgress
        context.translateBy(x: 211, y: 188)
        context.rotate(by: .degrees(-24 * (1 - bloomProgress)))
        context.scaleBy(x: bloom, y: bloom)
        context.translateBy(x: -211, y: -188)
        context.fill(flower(opening: bloomProgress), with: .color(Palette.yellow))
    }
    private func pose(_ context: inout GraphicsContext, unfold: Double) {
        context.translateBy(x: 120, y: 130); context.rotate(by: .degrees(-25 * (1 - unfold))); context.scaleBy(x: 1.02, y: 1.02); context.translateBy(x: -128, y: -128)
    }
    private static let leftWave: [(Double, Double)] = [(0.89, 0), (0.99, 1.22), (1.10, 0.92), (1.22, 1.14), (1.34, 0.99), (1.46, 1)]
    private static let rightWave: [(Double, Double)] = [(0.97, 0), (1.10, 1.18), (1.22, 0.96), (1.34, 1.025), (1.46, 1)]
    private func waveUnfold(_ seconds: Double, frames: [(Double, Double)]) -> Double {
        if seconds <= frames[0].0 { return frames[0].1 }
        for i in 0..<(frames.count - 1) where seconds <= frames[i + 1].0 {
            let t = max(0, min((seconds - frames[i].0) / (frames[i + 1].0 - frames[i].0), 1))
            let progress = i == 0 ? easeOut(t) : ease(t)
            return frames[i].1 + (frames[i + 1].1 - frames[i].1) * progress
        }
        return frames[frames.count - 1].1
    }
    private func easeOut(_ value: Double) -> Double { 1 - (1 - value) * (1 - value) * (1 - value) }
    private func ease(_ value: Double) -> Double { value * value * (3 - 2 * value) }
    private func mark(left: Double, right: Double) -> Path {
        func point(x: Double, y: Double) -> CGPoint {
            let offset: Double
            if y <= 110 {
                // Move each crest and its tangent handles together, blending at the valley.
                let weight = ease(max(0, min((x - 110) / 32, 1)))
                offset = 24 * ((1 - left) * (1 - weight) + (1 - right) * weight)
            } else if x >= 183 && y <= 175 { offset = 12 * (1 - right) }
            else { offset = 0 }
            return CGPoint(x: x, y: y + offset)
        }
        var p = Path()
        p.move(to: point(x: 25, y: 190)); p.addLine(to: point(x: 25, y: 107))
        func curve(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double, _ y: Double) {
            p.addCurve(to: point(x: x, y: y), control1: point(x: x1, y: y1), control2: point(x: x2, y: y2))
        }
        curve(25,71,50.8,43,85,43); curve(100.8,43,114.7,48.7,126,59.1)
        curve(137.1,48.7,151.2,43,167,43); curve(201.2,43,227,71,227,107)
        p.addLine(to: point(x: 227, y: 151))
        curve(212,143,194,149,183,163)
        p.addLine(to: point(x: 183, y: 107)); curve(183,96.3,176.5,88,167,88)
        curve(157.5,88,149,96.3,149,107); p.addLine(to: point(x: 149, y: 190))
        curve(149,202.7,138.7,213,126,213); curve(113.3,213,103,202.7,103,190)
        p.addLine(to: point(x: 103, y: 107)); curve(103,96.3,94.5,88,85,88)
        curve(75.5,88,69,96.3,69,107); p.addLine(to: point(x: 69, y: 191))
        curve(69,203.2,59.2,213,47,213); curve(34.8,213,25,202.9,25,190)
        p.closeSubpath(); return p
    }
    private func flower(opening: Double) -> Path {
        let radius = 17 + (14 - 17) * opening
        let points = [CGPoint(x:201.517,y:166.701), CGPoint(x:228.326,y:172.399), CGPoint(x:231.191,y:199.658), CGPoint(x:206.153,y:210.806), CGPoint(x:187.813,y:190.437), CGPoint(x:201.517,y:166.701)]
        var p = Path(); p.move(to: points[0])
        for i in 1..<points.count {
            let a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y
            let factor = sqrt(max(0, radius * radius / (dx * dx + dy * dy) - 0.25))
            let center = CGPoint(x: (a.x + b.x) / 2 - dy * factor, y: (a.y + b.y) / 2 + dx * factor)
            p.addArc(center: center, radius: radius, startAngle: .radians(atan2(a.y - center.y, a.x - center.x)), endAngle: .radians(atan2(b.y - center.y, b.x - center.x)), clockwise: false)
        }
        p.closeSubpath(); return p
    }
}
