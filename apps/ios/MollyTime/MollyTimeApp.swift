import SwiftUI
import MollyCore

@main
struct MollyTimeApp: App {
    @State private var store = SessionStore()
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
            .task { await store.restore() }
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .active {
                    startup.start(reduceMotion: reduceMotion)
                } else {
                    store.upload.pause()
                    store.reminderUpload.pause()
                    if phase == .background { startup.stop() }
                }
            }
        }
    }
}

struct ParentTabs: View {
    @Environment(SessionStore.self) private var store
    @State private var selectedTab = 0
    var body: some View {
        // Push detail screens outside the tab container so the system tab bar
        // belongs only to the three root pages, including during swipe-back.
        NavigationStack {
            TabView(selection: $selectedTab) {
                LibraryView()
                    .tabItem { Label("片库", systemImage: "rectangle.stack") }.tag(0)
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
                case .playback: PlaybackPreferencesView()
                case .reminder: RestReminderView()
                case .parentPIN: ParentPINView()
                case .viewingInfo: ViewingInfoView()
                case .disclaimer: DisclaimerView()
                }
            }
        }
    }
}
