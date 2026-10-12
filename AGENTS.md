# Development workflow

- Daily TV UI development uses `bash tools/run-tv-web.sh` from the repository root and the browser at `http://127.0.0.1:5173/tv/`.
- Do not start Docker, Android emulators, or the Android client for routine development or validation unless the user explicitly requests them.
- Use frontend builds and browser tests for routine TV UI checks. Validate Android WebView, Bridge, and native playback before a release.
- The TV frontend lives in `apps/tv/web`, the Android client in `apps/tv/client`, the parent frontend in `apps/web`, and the API in `apps/server`.
- The TV dev script starts only Vite. Real login and media browsing require an available API; use `MOLLYTIME_API_PROXY` for an existing backend, or start the Python API separately when needed.
