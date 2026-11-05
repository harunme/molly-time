import SwiftUI
import MollyCore

struct LoginView: View {
    var isAccountSwitch = false
    var savedAccount: SavedAccount? = nil
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var username = ""
    @State private var password = ""
    @State private var server = "https://mollytime.app"
    @State private var connectionSettings = false
    @State private var busy = false
    @State private var failure: String?
    @State private var focus: LoginField?
    @State private var showingAccounts = false
    @State private var confirmingSwitch = false
    @State private var initialized = false
    @State private var registering = false
    @ScaledMetric(relativeTo: .body) private var inputHeight: CGFloat = 28
    private var focusColor: Color { Palette.yellow }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                VStack(alignment: .leading, spacing: 28) {
                    BrandLockup()
                    VStack(alignment: .leading, spacing: 8) {
                        Text(isAccountSwitch ? (savedAccount == nil ? "添加账号" : "重新登录") : "欢迎回来")
                            .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        Text(isAccountSwitch ? "登录成功后切换，当前账号会为你保留。" : "挑选喜欢的视频，带到电视上看。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 20) {
                    inputRow("邮箱或账号", field: .username) {
                        LoginTextInput(text: $username, focus: $focus, field: .username,
                                       placeholder: "输入邮箱或账号", onSubmit: { focus = .password })
                    }
                    inputRow("密码", field: .password) {
                        LoginTextInput(text: $password, focus: $focus, field: .password,
                                       placeholder: "输入密码", onSubmit: login)
                    }
                    if let text = failure ?? (isAccountSwitch ? nil : store.message) {
                        Label(text, systemImage: "exclamationmark.circle")
                            .font(.subheadline).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button(action: login) {
                        HStack(spacing: 10) {
                            if busy { ProgressView().tint(.black) }
                            Text(busy ? "正在登录…" : isAccountSwitch ? "登录并切换" : "登录")
                            if !busy { Image(systemName: "arrow.right") }
                        }.frame(minHeight: 24)
                    }.buttonStyle(PrimaryButtonStyle()).disabled(busy)
                        .accessibilityIdentifier("login.submit")
                        .padding(.top, 4)
                    Button("使用邀请码加入") { focus = nil; registering = true }
                        .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44).disabled(busy)
                    Button {
                        focus = nil
                        connectionSettings = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "network")
                            Text(isOfficialServer ? "MollyTime 官方服务" : "自定义服务")
                            Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                        }.font(.footnote).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(busy)
                        .accessibilityLabel("连接设置，\(isOfficialServer ? "MollyTime 官方服务" : "自定义服务")")
                    if !isAccountSwitch && !store.accounts.isEmpty {
                        Button("使用已保存的账号") { showingAccounts = true }
                            .font(.subheadline).frame(maxWidth: .infinity, minHeight: 44).disabled(busy)
                    }
                }
            }.padding(.horizontal, 28).padding(.top, 28).padding(.bottom, 24)
                .frame(maxWidth: 480).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .mollyPageBackground()
        // The fields keep the same identity, position and size across all focus
        // changes. Only their border changes; native keyboard avoidance handles
        // scrolling, without a second layout animation or delayed scrollTo.
        .onAppear {
            guard !initialized else { return }; initialized = true
            server = savedAccount?.server ?? store.serverAddress
            username = savedAccount?.session.user.accountId ?? ""
        }
        .onDisappear { password = "" }
        .interactiveDismissDisabled(busy)
        .toolbar {
            if isAccountSwitch {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) }
            }
        }
        .sheet(isPresented: $connectionSettings) { LoginConnectionSettings(address: $server) }
        .sheet(isPresented: $showingAccounts) { NavigationStack { AccountSwitcherView() } }
        .sheet(isPresented: $registering) {
            InvitationRegistrationView(server: server, returnToLogin: { email in
                username = email; password = ""; failure = nil; focus = .password
            })
        }
        .alert("登录并切换账号？", isPresented: $confirmingSwitch) {
            Button("取消", role: .cancel) {}
            Button("继续") { performLogin() }
        } message: { Text("登录成功后，未完成的上传会暂停，切回后可继续。已上传的视频和电视绑定会保留。") }
    }

    private var isOfficialServer: Bool {
        (try? Endpoint(server)) == (try? Endpoint("https://mollytime.app"))
    }

    private func inputRow<Content: View>(_ title: String, field: LoginField, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Button { focus = field } label: {
                Text(title).font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHidden(true)
            content()
                .font(.body).textFieldStyle(.plain)
                .tint(focusColor)
                .frame(height: inputHeight).padding(.horizontal, 16).padding(.vertical, 15)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.input, in: Capsule())
                .overlay {
                    Capsule().strokeBorder(focus == field ? Palette.yellow : .clear, lineWidth: 2)
                        .allowsHitTesting(false)
                }
                .accessibilityLabel(title)
        }
        .contentShape(Rectangle())
        // Include the label and padding without replacing the native text field's
        // tap/selection gestures. Tapping the active field must preserve its caret.
        .onTapGesture { if !busy && focus != field { focus = field } }
        .disabled(busy)
    }

    private func login() {
        guard !busy else { return }
        guard !username.trimmingCharacters(in: .whitespaces).isEmpty else { focus = .username; return }
        guard !password.isEmpty else { focus = .password; return }
        if isAccountSwitch && store.hasPendingUpload { focus = nil; confirmingSwitch = true; return }
        performLogin()
    }
    private func performLogin() {
        guard !busy else { return }
        busy = true; failure = nil; focus = nil
        // Capture this attempt before the asynchronous request begins.
        let account = username.trimmingCharacters(in: .whitespaces)
        let secret = password
        let address = server
        Task {
            defer { busy = false }
            do {
                try await store.login(username: account, password: secret, server: address)
                password = ""
                if isAccountSwitch { dismiss() }
            }
            catch { failure = error.localizedDescription }
        }
    }
}

