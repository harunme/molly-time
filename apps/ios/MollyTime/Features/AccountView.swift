import SwiftUI
import MollyCore

struct AccountView: View {
    @Environment(SessionStore.self) private var store
    private var settings: FamilySettings? { store.storage.settings }
    @State private var editingProfile = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 22) {
                    HStack {
                        Label("片库空间", systemImage: "externaldrive.badge.icloud").font(.headline)
                        Spacer()
                    }
                    if let settings {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(DisplayFormat.bytes(settings.storage.usedBytes))
                                .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                            Text(settings.storage.limitBytes > 0 ? "已使用 · 共 \(DisplayFormat.bytes(settings.storage.limitBytes))" : "已使用 · 当前未设置容量上限")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        if settings.storage.limitBytes > 0 {
                            ProgressView(value: min(1, Double(settings.storage.usedBytes + settings.storage.reservedBytes) / Double(settings.storage.limitBytes))).tint(Palette.yellow)
                        }
                        if settings.storage.reservedBytes > 0 {
                            Text("正在上传的内容预留了 \(DisplayFormat.bytes(settings.storage.reservedBytes))。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if settings == nil {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("—").font(.system(.largeTitle, design: .rounded, weight: .semibold)).hidden()
                                .overlay(alignment: .leading) {
                                    LoadingShape(radius: 10).frame(width: 138).padding(.vertical, 5)
                                }
                            Text("片库空间").font(.subheadline).hidden()
                                .overlay(alignment: .leading) {
                                    LoadingShape(radius: 5).frame(width: 186).padding(.vertical, 4)
                                }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                            .modifier(QuietLoading(label: store.storage.loading ? "正在载入片库空间" : "片库空间暂未获取",
                                                   animating: store.storage.loading))
                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.paper, in: RoundedRectangle(cornerRadius: 26))
                VStack(spacing: 0) {
                    NavigationLink(value: SettingsDestination.playback) {
                        SettingsRow(title: "播放偏好", icon: "captions.bubble")
                    }
                    Divider().padding(.leading, 58).padding(.trailing, 20)
                    NavigationLink(value: SettingsDestination.viewingInfo) {
                        SettingsRow(title: "观看说明", icon: "info.circle")
                    }
                    Divider().padding(.leading, 58).padding(.trailing, 20)
                    NavigationLink(value: SettingsDestination.disclaimer) {
                        SettingsRow(title: "免责条款", icon: "doc.text")
                    }
                }.buttonStyle(.plain)
                    .background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))

            }.padding(.horizontal, 20).padding(.bottom, 24).frame(maxWidth: 700)
        }.frame(maxWidth: .infinity).background(Palette.canvas).navigationTitle("")
            .safeAreaInset(edge: .top, spacing: 0) {
                Button { editingProfile = true } label: {
                    RootPageHeader(title: store.session?.user.displayName ?? store.session?.user.name ?? "我的账号",
                                   subtitle: "把好时光，慢慢收藏。", editable: true)
                }.buttonStyle(.plain).accessibilityHint("编辑名称和头像")
                    .modifier(RootPageHeaderLayout())
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $editingProfile) { EditProfileView() }
    }
}
