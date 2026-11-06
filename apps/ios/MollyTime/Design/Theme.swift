import SwiftUI
import MollyCore

// Molly's existing jasmine palette, paired with native Dynamic Type.
enum Palette {
    static let yellow = Color(red: 0.973, green: 0.871, blue: 0.494) // F8DE7E
    static let ink = Color.primary
    static let canvas = adaptive(light: 0xF4F2E9, dark: 0x211F1B)
    static let paper = adaptive(light: 0xFBFAF5, dark: 0x2D2A24)
    static let input = adaptive(light: 0xEAE7DB, dark: 0x38342D)
    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
    static let startup = Color(red: 33 / 255, green: 31 / 255, blue: 27 / 255)
}

/// Shared page, navigation and sheet surfaces. Extending only the background
/// through safe areas keeps controls clear of the status bar and home indicator.
private struct MollyPageBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Palette.canvas.ignoresSafeArea())
            .toolbarBackground(Palette.canvas, for: .navigationBar, .tabBar)
            .toolbarBackground(.visible, for: .navigationBar, .tabBar)
            .presentationBackground(Palette.canvas)
    }
}

extension View {
    func mollyPageBackground() -> some View { modifier(MollyPageBackground()) }
}

/// Native grouped controls use the same surfaces as custom cards.
struct MollyList<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        List { content.listRowBackground(Palette.paper) }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .mollyPageBackground()
    }
}

struct MollyForm<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        Form { content.listRowBackground(Palette.paper) }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .mollyPageBackground()
    }
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
    var avatarData: Data? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .title3) private var height = 60
    var body: some View {
        HStack(spacing: 16) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
                : AnyLayout(HStackLayout(spacing: 16))
            layout {
                Group {
                    if let avatarData, let avatar = UIImage(data: avatarData) {
                        Image(uiImage: avatar).resizable().scaledToFill()
                            .frame(width: 48, height: 48)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    } else {
                        PageBrandMark()
                    }
                }.frame(width: 48, height: 48).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(.title3, design: .rounded, weight: .bold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tertiary).frame(width: 12)
                .opacity(editable ? 1 : 0).accessibilityHidden(true)
        }.frame(minHeight: height).contentShape(Rectangle())
    }
}

struct RootPageHeaderLayout: ViewModifier {
    var bottomPadding: CGFloat = 0
    func body(content: Content) -> some View {
        content.padding(.top, 16).padding(.bottom, bottomPadding)
            .frame(maxWidth: .infinity)
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
            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity).padding(.vertical, 16)
            .background(background.opacity(configuration.isPressed ? 0.7 : 1), in: Capsule())
            .opacity(enabled ? 1 : 0.45)
    }
}
/// Reserve the content's own space, without a floating progress badge.
/// A single slow opacity cycle keeps the entire placeholder moving together.
struct QuietLoading: ViewModifier {
    let label: String
    var animating = true
    @State private var visible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !visible || !animating || reduceMotion || scenePhase != .active)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate * 2 * .pi / 2.8
            content.opacity(reduceMotion || !animating ? 1 : 0.86 + 0.14 * cos(phase))
        }
            .opacity(visible ? 1 : 0)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .allowsHitTesting(false)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: visible)
            .task {
                do { try await Task.sleep(for: .milliseconds(180)) }
                catch { return }
                guard !Task.isCancelled else { return }
                visible = true
            }
    }
}

struct LoadingShape: View {
    var radius: CGFloat = 8
    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Palette.ink.opacity(0.055))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(Palette.yellow.opacity(0.045))
            }
            .accessibilityHidden(true)
    }
}

enum LibraryGridLayout {
    static let coverAspectRatio: CGFloat = 16.0 / 9.0
    static let coverCornerRadius: CGFloat = 14
    static let sectionSpacing: CGFloat = 16
    static let rowSpacing: CGFloat = 20
    static let captionSpacing: CGFloat = 8
    // Share the two-column geometry with the loading placeholders so covers
    // keep their size and position when content arrives.
    static let columns = Array(repeating: GridItem(.flexible(minimum: 0), spacing: 20, alignment: .top), count: 2)
}

