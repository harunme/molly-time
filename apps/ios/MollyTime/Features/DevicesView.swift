import SwiftUI
import MollyCore

struct DevicesView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var watch: WatchStatistics?
    @State private var statisticsFailure: String?
    @State private var devices: [Device] = []
    @State private var controls: [WatchControls.Control] = []
    @State private var pinSet = false
    @State private var loaded = false
    @State private var bindingRevision = 0
    @State private var statisticsGeneration = UUID()
    @State private var statisticsRevision = 0
    @State private var failure: String?
    @State private var pairing = false
    @State private var revoking: Device?
    @State private var editing: WatchControls.Control?
    @State private var busy = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !loaded && failure == nil { DevicesLoadingPlaceholder() }
                if loaded, let watch, watch.hasViewingHistory {
                    WatchStatisticsCard(watch: watch)
                } else if loaded && watch != nil && !devices.isEmpty {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: "clock").font(.title3).frame(width: 28)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("等待第一段观看时光").font(.subheadline.weight(.semibold))
                            Text("电视开始播放后，观看时长和记录会出现在这里。")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
                }
                if let statisticsFailure {
                    InlineFailure(message: "观看记录未更新：\(statisticsFailure)", retry: { statisticsRevision += 1 })
                }
                if store.canManage && !devices.isEmpty {
                    Button { pairing = true } label: {
                        HStack { Label("连接电视", systemImage: "qrcode.viewfinder"); Spacer(); Image(systemName: "plus") }
                            .padding(.horizontal, 18)
                    }.buttonStyle(PrimaryButtonStyle())
                }
                if store.canManage && !devices.isEmpty {
                    VStack(spacing: 0) {
                        NavigationLink(value: SettingsDestination.reminder) {
                            SettingsRow(title: "休息提醒视频", icon: "moon.zzz", detail: "用熟悉的声音，提醒孩子休息")
                        }
                        Divider().padding(.horizontal, 20)
                        NavigationLink(value: SettingsDestination.parentPIN) {
                            SettingsRow(title: "重设家长密码", icon: "lock", detail: "所有电视共用的四位数字密码")
                        }
                    }.buttonStyle(.plain).background(Palette.paper, in: RoundedRectangle(cornerRadius: 24))
                }
                if !devices.isEmpty { SectionHeading(title: "我的电视", detail: "\(devices.count) 台") }
                if let failure { InlineFailure(message: failure, retry: { Task { await reload() } }) }
                if loaded && devices.isEmpty {
                    VStack(alignment: .leading, spacing: 24) {
                        FirstStepsHeader(icon: "tv", title: "把好时光带到大屏幕",
                            detail: store.canManage ? "连上电视，就能播放你选好的内容，\n也能安排每天的观看时间。" : "请家长连接电视，一起在大屏幕上看。")
                        if store.canManage {
                            VStack(alignment: .leading, spacing: 16) {
                                connectionStep("1", title: "打开电视上的 MollyTime", detail: "找到屏幕上的二维码或绑定码")
                                connectionStep("2", title: "用手机完成连接", detail: "扫描二维码，也可以输入绑定码")
                            }
                            Button { pairing = true } label: {
                                Label("连接电视", systemImage: "qrcode.viewfinder")
                            }.buttonStyle(PrimaryButtonStyle())
                        }
                    }.padding(24).background(Palette.paper, in: RoundedRectangle(cornerRadius: 28))
                    if store.canManage {
                        Text("连接后，可以安排每台电视的观看时间，设置共用的休息提醒。")
                            .font(.caption).foregroundStyle(.secondary).lineSpacing(3)
                            .padding(.horizontal, 8)
                    }
                }
                ForEach(devices) { device in
                    let control = controls.first { $0.deviceId == device.id }
                    VStack(alignment: .leading, spacing: 16) {
                        HStack {
                            Image(systemName: "tv").font(.title3).foregroundStyle(Palette.ink)
                                .frame(width: 48, height: 48)
                                .background(Palette.input, in: RoundedRectangle(cornerRadius: 16))
                            VStack(alignment: .leading, spacing: 5) {
                                Text(device.name).font(.headline)
                                Text(control?.online == true ? "电视在线" : "电视离线")
                                    .font(.caption).foregroundStyle(control?.online == true ? Palette.ink : Color.secondary)
                            }
                            Spacer()
                            if store.canManage {
                                Button { revoking = device } label: {
                                    Image(systemName: "link.badge.plus").rotationEffect(.degrees(45))
                                        .frame(width: 44, height: 44)
                                }.foregroundStyle(Palette.ink.opacity(0.7)).accessibilityLabel("解绑\(device.name)")
                            }
                        }
                        if let control {
                            Divider()
                            HStack {
                                Label("每天的观看安排", systemImage: "hourglass")
                                Spacer()
                                Text(control.enabled ? "\(control.amount) \(control.mode == "minutes" ? "分钟" : "集")" : "未开启")
                            }.font(.subheadline)
                            if store.canManage {
                                Button { editing = control } label: {
                                    HStack { Text("调整观看安排"); Spacer(); Image(systemName: "arrow.right") }
                                }.font(.subheadline.weight(.semibold)).padding(14).background(Palette.canvas, in: Capsule())
                            }
                            if store.canManage && control.enabled && control.mode == "episodes" {
                                Button("看完当前这一集就休息") { Task { await finishCurrent(control) } }
                                    .font(.subheadline).disabled(busy)
                            }
                        }
                    }.padding(20).background(Palette.paper, in: RoundedRectangle(cornerRadius: 22))
                }

            }.padding(.horizontal, 20).padding(.bottom, 24).frame(maxWidth: 700)
        }.frame(maxWidth: .infinity).background(Palette.canvas).navigationTitle("")
            .safeAreaInset(edge: .top, spacing: 0) {
                RootPageHeader(title: "好时光，也有小约定。", subtitle: "一起看，也记得好好休息。")
                    .modifier(RootPageHeaderLayout())
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .task { if !loaded || bindingRevision != store.deviceBindingsRevision { await reload() } }
            .task(id: "\(scenePhase)-\(statisticsRevision)") {
                if scenePhase == .active { await reloadStatistics() }
            }
            .refreshable {
                statisticsRevision += 1
                await reload()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await reload() } }
            }
            .sheet(isPresented: $pairing) {
                PairingView { Task { await reload() } }
            }
            .sheet(item: $editing, onDismiss: { Task { await reload() } }) { WatchSettingsView(control: $0, hasPin: pinSet || store.parentPINConfigured) }
            .alert("解绑电视？", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), presenting: revoking) { device in
                Button("取消", role: .cancel) {}
                Button("解绑", role: .destructive) { Task { await revoke(device) } }
            } message: { device in
                Text("解绑「\(device.name)」后，这台电视将无法继续访问你的内容。需要时可以重新绑定。")
            }
    }
    private func connectionStep(_ number: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number).font(.caption.weight(.semibold)).frame(width: 26, height: 26)
                .background(Palette.input, in: Circle()).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func reload() async {
        failure = nil
        do {
            // Use pagination so large accounts do not silently stop at 100 devices.
            var all: [Device] = []; var number = 1
            while true {
                let result: Page<Device> = try await store.api.request("/api/manage/devices", query: [URLQueryItem(name: "page", value: "\(number)"), URLQueryItem(name: "activeOnly", value: "true")])
                all += result.items
                if !result.hasNext { break }; number += 1
            }
            let result: WatchControls = try await store.api.request("/api/manage/watch-control")
            devices = all; controls = result.devices; pinSet = result.pinSet; loaded = true
            bindingRevision = store.deviceBindingsRevision
        } catch { failure = error.localizedDescription }
    }
    private func reloadStatistics() async {
        let requestID = UUID()
        let account = store.sessionGeneration
        statisticsGeneration = requestID
        while !Task.isCancelled && statisticsGeneration == requestID && account == store.sessionGeneration {
            do {
                let result: WatchOverview = try await store.api.request("/api/manage/overview")
                guard !Task.isCancelled, statisticsGeneration == requestID,
                      account == store.sessionGeneration else { return }
                watch = result.watch; statisticsFailure = nil
                if result.watch.summaryUpdating != true { return }
            } catch {
                guard !Task.isCancelled, statisticsGeneration == requestID,
                      account == store.sessionGeneration else { return }
                // Historical backfills are prepared in the background. Keep the
                // last successful values and retry without blocking device loading.
                guard case APIError.http(503, _) = error else {
                    statisticsFailure = error.localizedDescription
                    return
                }
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }
    private func revoke(_ device: Device) async {
        do { try await store.api.command("/api/manage/devices/\(device.id)/revoke"); await reload() }
        catch { failure = error.localizedDescription }
    }
    private func finishCurrent(_ control: WatchControls.Control) async {
        busy = true; defer { busy = false }
        do {
            let body = WatchCommand(requestId: UUID().uuidString, version: control.version, action: "finish-current")
            let _: WatchResult = try await store.api.send("/api/manage/watch-control/\(control.id)/commands", body: body)
            await reload()
        } catch { let message = error.localizedDescription; await reload(); failure = message }
    }
}

struct WatchCommand: Encodable {
    let requestId: String
    let version: Int
    let action: String
    var enabled: Bool? = nil
    var mode: String? = nil
    var amount: Int? = nil
}
struct WatchResult: Decodable {} // Version is refetched after each command.

struct WatchSettingsView: View {
    let control: WatchControls.Control
    let hasPin: Bool
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var enabled = false
    @State private var mode = "minutes"
    @State private var amount = 20
    @State private var amountText = "20"
    @State private var rememberedAmounts = ["minutes": 20, "episodes": 2]
    @State private var initialized = false
    @FocusState private var editingAmount: Bool
    private var limit: Int { mode == "episodes" ? 99 : 600 }
    private var adjustmentStep: Int { mode == "episodes" ? 1 : 5 }
    private var unit: String { mode == "episodes" ? "集" : "分钟" }
    private var validAmount: Int? {
        guard !amountText.isEmpty, amountText.utf8.allSatisfy({ (48...57).contains($0) }),
              let value = Int(amountText), (1...limit).contains(value) else { return nil }
        return value
    }
    private var presets: [Int] { mode == "episodes" ? [1, 2, 3, 4, 5, 6] : [10, 15, 20, 30, 45, 60] }
    @State private var failure: String?
    @State private var busy = false
    @State private var version = 0
    @State private var pin = ""
    @State private var pinConfigured = false
    var body: some View {
        NavigationStack {
            Form {
                Section(control.name) {
                    Toggle("每天安排观看额度", isOn: $enabled)
                        .tint(Palette.yellow)
                    if enabled {
                        Picker("按什么安排", selection: Binding(get: { mode }, set: { switchMode(to: $0) })) { Text("分钟").tag("minutes"); Text("集数").tag("episodes") }
                    }
                }
                if enabled {
                    Section {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 10) {
                            ForEach(presets, id: \.self) { value in
                                Button { selectAmount(value); editingAmount = false } label: {
                                    Text("\(value) \(unit)").font(.subheadline.weight(.semibold))
                                        .frame(maxWidth: .infinity, minHeight: 44)
                                        .foregroundStyle(validAmount == value ? Color.black.opacity(0.85) : Palette.ink)
                                        .background(validAmount == value ? Palette.yellow : Palette.input, in: Capsule())
                                }.buttonStyle(.plain)
                                    .accessibilityAddTraits(validAmount == value ? .isSelected : [])
                            }
                        }.padding(.vertical, 6)
                        HStack(spacing: 10) {
                            Text("每天")
                            TextField("数量", text: $amountText)
                                .keyboardType(.numberPad).focused($editingAmount)
                                .multilineTextAlignment(.center).monospacedDigit()
                                .frame(width: 64, height: 44)
                                .background(Palette.input, in: Capsule())
                                .accessibilityLabel("每天观看\(unit)，可直接输入")
                            Text(unit).font(.subheadline)
                            Spacer(minLength: 0)
                            Stepper("每次调整\(adjustmentStep)\(unit)", onIncrement: {
                                selectAmount(min(limit, (validAmount ?? amount) + adjustmentStep))
                            }, onDecrement: {
                                selectAmount(max(1, (validAmount ?? amount) - adjustmentStep))
                            }).labelsHidden().fixedSize().disabled(validAmount == nil)
                        }
                        if validAmount == nil {
                            Text("请输入 1～\(limit) 的整数").font(.footnote).foregroundStyle(.red)
                        }
                    } header: {
                        Text("选择每天的观看额度")
                    } footer: {
                        Text("加减每次调整 \(adjustmentStep) \(unit)，也可以点击数字直接输入。")
                    }
                }
                if enabled && !pinConfigured {
                    Section("先设置家长密码") {
                        SecureField("四位数字", text: $pin).textFieldStyle(MollyInputStyle()).keyboardType(.numberPad)
                        Text("在电视上临时调整观看安排时使用，请不要告诉孩子。").font(.footnote)
                    }
                }
                Section { Text("首次开启后今天即可观看；后续额度调整从明天起生效。每日北京时间 0 点恢复额度。") }
                if let failure { Section { Text(failure).foregroundStyle(.red) } }
            }.disabled(busy).navigationTitle("观看安排").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(busy || (enabled && validAmount == nil) || (enabled && !pinConfigured && PairingCode.normalize(pin, endpoint: store.api.endpoint) == nil)) }
                    ToolbarItemGroup(placement: .keyboard) {
                        if editingAmount { Spacer(); Button("完成") { editingAmount = false } }
                    }
                }.interactiveDismissDisabled(busy)
        }.onAppear {
            guard !initialized else { return }
            enabled = control.enabled; mode = control.mode; selectAmount(control.amount)
            rememberedAmounts[control.mode] = control.amount
            version = control.version; pinConfigured = hasPin; initialized = true
        }
    }
    private func switchMode(to value: String) {
        guard value != mode else { return }
        if let previous = validAmount { rememberedAmounts[mode] = previous }
        mode = value
        selectAmount(rememberedAmounts[value] ?? (value == "episodes" ? 2 : 20))
        editingAmount = false
    }
    private func selectAmount(_ value: Int) {
        amount = value; amountText = String(value)
    }
    private func save() async {
        if enabled {
            guard let value = validAmount else { return }
            amount = value
        }
        editingAmount = false
        busy = true; failure = nil; defer { busy = false }
        do {
            if enabled && !pinConfigured {
                guard pin.count == 4, pin.utf8.allSatisfy({ (48...57).contains($0) }) else { throw APIError.http(422, "请输入四位数字家长密码。") }
                let _: OK = try await store.api.send("/api/manage/watch-control/pin", method: "PUT", body: ["pin": pin])
                pinConfigured = true; pin = ""
            }
            let body = WatchCommand(requestId: UUID().uuidString, version: version, action: "settings", enabled: enabled, mode: mode, amount: amount)
            let _: WatchResult = try await store.api.send("/api/manage/watch-control/\(control.id)/commands", body: body)
            dismiss()
        } catch {
            failure = error.localizedDescription
            // Never silently overwrite another parent's newer settings.
            if case APIError.http(409, let message) = error, message.contains("安排已更新") {
                if let latest: WatchControls = try? await store.api.request("/api/manage/watch-control"),
                   let updated = latest.devices.first(where: { $0.id == control.id }) {
                    version = updated.version; enabled = updated.enabled; mode = updated.mode; selectAmount(updated.amount); rememberedAmounts[updated.mode] = updated.amount
                    failure = "安排已被更新，已载入最新设置，请确认后再保存。"
                }
            }
        }
    }
}

