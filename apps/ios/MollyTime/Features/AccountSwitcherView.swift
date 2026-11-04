import SwiftUI
import MollyCore

struct AccountSwitcherView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    @State private var reauthenticating: SavedAccount?
    @State private var pending: SavedAccount?
    @State private var removing: SavedAccount?
    @State private var confirmingSwitch = false
    @State private var selectedID: String?
    @State private var failure: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("换个账号，回到另一份好时光。")
                    .font(.subheadline).foregroundStyle(.secondary)
                VStack(spacing: 0) {
                    ForEach(store.accounts) { account in
                        let current = store.session != nil && store.activeAccountID == account.id
                        HStack(spacing: 0) {
                            Button { requestSwitch(account) } label: {
                                HStack(spacing: 14) {
                                    ProfileAvatar(data: account.session.user.avatarJPEGBase64.flatMap { Data(base64Encoded: $0) }, size: 48)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(account.name).font(.headline).foregroundStyle(Palette.ink)
                                        Text("账号 \(account.session.user.accountId)").font(.caption).foregroundStyle(.secondary)
                                        if URL(string: account.server)?.host != "mollytime.app" {
                                            Text(URL(string: account.server)?.host ?? account.server)
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        if account.needsLogin { Text("需重新登录").font(.caption).foregroundStyle(.secondary) }
                                    }.multilineTextAlignment(.leading)
                                    Spacer(minLength: 8)
                                    if selectedID == account.id && store.switchingAccount { ProgressView() }
                                    else if current {
                                        Text("当前使用").font(.caption.weight(.medium))
                                            .foregroundStyle(Color.black.opacity(0.85)).padding(.horizontal, 10).padding(.vertical, 6)
                                            .background(Palette.yellow, in: Capsule())
                                    }
                                }.padding(.vertical, 18).padding(.leading, 18)
                                    .padding(.trailing, current ? 18 : 0).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(current || store.switchingAccount)
                                .accessibilityHint(current ? "当前登录账号" : "切换到此账号")
                            if !current {
                                Button { removing = account } label: {
                                    Image(systemName: "xmark").font(.caption).foregroundStyle(.secondary)
                                        .frame(width: 44, height: 44)
                                }.buttonStyle(.plain).disabled(store.switchingAccount)
                                    .accessibilityLabel("移除\(account.name)的本机登录信息")
                            }
                        }
                        if account.id != store.accounts.last?.id { Divider().padding(.leading, 80).padding(.trailing, 18) }
                    }
                }.background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
                Button { adding = true } label: { Label("添加账号", systemImage: "plus") }
                    .buttonStyle(PrimaryButtonStyle()).disabled(store.switchingAccount)
                if let failure { InlineFailure(message: failure) }
                Text("仅在这台手机记住登录状态，不保存密码。登录过期后，需要重新验证。")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(24).frame(maxWidth: 600)
        }.frame(maxWidth: .infinity).background(Palette.canvas)
            .navigationTitle("切换账号").navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .interactiveDismissDisabled(store.switchingAccount)
            .sheet(isPresented: $adding) {
                NavigationStack { LoginView(isAccountSwitch: true) }
            }
            .sheet(item: $reauthenticating) { account in
                NavigationStack { LoginView(isAccountSwitch: true, savedAccount: account) }
            }
            .alert("切换账号？", isPresented: $confirmingSwitch) {
                Button("取消", role: .cancel) { pending = nil }
                Button("切换") { if let pending { performSwitch(pending) }; pending = nil }
            } message: { Text("未完成的上传会暂停，切回后可继续。已上传的视频和电视绑定会保留。") }
            .alert("移除本机登录信息？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { account in
                Button("取消", role: .cancel) {}
                Button("移除", role: .destructive) {
                    do { try store.forgetAccount(account) }
                    catch { failure = error.localizedDescription }
                }
            } message: { _ in Text("不会删除账号或云端内容。下次使用这个账号时，需要重新登录。") }
    }
    private func requestSwitch(_ account: SavedAccount) {
        guard !store.switchingAccount else { return }
        if account.needsLogin { reauthenticating = account }
        else if store.hasPendingUpload { pending = account; confirmingSwitch = true }
        else { performSwitch(account) }
    }
    private func performSwitch(_ account: SavedAccount) {
        selectedID = account.id; failure = nil
        Task {
            defer { selectedID = nil }
            do { try await store.switchAccount(account); dismiss() }
            catch APIError.unauthorized { reauthenticating = account }
            catch is CancellationError { }
            catch { failure = error.localizedDescription }
        }
    }
}