struct LibraryLoadingPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: LibraryGridLayout.sectionSpacing) {
            LoadingShape().frame(width: 72, height: 14)
            LazyVGrid(columns: LibraryGridLayout.columns, spacing: LibraryGridLayout.rowSpacing) {
                ForEach(0..<6, id: \.self) { _ in
                    VStack(spacing: LibraryGridLayout.captionSpacing) {
                        LoadingShape(radius: LibraryGridLayout.coverCornerRadius).aspectRatio(LibraryGridLayout.coverAspectRatio, contentMode: .fit)
                        LoadingShape().frame(width: 64, height: 12)
                    }
                }
            }
        }.modifier(QuietLoading(label: "正在载入资料库"))
    }
}

struct DevicesLoadingPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            LoadingShape().frame(width: 100, height: 16)
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                LoadingShape(radius: 10).frame(width: 88, height: 36)
                LoadingShape().frame(width: 48, height: 12)
            }
            LoadingShape(radius: 14).frame(height: 72)
            Divider().opacity(0.35)
            HStack(spacing: 14) {
                LoadingShape(radius: 14).frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 10) {
                    LoadingShape().frame(width: 112, height: 16)
                    LoadingShape().frame(width: 72, height: 12)
                }
                Spacer(minLength: 0)
            }
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
            .modifier(QuietLoading(label: "正在载入电视与观看记录"))
    }
}

struct InlineFailure: View {
    let message: String
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.circle").font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
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
    var compact = false
    @Environment(SessionStore.self) private var store
    @State private var image: UIImage?
    @State private var loadedKey = ""
    private var cacheKey: String { "\(store.scope)|\(resource.imageUrl)" }
    var body: some View {
        ZStack {
            if let image = store.artworkUploads.drafts[resource.id].flatMap({ UIImage(data: $0.data) })
                ?? (loadedKey == cacheKey ? image : nil) ?? store.artwork.cached(for: cacheKey) {
                GeometryReader { geometry in
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                }
            } else if compact {
                Palette.input
                Image(systemName: resource.isFolder ? "folder" : "play")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(.secondary)
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
        .onChange(of: store.artworkUploads.drafts[resource.id]?.savedURL) { _, _ in
            if loadedKey == cacheKey { store.artworkUploads.acknowledge(itemID: resource.id, imageURL: resource.imageUrl) }
        }
        .task(id: cacheKey) {
            let key = cacheKey
            guard !resource.imageUrl.isEmpty else { return }
            do {
                let api = store.api
                let path = resource.imageUrl
                let disk = store.artworkDisk
                let versioned = URLComponents(string: path)?.queryItems?.contains { $0.name == "v" && !($0.value ?? "").isEmpty } == true
                let loaded = try await store.artwork.value(for: key, cost: { image in
                    guard let cg = image.cgImage else { return 1 }
                    return cg.bytesPerRow * cg.height
                }) {
                    if versioned, let data = await disk.data(for: key), let image = UIImage(data: data) { return image }
                    let data = try await api.raw(path)
                    guard let image = UIImage(data: data) else { throw APIError.invalidResponse }
                    if versioned { Task { await disk.store(data, for: key) } }
                    return image
                }
                guard !Task.isCancelled, key == cacheKey else { return }
                image = loaded; loadedKey = key
                store.artworkUploads.acknowledge(itemID: resource.id, imageURL: resource.imageUrl)
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
                Text(model.selectedName.isEmpty ? "添加内容" : model.selectedName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(model.failure == nil ? model.phase : "需要处理 · 点此查看").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }.padding(16).background(Palette.paper, in: RoundedRectangle(cornerRadius: 20))
    }
}

struct PlaybackLoadingPlaceholder: View {
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<4, id: \.self) { _ in
                HStack {
                    LoadingShape().frame(width: 80, height: 18)
                    Spacer()
                    LoadingShape(radius: 12).frame(width: 24, height: 24)
                }.padding(.horizontal, 20).frame(height: 60)
            }
        }.background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
            .modifier(QuietLoading(label: "正在载入播放偏好"))
    }
}

struct TrashLoadingPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            LoadingShape().frame(width: 140, height: 20)
            LoadingShape().frame(width: 220, height: 14)
            LoadingShape().frame(width: 80, height: 32)
        }.padding(.vertical, 8).modifier(QuietLoading(label: "正在载入最近删除"))
    }
}