private struct LoginConnectionSettings: View {
    @Binding var address: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            MollyForm {
                Section {
                    TextField("https://mollytime.app", text: $draft)
                        .textFieldStyle(MollyInputStyle()).keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.done).onSubmit(save)
                        .accessibilityLabel("HTTPS 服务地址")
                    Button("使用 MollyTime 官方服务") { draft = "https://mollytime.app"; failure = nil }
                } header: { Text("服务地址") } footer: {
                    Text("默认连接官方服务。如果你使用自部署的 MollyTime，可以填写自己的 HTTPS 地址。")
                }
                if let failure { Section { Text(failure).foregroundStyle(.red) } }
            }.navigationTitle("连接设置").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("保存", action: save) }
                }
        }.onAppear { draft = address }
    }
    private func save() {
        do { address = try Endpoint(draft).origin.absoluteString; dismiss() }
        catch { failure = error.localizedDescription }
    }
}

// A stable UIKit responder for each credential field avoids SwiftUI focus
// reconciliation briefly resigning the keyboard between TextField/SecureField.
enum LoginField { case username, password }

struct LoginTextInput: UIViewRepresentable {
    @Binding var text: String
    @Binding var focus: LoginField?
    let field: LoginField
    let placeholder: String
    let onSubmit: () -> Void
    var keyboard: UIKeyboardType = .default
    var contentType: UITextContentType? = nil
    var revealPassword = false
    @Environment(\.isEnabled) private var enabled

    func makeUIView(context: Context) -> UITextField {
        let input = UITextField()
        input.delegate = context.coordinator
        input.borderStyle = .none
        input.font = .preferredFont(forTextStyle: .body)
        input.adjustsFontForContentSizeCategory = true
        input.textColor = .label
        input.autocapitalizationType = .none
        input.autocorrectionType = .no
        input.spellCheckingType = .no
        input.smartQuotesType = .no
        input.smartDashesType = .no
        input.keyboardType = keyboard
        input.isSecureTextEntry = field == .password && !revealPassword
        input.textContentType = contentType ?? (field == .password ? .password : .username)
        input.returnKeyType = field == .password ? .go : .next
        input.accessibilityLabel = field == .password ? "密码" : "邮箱或账号"
        input.accessibilityIdentifier = field == .password ? "login.password" : "login.username"
        input.setContentHuggingPriority(.defaultLow, for: .horizontal)
        input.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        input.addTarget(context.coordinator, action: #selector(Coordinator.edited(_:)), for: .editingChanged)
        let keyboardBar = UIToolbar()
        keyboardBar.sizeToFit()
        keyboardBar.items = [UIBarButtonItem(systemItem: .flexibleSpace),
                            UIBarButtonItem(title: "完成", style: .done, target: context.coordinator, action: #selector(Coordinator.dismissKeyboard))]
        input.inputAccessoryView = keyboardBar
        return input
    }

    func updateUIView(_ input: UITextField, context: Context) {
        context.coordinator.parent = self
        let secure = field == .password && !revealPassword
        if input.isSecureTextEntry != secure {
            let selection = input.selectedTextRange
            input.isSecureTextEntry = secure
            if input.text != text { input.text = text }
            if let selection { input.selectedTextRange = selection }
        }
        // Do not replace marked text or reset the caret on unrelated state updates.
        if input.text != text && input.markedTextRange == nil { input.text = text }
        input.placeholder = placeholder
        input.isEnabled = enabled
        input.tintColor = .label
        if focus == field && !input.isFirstResponder && enabled {
            input.becomeFirstResponder()
        } else if focus == nil && input.isFirstResponder {
            input.resignFirstResponder()
        }
        // For a switch, let the incoming field becomeFirstResponder; never
        // resign the outgoing field first, which would hide/recreate the keyboard.
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: LoginTextInput
        init(_ parent: LoginTextInput) { self.parent = parent }
        @objc func edited(_ input: UITextField) { parent.text = input.text ?? "" }
        @objc func dismissKeyboard() { parent.focus = nil }
        func textFieldDidBeginEditing(_ textField: UITextField) {
            if parent.focus != parent.field { parent.focus = parent.field }
        }
        func textFieldDidEndEditing(_ textField: UITextField) {
            // The next field's didBeginEditing runs before this queued check.
            // Clear focus only after an actual dismissal, never during handoff.
            DispatchQueue.main.async { [weak self, weak textField] in
                guard let self, let textField, !textField.isFirstResponder,
                      self.parent.focus == self.parent.field else { return }
                self.parent.focus = nil
            }
        }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.onSubmit()
            return false
        }
    }
}