struct PairingView: View {
    var onPaired: () -> Void = {}
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var selectedCode = ""
    @State private var pending: PairingPreview?
    @State private var name = ""
    @State private var failure: String?
    @State private var busy = false
    @State private var done = false
    @State private var scanning = false
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: done ? "checkmark.circle.fill" : "tv").font(.system(size: 48, weight: .light)).foregroundStyle(Palette.yellow).padding(.top, 20)
                Text(done ? "电视已经准备好了" : "让电视加入好时光").font(.system(.title, design: .rounded, weight: .bold))
                Text(done ? "请查看电视屏幕，它会自动进入你的内容库。" : "打开电视上的 MollyTime，输入四位配对码，或扫描屏幕上的二维码。")
                    .foregroundStyle(.secondary)
                if done {
                    Button("完成") { dismiss() }.buttonStyle(PrimaryButtonStyle())
                } else if let pending {
                    Label(pending.name, systemImage: "tv").font(.headline)
                    if pending.returningDevice == true {
                        Text("这是之前连接过的电视。重新连接后，将保留观看记录和观看安排。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    TextField("给电视起个名字", text: $name).textFieldStyle(MollyInputStyle())
                    Text("请确认这是你正在操作的电视。绑定码：\(selectedCode)").font(.footnote).foregroundStyle(.secondary)
                    Button("确认绑定") { Task { await confirm() } }.buttonStyle(PrimaryButtonStyle()).disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("重新输入") { self.pending = nil }.disabled(busy)
                } else {
                    TextField("0000", text: $code).keyboardType(.numberPad).font(.system(size: 40, weight: .medium, design: .monospaced))
                        .tracking(10).padding(20).background(Palette.input, in: Capsule())
                        .accessibilityLabel("电视上的四位绑定码")
                    Button("查找电视") { Task { await lookup(code) } }.buttonStyle(PrimaryButtonStyle())
                        .disabled(busy || PairingCode.normalize(code, endpoint: store.api.endpoint) == nil)
                    Button { scanning = true } label: { Label("扫描电视二维码", systemImage: "qrcode.viewfinder") }.disabled(busy)
                }
                if busy { ProgressView() }
                if let failure { InlineFailure(message: failure) }
                Spacer()
            }.padding(24).background(Palette.canvas).navigationTitle("绑定电视").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(busy) } }
                .interactiveDismissDisabled(busy)
                .sheet(isPresented: $scanning) {
                    QRScannerView { value in scanning = false; Task { await lookup(value) } }
                }
        }
    }
    private func lookup(_ input: String) async {
        guard let normalized = PairingCode.normalize(input, endpoint: store.api.endpoint) else {
            failure = "这不是当前服务的电视绑定码，请检查电视上的服务地址。"; return
        }
        busy = true; failure = nil; defer { busy = false }
        do {
            let result: PairingPreview = try await store.api.request("/api/manage/pairing/\(normalized)")
            pending = result; name = result.name; selectedCode = normalized
        } catch { failure = error.localizedDescription }
    }
    private func confirm() async {
        busy = true; failure = nil; defer { busy = false }
        do { try await store.api.command("/api/manage/pairing/confirm", body: ["code": selectedCode, "name": name.trimmingCharacters(in: .whitespaces)]); done = true; onPaired() }
        catch { failure = error.localizedDescription }
    }
}
