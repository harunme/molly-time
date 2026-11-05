import SwiftUI
import MollyCore

struct InvitationRegistrationView: View {
    let server: String
    let returnToLogin: (String) -> Void
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var flow: InvitationRegistration?
    @State private var setupFailure: String?
    @State private var focus: LoginField?
    @State private var revealPassword = false
    @State private var confirmingSwitch = false
    @State private var switchApproved = false
    @FocusState private var codeFocused: Bool
    @ScaledMetric(relativeTo: .body) private var inputHeight: CGFloat = 28

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(spacing: 10) {
                        Image("BrandMark").resizable().scaledToFit().frame(width: 32, height: 32)
                            .rotationEffect(.degrees(-15)).accessibilityHidden(true)
                        Text("MollyTime").font(.system(.headline, design: .rounded, weight: .bold))
                    }
                    if let flow {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(flow.preview == nil ? "用一份邀请，开启好时光。" : "创建你的账号")
                                .font(.system(.title2, design: .rounded, weight: .bold))
                            Text(flow.preview == nil ? "输入收到的注册邀请码。" : flow.loginOnly ? "账号资料已提交，继续登录即可。" : "填写邮箱并设置密码，资料库会为你准备好。")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        if flow.preview == nil { invitationField(flow) }
                        else { accountFields(flow) }
                        if let failure = flow.failure { InlineFailure(message: failure) }
                        Button { act(flow) } label: {
                            HStack(spacing: 10) {
                                if flow.busy { ProgressView().tint(.black) }
                                Text(buttonTitle(flow))
                            }
                        }.buttonStyle(PrimaryButtonStyle())
                            .disabled(flow.busy || (flow.preview == nil ? RegistrationCode.normalize(flow.code) == nil : !flow.canSubmit))
                        if flow.existingEmail || flow.loginOnly {
                            Button("前往登录") { returnToLogin(flow.loginEmail); dismiss() }
                                .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44).disabled(flow.busy)
                        }
                        if flow.activationUncertain {
                            Button("重新检查邀请码") { Task { await flow.verify() } }
                                .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44).disabled(flow.busy)
                        } else if flow.preview != nil && !flow.loginOnly {
                            Button("更换邀请码") { flow.changeCode(); focus = nil }
                                .font(.footnote).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, minHeight: 44).disabled(flow.busy)
                        }
                        if URL(string: server)?.host != "mollytime.app" {
                            Text("当前服务：\(URL(string: server)?.host ?? server)")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if let setupFailure { InlineFailure(message: setupFailure) }
                }.padding(24).frame(maxWidth: 480).frame(maxWidth: .infinity)
            }.mollyPageBackground().scrollDismissesKeyboard(.interactively)
                .navigationTitle("使用邀请码").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { dismiss() }.disabled(flow?.busy == true)
                    }
                }
                .interactiveDismissDisabled(flow?.busy == true)
                .onAppear {
                    guard flow == nil else { return }
                    do { flow = InvitationRegistration(api: APIClient(endpoint: try Endpoint(server))) }
                    catch { setupFailure = error.localizedDescription }
                }
                .onDisappear { flow?.password = "" }
                .alert("创建并切换账号？", isPresented: $confirmingSwitch) {
                    Button("取消", role: .cancel) {}
                    Button("继续") { switchApproved = true; if let flow { act(flow) } }
                } message: { Text("新账号登录成功后，当前账号的上传会暂停，切回后可继续。已有资料库和电视绑定会保留。") }
        }
    }
    private func invitationField(_ flow: InvitationRegistration) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("注册邀请码").font(.subheadline.weight(.medium))
            TextField("XXXX-XXXX-XXXX", text: Binding(get: { flow.code }, set: { flow.code = $0 }))
                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                .keyboardType(.asciiCapable).textFieldStyle(MollyInputStyle())
                .focused($codeFocused).submitLabel(.continue).disabled(flow.busy)
                .onSubmit { act(flow) }
            Text("十二位字母和数字，支持直接粘贴；不是电视绑定码。")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
    private func accountFields(_ flow: InvitationRegistration) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            authField("邮箱", field: .username) {
                LoginTextInput(text: Binding(get: { flow.loginOnly ? flow.loginEmail : flow.email }, set: { flow.email = $0 }),
                               focus: $focus, field: .username, placeholder: "name@example.com",
                               onSubmit: { focus = .password }, keyboard: .emailAddress, contentType: .emailAddress)
                    .disabled(flow.preview?.email != nil || flow.loginOnly)
            }
            authField(flow.loginOnly ? "密码" : "设置密码", field: .password) {
                HStack(spacing: 8) {
                    LoginTextInput(text: Binding(get: { flow.password }, set: { flow.password = $0 }),
                                   focus: $focus, field: .password, placeholder: "至少 8 个字符",
                                   onSubmit: { act(flow) }, contentType: flow.loginOnly ? .password : .newPassword,
                                   revealPassword: revealPassword)
                    Button { revealPassword.toggle() } label: {
                        Image(systemName: revealPassword ? "eye.slash" : "eye").foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                    }.buttonStyle(.plain).accessibilityLabel(revealPassword ? "隐藏密码" : "显示密码")
                }
            }
            Text("邮箱和账号 ID 都可用于登录。请使用你常用的邮箱。")
                .font(.footnote).foregroundStyle(.secondary)
            if !flow.password.isEmpty, let error = SettingsValidation.passwordError(flow.password, confirmation: flow.password) {
                Text(error).font(.footnote).foregroundStyle(.secondary)
            }
        }.disabled(flow.busy)
    }
    private func authField<Content: View>(_ title: String, field: LoginField, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.subheadline.weight(.medium))
            content().frame(height: max(44, inputHeight)).padding(.horizontal, 16).padding(.vertical, 6)
                .background(Palette.input, in: Capsule())
                .overlay { Capsule().strokeBorder(focus == field ? Palette.yellow : .clear, lineWidth: 2).allowsHitTesting(false) }
        }.contentShape(Rectangle()).onTapGesture {
            if field == .username && (flow?.preview?.email != nil || flow?.loginOnly == true) { return }
            if flow?.busy != true { focus = field }
        }
    }
    private func buttonTitle(_ flow: InvitationRegistration) -> String {
        if flow.busy { return flow.preview == nil ? "正在验证…" : "正在处理…" }
        if flow.preview == nil { return "继续" }
        if flow.created != nil { return "重试登录" }
        if flow.activationUncertain { return "尝试登录" }
        return "创建账号并登录"
    }
    private func act(_ flow: InvitationRegistration) {
        guard !flow.busy else { return }
        codeFocused = false; focus = nil
        if flow.preview == nil { Task { await flow.verify() }; return }
        if store.session != nil && store.hasPendingUpload && !switchApproved {
            confirmingSwitch = true; return
        }
        Task {
            let loggedIn = await flow.submit { email, password in
                try await store.login(username: email, password: password, server: server)
            }
            if loggedIn { dismiss() }
        }
    }
}
