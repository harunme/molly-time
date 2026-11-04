import SwiftUI
import MollyCore

// Molly's existing jasmine palette, paired with native Dynamic Type.
enum Palette {
    static let yellow = Color(red: 0.973, green: 0.871, blue: 0.494) // F8DE7E
    static let ink = Color.primary
    static let canvas = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .systemGroupedBackground : UIColor(red: 0.976, green: 0.976, blue: 0.961, alpha: 1) })
    static let paper = Color(uiColor: .secondarySystemGroupedBackground)
    static let input = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(white: 0.16, alpha: 1) : UIColor(white: 0.925, alpha: 1) })
    static let startup = Color(red: 33 / 255, green: 31 / 255, blue: 27 / 255)
}

struct MollyInputStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration.padding(.horizontal, 18).padding(.vertical, 15)
            .frame(minHeight: 52).background(Palette.input, in: Capsule())
    }
}

/// One size and orientation for the library and TV page headers.
struct PageBrandMark: View {
    var body: some View {
        Image("BrandMark").resizable().scaledToFit()
            .frame(width: 40, height: 40)
            .rotationEffect(.degrees(-15))
            .accessibilityHidden(true)
    }
}

/// Identical geometry across all three roots, independent of scroll content.
struct RootPageHeader: View {
    let title: String
    let subtitle: String
    var editable = false
    @ScaledMetric(relativeTo: .title3) private var height = 60
    var body: some View {
        HStack(spacing: 16) {
            PageBrandMark().frame(width: 48, height: 48)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.system(.title3, design: .rounded, weight: .bold))
                    .lineLimit(1).truncationMode(.tail)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary).frame(width: 12)
                .opacity(editable ? 1 : 0).accessibilityHidden(true)
        }.frame(height: height).contentShape(Rectangle())
    }
}

struct RootPageHeaderLayout: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 24)
            .frame(maxWidth: 700).frame(maxWidth: .infinity)
            .background(Palette.canvas)
    }
}

struct BrandLockup: View {
    var body: some View {
        HStack(spacing: 9) {
            Image("BrandMark").resizable().scaledToFit().frame(width: 38, height: 38)
            Text("MollyTime").font(.system(.title2, design: .rounded, weight: .heavy))
        }.accessibilityElement(children: .ignore).accessibilityLabel("MollyTime")
    }
}
struct PrimaryButtonStyle: ButtonStyle {
    var background: Color = Palette.yellow
    var foreground: Color = Color.black.opacity(0.85)
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).foregroundStyle(foreground)
            .frame(maxWidth: .infinity).padding(.vertical, 16)
            .background(background.opacity(configuration.isPressed ? 0.7 : 1), in: Capsule())
            .opacity(enabled ? 1 : 0.45)
    }
}
/// Fast requests stay invisible. Overlay placement never moves page content.
struct DelayedLoadingIndicator: View {
    let active: Bool
    @State private var visible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ProgressView("正在加载…")
            .padding(16).background(Palette.paper, in: Capsule())
            .opacity(visible ? 1 : 0)
            .accessibilityHidden(!visible)
            .allowsHitTesting(false)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: visible)
            .task(id: active) {
                guard active else {
                    if visible {
                        do { try await Task.sleep(for: .milliseconds(250)) }
                        catch { return }
                    }
                    visible = false
                    return
                }
                do { try await Task.sleep(for: .milliseconds(400)) }
                catch { return }
                guard !Task.isCancelled else { return }
                visible = true
            }
    }
}

struct InlineFailure: View {
    let message: String
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.circle").font(.subheadline)
            if let retry { Button("重新加载", action: retry).font(.subheadline.bold()) }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.paper, in: RoundedRectangle(cornerRadius: 16))
            .accessibilityElement(children: .contain)
    }
}
/// Compact, intrinsic-height guidance; no screen-sized empty placeholder.
struct FirstStepsHeader: View {
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: icon).font(.system(size: 26, weight: .regular))
                .foregroundStyle(Palette.ink)
                .frame(width: 56, height: 56)
                .background(Palette.yellow.opacity(0.18), in: RoundedRectangle(cornerRadius: 18))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.system(.title3, design: .rounded, weight: .bold))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
                    .lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyLibrary: View {
    let title: String
    let detail: String
    var icon = "rectangle.stack"
    var body: some View {
        ContentUnavailableView(title, systemImage: icon, description: Text(detail))
            .frame(maxWidth: .infinity, minHeight: 240)
    }
}

/// All covers use the authenticated API transport; never send cookies to artwork hosts.
struct Artwork: View {
    let resource: Resource
    @Environment(SessionStore.self) private var store
    @State private var image: UIImage?
    @State private var loadedKey = ""
    private var cacheKey: String { "\(store.scope)|\(resource.imageUrl)" }
    var body: some View {
        ZStack {
            if let image = (loadedKey == cacheKey ? image : nil) ?? store.artwork.cached(for: cacheKey) {
                GeometryReader { geometry in
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                }
            } else {
                Palette.startup
                GeometryReader { geometry in
                    ZStack {
                        Circle().fill(.white.opacity(0.045)).frame(width: geometry.size.width * 0.8).offset(x: geometry.size.width * 0.35, y: -geometry.size.height * 0.3)
                        Circle().stroke(.white.opacity(0.12), lineWidth: 1).frame(width: geometry.size.width * 0.55).offset(x: -geometry.size.width * 0.3, y: geometry.size.height * 0.32)
                        Image(systemName: resource.isFolder ? "rectangle.stack" : "play.rectangle")
                            .font(.system(size: 56, weight: .ultraLight)).foregroundStyle(Palette.yellow)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }.frame(width: geometry.size.width, height: geometry.size.height)
                }
                VStack { Spacer(); HStack {
                    Image("BrandMark").resizable().scaledToFit().frame(width: 18, height: 18)
                    Text(resource.isFolder ? "我的收藏" : "我的视频").font(.caption2).foregroundStyle(.white.opacity(0.65))
                    Spacer()
                }}.padding(14)

            }
        }
        .clipped().accessibilityHidden(true)
        .task(id: cacheKey) {
            let key = cacheKey
            guard !resource.imageUrl.isEmpty else { return }
            do {
                let api = store.api
                let path = resource.imageUrl
                let loaded = try await store.artwork.value(for: key, cost: { image in
                    guard let cg = image.cgImage else { return 1 }
                    return cg.bytesPerRow * cg.height
                }) {
                    let data = try await api.raw(path)
                    guard let image = UIImage(data: data) else { throw APIError.invalidResponse }
                    return image
                }
                guard !Task.isCancelled, key == cacheKey else { return }
                image = loaded; loadedKey = key
            } catch { /* Keep branded fallback when a cover is absent. */ }
        }
    }
}

struct SectionHeading: View {
    let title: String
    var detail: String = ""
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.system(.title3, design: .rounded, weight: .bold))
            Spacer()
            if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

struct UploadStatusRow: View {
    let model: UploadModel
    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().stroke(Palette.yellow.opacity(0.12), lineWidth: 3)
                Circle().trim(from: 0, to: model.progress).stroke(Palette.yellow, style: StrokeStyle(lineWidth: 3, lineCap: .round)).rotationEffect(.degrees(-90))
                Image(systemName: model.completed ? "checkmark" : "arrow.up").font(.subheadline.bold())
            }.frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(model.selectedName.isEmpty ? "添加视频" : model.selectedName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(model.failure == nil ? model.phase : "需要处理 · 点此查看").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }.padding(16).background(Palette.paper, in: RoundedRectangle(cornerRadius: 20))
    }
}
