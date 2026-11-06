# Android parent client: iOS is the functional specification

- Treat the current source in `apps/ios/MollyTime` and `apps/ios/Sources/MollyCore` as the canonical product behavior. Check the implementation, not just older README entries.
- Match the actual visible fields in the corresponding iOS component. In `LibraryView.swift: ResourceCard`, folders show only artwork and a centered name; only episodes have duration/status. Do not add a folder subtitle or an artwork badge.
- Do not independently add product features, search, persistent refresh buttons, manual pagination, extra confirmations or workflows absent from iOS. Native Material components may adapt presentation, not business behavior.
- Match startup animation/audio, first-load placeholders, lifecycle synchronization, pagination, permissions, mutation invalidation, account isolation and error recovery to iOS. Keep exact validation and scheduling in deterministic code.
- Preserve iOS pull-to-refresh and error-only reload actions where they exist; do not expose routine synchronization as user work.
- Record remaining functional differences in README.md and do not claim complete iOS parity until they are implemented and verified.
- Use `bash tools/build-android.sh` so startup audio is snapshotted and verified exactly like the iOS build. Do not silently package missing or stale audio.

- The user explicitly authorized native Android APK self-updates and CI publication. Preserve this Android-specific exception to iOS UI parity: separate parent channels, fixed signing identity, increasing version codes, verified downloads and Android installation consent. Do not substitute TV web hot updates.
