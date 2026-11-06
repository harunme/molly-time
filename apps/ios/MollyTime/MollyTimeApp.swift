import SwiftUI
import MollyCore

@main
struct MollyTimeApp: App {
    @UIApplicationDelegateAdaptor(UploadAppDelegate.self) private var appDelegate
    private var store: SessionStore { appDelegate.store }
    @State private var startup = StartupExperience()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ZStack {
                // Mount the authenticated page during the launch experience so
                // its first request overlaps the animation instead of following it.
                if !store.restoring {
                    Group {
                        if store.session != nil {
                            ParentTabs().id(store.sessionGeneration)
                        } else {
                            LoginView()
                        }
                    }
                    .allowsHitTesting(startup.finished)
                    .accessibilityHidden(!startup.finished)
                }
                if store.restoring || !startup.finished {
                    StartupView(startedAt: startup.startedAt).zIndex(1)
                        .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: store.restoring || !startup.finished)
            .environment(store)
            .tint(Palette.ink)
            .buttonBorderShape(.capsule)
            .task { await store.restoreIfNeeded() }
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .active {
                    startup.start(reduceMotion: reduceMotion)
                    store.resumeUploads()
                } else {
                    if phase == .background { startup.stop() }
                }
            }
        }
    }
}

struct ParentTabs: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab = 0
    var body: some View {
        // Push detail screens outside the tab container so the system tab bar
        // belongs only to the three root pages, including during swipe-back.
        NavigationStack {
            TabView(selection: $selectedTab) {
                LibraryView()
                    .tabItem { Label("资料库", systemImage: "rectangle.stack") }.tag(0)
                DevicesView()
                    .tabItem { Label("电视", systemImage: "tv") }.tag(1)
                AccountView()
                    .tabItem { Label("我的", systemImage: "person.crop.circle") }.tag(2)
            }
            .navigationDestination(for: Resource.self) { resource in
                if resource.isFolder { LibraryView(folder: resource) }
                else { VideoDetailView(resource: resource) }
            }
            .navigationDestination(for: SettingsDestination.self) { destination in
                switch destination {
                case .playback: PlaybackPreferencesView(subtitle: store.storage.settings?.defaultSubtitle)
                case .reminder: RestReminderView()
                case .parentPIN: ParentPINView()
                case .viewingInfo: ViewingInfoView()
                case .disclaimer: DisclaimerView()
                case .recentlyDeleted: RecentlyDeletedView(snapshot: store.recentlyDeleted)
                }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                // Processing continues on the server after the upload sheet closes.
                // Observe only pending tasks, keeping catalog/storage updates silent.
                while !Task.isCancelled {
                    if store.upload.processing && !store.upload.busy { await store.upload.refreshCompletion(api: store.api) }
                    if store.reminderUpload.processing && !store.reminderUpload.busy { await store.reminderUpload.refreshCompletion(api: store.api) }
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                store.storage.invalidate()
                // Shared state stays current even while "My account" is offscreen.
                // Mutations refresh immediately; this bounded foreground poll
                // also picks up changes made by another family member/device.
                while !Task.isCancelled {
                    await store.refreshStorage()
                    do { try await Task.sleep(for: .seconds(60)) }
                    catch { return }
                }
            }
        }
        // Keep deletion monitoring alive while a detail screen covers the tabs.
        .task(id: "\(scenePhase)-\(store.trashDeletions.hasPending)") {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await store.refreshTrashDeletions()
                do { try await Task.sleep(for: .seconds(store.trashDeletions.hasPending ? 2 : 30)) }
                catch { return }
            }
        }
    }
}
