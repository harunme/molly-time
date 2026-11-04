import SwiftUI
import PhotosUI
import ImageIO
import MollyCore

struct ProfileAvatar: View {
    let data: Data?
    var size: CGFloat = 96
    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Palette.startup.overlay {
                    Image("BrandMark").resizable().scaledToFit().padding(size * 0.23)
                }
            }
        }.frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.3))
            .accessibilityHidden(true)
    }
}

struct EditProfileView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var avatar: Data?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var loadingPhoto = false
    @State private var saving = false
    @State private var signingOut = false
    @State private var confirmingLogout = false
    @State private var logoutFailure: String?
    @State private var failure: String?
    @State private var initialized = false
    @State private var accountCopied = false
    @State private var originalName = ""
    @State private var originalAvatar: Data?
    @FocusState private var nameFocused: Bool
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasChanges: Bool { trimmedName != originalName || avatar != originalAvatar }
    private var busy: Bool { saving || signingOut || loadingPhoto }
    private var canSave: Bool { !busy && hasChanges && !trimmedName.isEmpty && trimmedName.count <= 64 }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 18) {
                            PhotosPicker(selection: $selectedPhoto, matching: .images) {
                                ProfileAvatar(data: avatar, size: 64)
                                    .overlay(alignment: .bottomTrailing) {
                                        Image(systemName: "camera.fill").font(.system(size: 10))
                                            .foregroundStyle(.black).frame(width: 24, height: 24)
                                            .background(Palette.yellow, in: Circle())
                                    }
                            }.disabled(busy).accessibilityLabel("更换头像")
                            VStack(alignment: .leading, spacing: 8) {
                                Text("名称").font(.caption).foregroundStyle(.secondary)
                                TextField("你希望显示的名字", text: $name)
                                    .textFieldStyle(MollyInputStyle()).focused($nameFocused)
                                    .submitLabel(.done).onSubmit { nameFocused = false }
                                    .disabled(busy).accessibilityLabel("显示名称")
                            }
                        }
                        if loadingPhoto { ProgressView("正在准备头像…").font(.footnote) }
                        if avatar != nil {
                            Button("恢复默认头像") { avatar = nil; selectedPhoto = nil }
                                .font(.footnote).frame(minHeight: 44).disabled(busy)
                        }
                    }.padding(.vertical, 8)
                    if let failure { InlineFailure(message: failure) }
                    VStack(spacing: 0) {
                        Button {
                            UIPasteboard.general.string = store.session?.user.accountId
                            accountCopied = true
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: "person.text.rectangle").frame(width: 24).accessibilityHidden(true)
                                Text("账号 ID").font(.subheadline.weight(.semibold))
                                Spacer(minLength: 8)
                                Text(store.session?.user.accountId ?? "")
                                    .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                                Image(systemName: accountCopied ? "checkmark" : "doc.on.doc")
                                    .font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                            }.padding(20).frame(minHeight: 64).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .accessibilityLabel("登录账号 ID，\(store.session?.user.accountId ?? "")")
                            .accessibilityHint(accountCopied ? "已复制" : "轻点复制")
                        Divider().padding(.leading, 58).padding(.trailing, 20)
                        NavigationLink { ChangePasswordView() } label: {
                            SettingsRow(title: "修改登录密码", icon: "lock")
                        }.buttonStyle(.plain).disabled(busy)
                        Divider().padding(.leading, 58).padding(.trailing, 20)
                        NavigationLink { AccountSwitcherView() } label: {
                            SettingsRow(title: "切换账号", icon: "arrow.left.arrow.right")
                        }.buttonStyle(.plain).disabled(busy)
                    }.background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
                    if let logoutFailure { InlineFailure(message: logoutFailure) }
                    Button(signingOut ? "正在退出…" : "退出登录", role: .destructive) {
                        nameFocused = false
                        confirmingLogout = true
                    }.font(.subheadline).frame(maxWidth: .infinity, minHeight: 44).disabled(busy)
                }.padding(24).frame(maxWidth: 600)
            }.frame(maxWidth: .infinity).background(Palette.canvas)
                .navigationTitle("个人信息").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { dismiss() }.disabled(saving || signingOut)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "保存中…" : "保存") { Task { await save() } }
                            .buttonStyle(.borderedProminent).tint(Palette.yellow)
                            .foregroundStyle(canSave ? Color.black.opacity(0.85) : Color.secondary)
                            .disabled(!canSave)
                    }
                }
                .interactiveDismissDisabled(saving || signingOut)
                .onAppear {
                    guard !initialized else { return }
                    initialized = true
                    name = store.session?.user.displayName ?? store.session?.user.name ?? ""
                    avatar = store.session?.user.avatarJPEGBase64.flatMap { Data(base64Encoded: $0) }
                    originalName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    originalAvatar = avatar
                }
                .task(id: selectedPhoto) { await loadPhoto() }
                .alert("退出登录？", isPresented: $confirmingLogout) {
                    Button("取消", role: .cancel) {}
                    Button("退出登录", role: .destructive) {
                        Task {
                            signingOut = true; logoutFailure = nil
                            defer { signingOut = false }
                            do { try await store.logout() }
                            catch { logoutFailure = error.localizedDescription }
                        }
                    }
                } message: {
                    Text((store.upload.selectedURL != nil && !store.upload.completed) || (store.reminderUpload.selectedURL != nil && !store.reminderUpload.completed)
                         ? "未完成的上传需重新添加。已上传的视频和电视绑定会保留。"
                         : "已上传的视频和电视绑定会保留，可随时重新登录。")
                }
        }
    }
    private func loadPhoto() async {
        guard let selectedPhoto else { return }
        loadingPhoto = true; failure = nil
        defer { loadingPhoto = false }
        do {
            guard let data = try await selectedPhoto.loadTransferable(type: Data.self),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 512
                  ] as CFDictionary) else { throw APIError.http(422, "无法读取这张照片，请选择其他图片。") }
            try Task.checkCancellation()
            let image = UIImage(cgImage: thumbnail)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
            let square = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format).image { context in
                UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
                let scale = max(256 / image.size.width, 256 / image.size.height)
                let width = image.size.width * scale, height = image.size.height * scale
                image.draw(in: CGRect(x: (256 - width) / 2, y: (256 - height) / 2, width: width, height: height))
            }
            guard let jpeg = square.jpegData(compressionQuality: 0.8) else { throw APIError.invalidResponse }
            avatar = jpeg
        } catch is CancellationError { }
        catch { failure = error.localizedDescription }
    }
    private func save() async {
        guard canSave else { return }
        saving = true; failure = nil; nameFocused = false
        defer { saving = false }
        do {
            try await store.updateProfile(name: trimmedName, avatar: avatar)
            dismiss()
        } catch APIError.http(404, _) {
            failure = "当前服务尚未支持个人资料编辑，请更新服务端后再保存。"
        } catch { failure = error.localizedDescription }
    }
}
