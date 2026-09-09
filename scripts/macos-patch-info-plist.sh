#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# macos-patch-info-plist.sh
#   `tauri build` が生成する .app の Info.plist には
#   NSCameraUsageDescription が含まれないため、getUserMedia() の
#   カメラ許可プロンプトが正しく出ない（=クラッシュ/拒否扱い）。
#   ここで生成後の .app に対してキーを注入し、変更で壊れる
#   署名を ad-hoc で再署名する（配布用の正式署名は別途必要）。
#
#   使い方: ./scripts/macos-patch-info-plist.sh <path/to/App.app>
# ──────────────────────────────────────────────────────────────
set -euo pipefail

APP_PATH="${1:?usage: macos-patch-info-plist.sh <path/to/App.app>}"
PLIST="$APP_PATH/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "Info.plist not found at $PLIST" >&2
  exit 1
fi

/usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string 'アバターの表情・体の動きをトラッキングするためにカメラを使用します。'" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :NSCameraUsageDescription 'アバターの表情・体の動きをトラッキングするためにカメラを使用します。'" "$PLIST"

/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string '本アプリは音声を使用しませんが、OSの許可ダイアログ仕様上このキーを保持しています。'" "$PLIST" 2>/dev/null \
  || true

echo "Patched: $PLIST"

# Info.plist を書き換えると既存の署名が無効になるため ad-hoc 再署名する。
# 正式配布時は Apple Developer 証明書での署名 + notarization に置き換えること。
codesign --force --deep --sign - "$APP_PATH"
echo "Re-signed (ad-hoc): $APP_PATH"
