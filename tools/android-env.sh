#!/usr/bin/env bash
# Source this file; keep machine-specific state outside versioned source.
MOLLY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="$MOLLY_ROOT/.local/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$MOLLY_ROOT/.local/android-user"
export ANDROID_AVD_HOME="$MOLLY_ROOT/.local/avd"
export GRADLE_USER_HOME="$MOLLY_ROOT/.local/gradle"
export JAVA_HOME="${MOLLY_JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:/opt/homebrew/bin:$PATH"
